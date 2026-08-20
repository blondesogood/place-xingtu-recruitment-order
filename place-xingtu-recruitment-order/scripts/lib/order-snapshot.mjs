import { createHash } from "node:crypto";

import { computeRulesDigest } from "../validate-business-rules.mjs";
import { loadRules, requireTrustedRules } from "./rules.mjs";

const snapshotInputKeys = [
  "orderId",
  "orderType",
  "projectType",
  "creatorId",
  "amount",
  "plannedDate",
  "orderStatus",
  "bfRefs",
  "assetRefs",
  "rulesVersion",
  "executorVersion",
  "businessDataDigest",
  "businessPlan",
];
const rulesVersionPattern = /^\d{4}-\d{2}-\d{2}(?:-r[1-9]\d*)?$/u;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function validate(input, rules) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("OrderSnapshot input must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!snapshotInputKeys.includes(key)) {
      throw new Error(`OrderSnapshot ${key} is not allowed`);
    }
  }
  for (const key of snapshotInputKeys.filter((key) => !new Set(["businessDataDigest", "businessPlan"]).has(key))) {
    if (!Object.hasOwn(input, key)) throw new Error(`OrderSnapshot ${key} is required`);
  }
  for (const key of [
    "orderId",
    "orderType",
    "projectType",
    "creatorId",
    "plannedDate",
    "orderStatus",
    "rulesVersion",
    "executorVersion",
  ]) {
    if (typeof input[key] !== "string" || input[key].length === 0) {
      throw new Error(`OrderSnapshot ${key} must be non-empty`);
    }
  }
  if (input.rulesVersion !== rules?.rulesVersion) {
    throw new Error("OrderSnapshot rulesVersion does not match loaded rules");
  }
  if (!rulesVersionPattern.test(input.rulesVersion)) {
    throw new Error("OrderSnapshot rulesVersion has an invalid format");
  }
  requireTrustedRules(rules);
  if (
    Object.hasOwn(input, "businessDataDigest") &&
    !/^[a-f0-9]{64}$/u.test(input.businessDataDigest ?? "")
  ) throw new Error("OrderSnapshot businessDataDigest must be a SHA-256 digest");
  if (Object.hasOwn(input, "businessPlan")) validateBusinessPlan(input.businessPlan, input.orderType);
  if (
    input.amount === null ||
    typeof input.amount !== "object" ||
    input.amount.currency !== "CNY" ||
    !Number.isSafeInteger(input.amount.minorUnits) ||
    input.amount.minorUnits < 0
  ) {
    throw new Error("OrderSnapshot amount must use CNY integer minorUnits");
  }
  for (const field of ["bfRefs", "assetRefs"]) {
    if (!Array.isArray(input[field]) || input[field].some((ref) => typeof ref !== "string")) {
      throw new Error(`OrderSnapshot ${field} must be an array of references`);
    }
  }
}

export function createOrderSnapshot(input, rules) {
  validate(input, rules);
  const rulesDigest = computeRulesDigest(rules);
  const stable = {
    orderId: input.orderId,
    orderType: input.orderType,
    projectType: input.projectType,
    creatorId: input.creatorId,
    amount: structuredClone(input.amount),
    plannedDate: input.plannedDate,
    orderStatus: input.orderStatus,
    advertiserId: rules.advertiser.fixedId,
    bfRefs: [...new Set(input.bfRefs)].sort(),
    assetRefs: [...new Set(input.assetRefs)].sort(),
    rulesVersion: input.rulesVersion,
    rulesDigest,
    executorVersion: input.executorVersion,
    ...(Object.hasOwn(input, "businessDataDigest") ? { businessDataDigest: input.businessDataDigest } : {}),
    ...(Object.hasOwn(input, "businessPlan") ? { businessPlan: structuredClone(input.businessPlan) } : {}),
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonicalize(stable)))
    .digest("hex");
  return { ...stable, fingerprint };
}

export function validateOrderSnapshotRecord(snapshot) {
  const required = [
    "orderId", "orderType", "projectType", "creatorId", "amount", "plannedDate",
    "orderStatus", "advertiserId", "bfRefs", "assetRefs", "rulesVersion", "rulesDigest", "executorVersion", "fingerprint",
  ];
  const allowed = [...required, "businessDataDigest", "businessPlan"];
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("OrderSnapshot record must be an object");
  }
  for (const key of Object.keys(snapshot)) {
    if (!allowed.includes(key)) throw new Error(`OrderSnapshot ${key} is not allowed`);
  }
  for (const key of required) {
    if (!Object.hasOwn(snapshot, key)) throw new Error(`OrderSnapshot ${key} is required`);
  }
  for (const key of [
    "orderId", "orderType", "projectType", "creatorId", "plannedDate", "orderStatus",
    "advertiserId", "rulesVersion", "rulesDigest", "executorVersion",
  ]) {
    if (typeof snapshot[key] !== "string" || snapshot[key].length === 0) {
      throw new Error(`OrderSnapshot ${key} is invalid`);
    }
  }
  if (!rulesVersionPattern.test(snapshot.rulesVersion)) {
    throw new Error("OrderSnapshot rulesVersion has an invalid format");
  }
  if (!/^[a-f0-9]{64}$/u.test(snapshot.rulesDigest)) {
    throw new Error("OrderSnapshot rulesDigest is invalid");
  }
  if (
    Object.hasOwn(snapshot, "businessDataDigest") &&
    !/^[a-f0-9]{64}$/u.test(snapshot.businessDataDigest ?? "")
  ) throw new Error("OrderSnapshot businessDataDigest is invalid");
  if (Object.hasOwn(snapshot, "businessPlan")) validateBusinessPlan(snapshot.businessPlan, snapshot.orderType);
  const canonicalRules = loadRules(snapshot.rulesVersion);
  const canonicalRulesDigest = computeRulesDigest(canonicalRules);
  if (snapshot.rulesDigest !== canonicalRulesDigest) {
    throw new Error("OrderSnapshot rulesDigest does not match canonical rules");
  }
  if (
    snapshot.amount === null ||
    typeof snapshot.amount !== "object" ||
    Object.keys(snapshot.amount).sort().join(",") !== "currency,minorUnits" ||
    snapshot.amount.currency !== "CNY" ||
    !Number.isSafeInteger(snapshot.amount.minorUnits) ||
    snapshot.amount.minorUnits < 0
  ) throw new Error("OrderSnapshot amount is invalid");
  for (const field of ["bfRefs", "assetRefs"]) {
    if (!Array.isArray(snapshot[field]) || snapshot[field].some((ref) => typeof ref !== "string")) {
      throw new Error(`OrderSnapshot ${field} is invalid`);
    }
  }
  const stable = { ...snapshot };
  delete stable.fingerprint;
  const expected = createHash("sha256")
    .update(JSON.stringify(canonicalize(stable)))
    .digest("hex");
  if (snapshot.fingerprint !== expected) throw new Error("OrderSnapshot fingerprint is invalid");
  return structuredClone(snapshot);
}

function validateBusinessPlan(plan, orderType) {
  if (
    orderType !== "SUBMISSION" || plan === null || typeof plan !== "object" || Array.isArray(plan) ||
    Object.keys(plan).sort().join(",") !== "deadline,sequence,taskName" ||
    typeof plan.taskName !== "string" || plan.taskName.length === 0 ||
    !Number.isSafeInteger(plan.sequence) || plan.sequence < 1 ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(plan.deadline)
  ) throw new Error("OrderSnapshot businessPlan is invalid");
}
