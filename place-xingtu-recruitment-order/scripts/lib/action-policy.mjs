import { createHash } from "node:crypto";

import { deriveRecruitmentDeliveryDeadline } from "./recruitment-deadline.mjs";

const SAFE_ACTION_TYPES = Object.freeze([
  "NAVIGATE",
  "READ",
  "FILL",
  "SELECT",
  "UPLOAD",
]);
const STATEFUL_ACTION_TYPES = Object.freeze([
  "PUBLISH_RECRUITMENT_TASK",
  "TOP_UP_RECRUITMENT_BUDGET",
  "CONFIRM_INTERNAL_ORDER",
]);

export const EXECUTOR_ACTION_TYPES = Object.freeze([
  ...SAFE_ACTION_TYPES,
  ...STATEFUL_ACTION_TYPES,
]);

export const EXECUTOR_DESTINATIONS = Object.freeze([
  "INTERNAL_ORDER_LIST",
  "CURRENT_INTERNAL_ORDER",
  "XINGTU_TASK_LIST",
  "CURRENT_XINGTU_TASK",
  "DIRECTED_DRAFT_FORM",
]);

const allowedFields = {
  NAVIGATE: new Set(["type", "destination"]),
  READ: new Set(["type", "target"]),
  FILL: new Set(["type", "field", "value"]),
  SELECT: new Set(["type", "field", "option"]),
  UPLOAD: new Set(["type", "field", "assetRef"]),
};

const statefulAllowedFields = {
  PUBLISH_RECRUITMENT_TASK: new Set([
    "schemaVersion", "type", "orderType", "stage", "intentionEvidence",
  ]),
  TOP_UP_RECRUITMENT_BUDGET: new Set([
    "schemaVersion", "type", "orderType", "stage", "intentionEvidence",
  ]),
  CONFIRM_INTERNAL_ORDER: new Set([
    "schemaVersion", "type", "orderType", "stage", "freshWritebackVerified",
    "intentionEvidence",
  ]),
};

const intentionEvidenceFields = {
  PUBLISH_RECRUITMENT_TASK: [
    "runId", "orderId", "activityId", "creatorId", "orderFingerprint",
    "rulesVersion", "integritySha256",
  ],
  CONFIRM_INTERNAL_ORDER: [
    "runId", "orderId", "orderFingerprint", "rulesVersion", "verifiedTaskId",
    "writebackEvidenceHash", "integritySha256",
  ],
  TOP_UP_RECRUITMENT_BUDGET: [
    "runId", "orderId", "batchRunId", "activityId", "creatorId",
    "orderFingerprint", "rulesVersion", "beforeTotalBudgetMinorUnits",
    "stepMinorUnits", "operationInstant", "deliveryDeadline", "integritySha256",
  ],
};

const recruitmentDeadlineEvidenceFields = [
  ...intentionEvidenceFields.PUBLISH_RECRUITMENT_TASK.slice(0, -1),
  "operationInstant",
  "deliveryDeadline",
  "integritySha256",
];

const recruitmentRetryEvidenceFields = [
  ...recruitmentDeadlineEvidenceFields.slice(0, -1),
  "budgetTopUpEvidenceDigest",
  "integritySha256",
];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => key !== "integritySha256")
      .sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function integrity(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    const unknown = actual.find((key) => !expected.includes(key));
    throw new Error(`${label} ${unknown ?? "shape"} is not allowed`);
  }
}

function nonEmptyBinding(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function normalizedText(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll("發", "发")
    .replaceAll("佈", "布")
    .replaceAll("任務", "任务")
    .replaceAll("確認", "确认")
    .replaceAll("單", "单")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function containsProtectedAction(value, rules) {
  if (typeof value !== "string") return false;
  const normalized = normalizedText(value);
  return [
    ...(rules?.common?.protectedActions ?? []),
    "发布任务",
    "确认下单",
    "确认订单",
    "提交订单",
    "publishtask",
    "confirmorder",
  ].some((phrase) => normalized.includes(normalizedText(phrase)));
}

export function parseExecutorAction(input, rules) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("executor action must be an object");
  }
  if (!EXECUTOR_ACTION_TYPES.includes(input.type)) {
    throw new Error(`executor action ${String(input.type)} is not in the safe vocabulary`);
  }
  if (STATEFUL_ACTION_TYPES.includes(input.type)) {
    if (rules?.schemaVersion !== 2 || rules?.rulesVersion !== input.intentionEvidence?.rulesVersion) {
      throw new Error("stateful action requires matching v2 rules authority");
    }
    const authority = rules.actionPermissions?.[input.orderType?.toLocaleLowerCase("en-US")];
    if (input.type === "PUBLISH_RECRUITMENT_TASK") {
      if (
        input.orderType !== "RECRUITMENT" ||
        !new Set(["PUBLISH_INTENT", "PUBLISH_RETRY_READY"]).has(input.stage) ||
        authority?.publish !== "AGENT"
      ) throw new Error("PUBLISH_RECRUITMENT_TASK requires recruitment Agent authority at PUBLISH_INTENT");
    } else if (input.type === "TOP_UP_RECRUITMENT_BUDGET") {
      if (
        input.orderType !== "RECRUITMENT" ||
        input.stage !== "BUDGET_TOPUP_INTENT" ||
        authority?.publish !== "AGENT" ||
        rules.recruitment?.budgetTopUp?.stepMinorUnits !== 1_000_000
      ) throw new Error("TOP_UP_RECRUITMENT_BUDGET requires the issued recruitment budget policy");
    } else if (
      !new Set(["RECRUITMENT", "SUBMISSION"]).has(input.orderType) ||
      input.stage !== "CONFIRM_INTENT" ||
      authority?.internalConfirmation !== "AGENT"
    ) {
      throw new Error("CONFIRM_INTERNAL_ORDER requires typed Agent authority at CONFIRM_INTENT");
    }
    requireExactKeys(input, statefulAllowedFields[input.type], "stateful executor action");
    if (input.schemaVersion !== 1) throw new Error("stateful executor action schemaVersion is invalid");
    const requiresDeadlineEvidence = input.type === "PUBLISH_RECRUITMENT_TASK" &&
      new Set(["2026-08-13-r1", "2026-08-17-r1"]).has(rules.rulesVersion);
    const hasDeadlineEvidence = input.type === "PUBLISH_RECRUITMENT_TASK" &&
      Object.hasOwn(input.intentionEvidence, "operationInstant");
    if (requiresDeadlineEvidence && !hasDeadlineEvidence) {
      throw new Error("r1 recruitment publish requires operationInstant and deliveryDeadline evidence");
    }
    const expectedEvidenceFields = input.type === "PUBLISH_RECRUITMENT_TASK" && input.stage === "PUBLISH_RETRY_READY"
      ? recruitmentRetryEvidenceFields
      : hasDeadlineEvidence
        ? recruitmentDeadlineEvidenceFields
      : intentionEvidenceFields[input.type];
    requireExactKeys(input.intentionEvidence, expectedEvidenceFields, "stateful executor action intentionEvidence");
    for (const [key, value] of Object.entries(input.intentionEvidence)) {
      if (
        key !== "integritySha256" &&
        !new Set(["beforeTotalBudgetMinorUnits", "stepMinorUnits"]).has(key) &&
        !nonEmptyBinding(value)
      ) {
        throw new Error(`stateful executor action intentionEvidence ${key} is invalid`);
      }
    }
    if (
      !/^[a-f0-9]{64}$/u.test(input.intentionEvidence.orderFingerprint) ||
      (input.type === "CONFIRM_INTERNAL_ORDER" &&
        !/^[a-f0-9]{64}$/u.test(input.intentionEvidence.writebackEvidenceHash)) ||
      input.intentionEvidence.integritySha256 !== integrity(input.intentionEvidence)
    ) throw new Error("stateful executor action intentionEvidence integrity is invalid");
    if (input.type === "TOP_UP_RECRUITMENT_BUDGET") {
      let operationInstantValid = false;
      try {
        operationInstantValid = new Date(input.intentionEvidence.operationInstant).toISOString() ===
          input.intentionEvidence.operationInstant;
      } catch {
        operationInstantValid = false;
      }
      if (
        !Number.isSafeInteger(input.intentionEvidence.beforeTotalBudgetMinorUnits) ||
        input.intentionEvidence.beforeTotalBudgetMinorUnits < 0 ||
        input.intentionEvidence.stepMinorUnits !== rules.recruitment.budgetTopUp.stepMinorUnits ||
        !operationInstantValid ||
        deriveRecruitmentDeliveryDeadline({
          orderedAt: input.intentionEvidence.operationInstant,
          rules,
        }) !== input.intentionEvidence.deliveryDeadline
      ) throw new Error("recruitment budget top-up evidence is invalid");
    }
    if (
      input.type === "PUBLISH_RECRUITMENT_TASK" &&
      input.stage === "PUBLISH_RETRY_READY" &&
      !/^[a-f0-9]{64}$/u.test(input.intentionEvidence.budgetTopUpEvidenceDigest)
    ) throw new Error("recruitment retry requires verified budget top-up evidence");
    if (hasDeadlineEvidence) {
      let operationInstantValid = false;
      try {
        operationInstantValid = new Date(input.intentionEvidence.operationInstant).toISOString() ===
          input.intentionEvidence.operationInstant;
      } catch {
        operationInstantValid = false;
      }
      if (
        !operationInstantValid ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(input.intentionEvidence.deliveryDeadline) ||
        deriveRecruitmentDeliveryDeadline({
          orderedAt: input.intentionEvidence.operationInstant,
          rules,
        }) !== input.intentionEvidence.deliveryDeadline
      ) throw new Error("recruitment publish deadline evidence is invalid");
    }
    if (input.type === "CONFIRM_INTERNAL_ORDER" && input.freshWritebackVerified !== true) {
      throw new Error("CONFIRM_INTERNAL_ORDER requires fresh writeback verification");
    }
    return structuredClone(input);
  }
  if (rules?.schemaVersion !== 1 && rules?.schemaVersion !== 2) {
    throw new Error("executor action policy requires loaded rules");
  }
  for (const key of Object.keys(input)) {
    if (!allowedFields[input.type].has(key)) {
      throw new Error(`executor action field ${key} is not allowed`);
    }
  }
  if (input.type === "NAVIGATE" && !EXECUTOR_DESTINATIONS.includes(input.destination)) {
    throw new Error("executor navigation destination is not adapter-owned or is state-changing");
  }
  for (const value of Object.values(input)) {
    if (containsProtectedAction(value, rules)) {
      throw new Error("protected action cannot enter the executor action vocabulary");
    }
  }
  for (const field of allowedFields[input.type]) {
    if (field === "type") continue;
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new Error(`executor action ${field} must be non-empty`);
    }
  }
  return structuredClone(input);
}

export function createActionIntent(input, rules) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("stateful action intent must be an object");
  }
  const evidence = input.intentionEvidence;
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("stateful action intent intentionEvidence must be an object");
  }
  const withoutIntegrity = structuredClone(evidence);
  delete withoutIntegrity.integritySha256;
  const record = {
    ...structuredClone(input),
    schemaVersion: 1,
    intentionEvidence: {
      ...withoutIntegrity,
      integritySha256: integrity(withoutIntegrity),
    },
  };
  return parseExecutorAction(record, rules);
}
