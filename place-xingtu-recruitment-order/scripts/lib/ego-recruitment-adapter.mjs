import { createHash, randomUUID } from "node:crypto";

import {
  EgoRecruitmentError,
  executeEgoRecruitmentOperation,
  shouldAttemptEgoVisual,
} from "./ego-recruitment-driver.mjs";
import {
  RECRUITMENT_OPERATION_CODES,
  STATEFUL_RECRUITMENT_OPERATIONS,
  TIER_REASON_CODES,
} from "./tier-contract.mjs";

const forbiddenEvidenceKeys = /(?:url|dom|html|selector|locator|cookie|token|profile|screenshot|coordinate|credential|password)/iu;

const operationStages = Object.freeze({
  ENSURE_INTERNAL_BUSINESS_ROLE: "BATCH_QUERY",
  VERIFY_BATCH_FILTERS: "BATCH_QUERY",
  DISCOVER_CREATOR_CANDIDATES: "BATCH_QUERY",
  READ_MATCHING_ORDERS: "BATCH_QUERY",
  READ_ORDERS_BY_ID: "BATCH_QUERY",
  READ_HISTORICAL_ORDER_STATUS: "BATCH_QUERY",
  READ_ORDER_SNAPSHOT: "ORDER_LOCKED",
  OPEN_CREATOR_ORDER: "ORDER_LOCKED",
  PREPARE_RECRUITMENT_DRAFT: "DRAFT_READY",
  COMMIT_RECRUITMENT_DEADLINE: "PUBLISH_INTENT",
  REREAD_RECRUITMENT_DRAFT: "PUBLISH_INTENT",
  SUBMIT_RECRUITMENT_ORDER: "PUBLISH_INTENT",
  READ_RECRUITMENT_SUBMIT_RESULT: "PUBLISH_INTENT",
  READ_RECRUITMENT_BUDGET: "BUDGET_TOPUP_INTENT",
  TOP_UP_RECRUITMENT_BUDGET: "BUDGET_TOPUP_INTENT",
  REREAD_RECRUITMENT_BUDGET: "BUDGET_TOPUP_OBSERVED",
  REREAD_RECRUITMENT_TASK: "TASK_VERIFIED",
  PREPARE_INTERNAL_WRITEBACK: "TASK_VERIFIED",
  REREAD_INTERNAL_WRITEBACK: "WRITEBACK_READY",
  CONFIRM_INTERNAL_ORDER: "CONFIRM_INTENT",
  REREAD_INTERNAL_FINAL_STATE: "FINAL_OBSERVED",
});

const humanReasons = new Set([
  "LOGIN_REQUIRED",
  "CAPTCHA_REQUIRED",
  "SECURITY_VERIFICATION_REQUIRED",
  "BROWSER_CONTROL_INTERRUPTED",
  "ACTION_RESULT_UNKNOWN",
  "NON_OCCURRENCE_UNPROVEN",
]);

function validateEvidence(value, label = "Ego evidence", depth = 0) {
  if (depth > 6) throw new Error(`${label} exceeds the evidence depth limit`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 1024) throw new Error(`${label} string is too long`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} number is invalid`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error(`${label} array is too large`);
    return value.map((entry) => validateEvidence(entry, label, depth + 1));
  }
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const keys = Object.keys(value);
  if (keys.length > 40 || keys.some((key) => forbiddenEvidenceKeys.test(key))) {
    throw new Error(`${label} contains a forbidden field`);
  }
  return Object.fromEntries(keys.map((key) => [key, validateEvidence(value[key], label, depth + 1)]));
}

function tabRole(operation) {
  return new Set([
    "ENSURE_INTERNAL_BUSINESS_ROLE", "VERIFY_BATCH_FILTERS", "DISCOVER_CREATOR_CANDIDATES",
    "READ_MATCHING_ORDERS", "READ_ORDERS_BY_ID", "READ_HISTORICAL_ORDER_STATUS",
    "READ_ORDER_SNAPSHOT", "PREPARE_INTERNAL_WRITEBACK", "REREAD_INTERNAL_WRITEBACK",
    "CONFIRM_INTERNAL_ORDER", "REREAD_INTERNAL_FINAL_STATE",
  ]).has(operation) ? "PLACEMENT" : "XINGTU";
}

export class EgoRecruitmentBoundary extends Error {
  constructor(result) {
    super(result.kind);
    this.name = "EgoRecruitmentBoundary";
    this.result = Object.freeze(structuredClone(result));
  }
}

export class EgoRecruitmentAdapter {
  constructor({ ego, rules, uiContract, origins, operationStore, contextProvider, clock, executeOperation = executeEgoRecruitmentOperation }) {
    if (
      ego === null || typeof ego !== "object" || rules === null || typeof rules !== "object" ||
      uiContract === null || typeof uiContract !== "object" ||
      typeof operationStore?.write !== "function" || typeof operationStore?.update !== "function" ||
      typeof contextProvider !== "function" || typeof clock !== "function" || typeof executeOperation !== "function"
    ) throw new Error("Ego recruitment adapter dependencies are invalid");
    this.ego = ego;
    this.rules = rules;
    this.uiContract = uiContract;
    this.origins = origins;
    this.operationStore = operationStore;
    this.contextProvider = contextProvider;
    this.clock = clock;
    this.executeOperation = executeOperation;
  }

  async readEvidence(operation, input, controls = {}) {
    if (!RECRUITMENT_OPERATION_CODES.includes(operation)) throw new Error("Ego recruitment operation is not allowed");
    const validatedInput = validateEvidence(input, "Ego evidence input");
    const context = this.contextProvider();
    const escalationId = `ego-op-${randomUUID()}`;
    const startedAt = this.clock();
    const base = {
      schemaVersion: 1,
      escalationId,
      batchRunId: context.batchRunId ?? "batch-unbound",
      runId: input.runId ?? context.runId ?? null,
      orderId: input.orderId ?? context.orderId ?? null,
      stage: context.stage ?? operationStages[operation] ?? operation,
      operation,
      tabRole: tabRole(operation),
      inputDigest: createHash("sha256").update(JSON.stringify(validatedInput)).digest("hex"),
      tier: "EGO_SEMANTIC",
      attemptCount: 1,
      externalWriteProduced: false,
      dispatchState: "NOT_DISPATCHED",
      status: "RUNNING",
      reasonCode: null,
      startedAt,
      finishedAt: null,
    };
    await this.operationStore.write(base);
    const command = { schemaVersion: 1, operation, tabRole: base.tabRole, input: validatedInput };
    let attemptCount = 1;
    try {
      let result;
      try {
        result = await this.executeOperation({
          ego: this.ego, command, rules: this.rules, uiContract: this.uiContract,
          origins: this.origins, controls,
        });
      } catch (error) {
        if (
          error instanceof EgoRecruitmentError && shouldAttemptEgoVisual(error.reasonCode) &&
          !STATEFUL_RECRUITMENT_OPERATIONS.includes(operation) && !error.dispatched
        ) {
          attemptCount = 2;
          await this.ego.captureScreenshot();
          result = await this.executeOperation({
            ego: this.ego, command, rules: this.rules, uiContract: this.uiContract,
            origins: this.origins, controls,
          });
          result = { ...result, tier: "EGO_VISUAL" };
        } else {
          throw error;
        }
      }
      const evidence = validateEvidence(result.evidence, "Ego evidence result");
      const dispatchState = evidence?.dispatchState ?? "NOT_DISPATCHED";
      await this.operationStore.update(escalationId, {
        tier: result.tier,
        attemptCount,
        status: "COMPLETED",
        finishedAt: this.clock(),
        dispatchState,
        externalWriteProduced: dispatchState === "OBSERVED",
      });
      return evidence;
    } catch (rawError) {
      const error = rawError instanceof EgoRecruitmentError
        ? rawError
        : new EgoRecruitmentError("UI_STRUCTURE_DRIFT", String(rawError?.message ?? rawError));
      const reasonCode = TIER_REASON_CODES.includes(error.reasonCode) ? error.reasonCode : "UI_STRUCTURE_DRIFT";
      const dispatchState = error.dispatched ? "DISPATCHING" : "NOT_DISPATCHED";
      const kind = humanReasons.has(reasonCode) ? "HUMAN_GATE_REQUIRED" : "BLOCKED";
      await this.operationStore.update(escalationId, {
        tier: attemptCount === 2 ? "EGO_VISUAL" : "EGO_SEMANTIC",
        attemptCount,
        status: kind,
        reasonCode,
        dispatchState,
        finishedAt: this.clock(),
      });
      throw new EgoRecruitmentBoundary({
        kind,
        escalationId,
        operation,
        tabRole: base.tabRole,
        reasonCode,
        dispatchState,
      });
    }
  }
}
