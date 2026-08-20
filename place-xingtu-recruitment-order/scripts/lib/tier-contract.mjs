import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export const EXECUTION_TIERS = Object.freeze([
  "SCRIPTED_CHROME",
  "GPT_CHROME",
  "COMPUTER_USE",
  "HUMAN",
]);

export const EGO_EXECUTION_TIERS = Object.freeze([
  "EGO_SEMANTIC",
  "EGO_VISUAL",
  "HUMAN",
]);

export const TIER_REASON_CODES = Object.freeze([
  "SEMANTIC_LOCATOR_MISSING",
  "SEMANTIC_LOCATOR_AMBIGUOUS",
  "UI_STRUCTURE_DRIFT",
  "VISUAL_COMMIT_REQUIRED",
  "BROWSER_CONNECTION_UNAVAILABLE",
  "PLUGIN_REQUIRED",
  "BROWSER_CONTROL_INTERRUPTED",
  "LOGIN_REQUIRED",
  "CAPTCHA_REQUIRED",
  "SECURITY_VERIFICATION_REQUIRED",
  "ACCOUNT_MISMATCH",
  "ORDER_NOT_FOUND",
  "ORDER_BINDING_AMBIGUOUS",
  "ACTION_RESULT_UNKNOWN",
  "NON_OCCURRENCE_UNPROVEN",
  "TIER_BUDGET_EXHAUSTED",
  "ROLE_SWITCH_FAILED",
  "ROLE_STATE_UNREADABLE",
  "INPUT_CONTRACT_INVALID",
  "TASK_RESULT_PENDING",
  "CREATOR_NOT_ELIGIBLE_IN_ACTIVITY",
  "RUNTIME_VERSION_MISMATCH",
  "BUDGET_ERROR_UNRECOGNIZED",
  "BUDGET_TOPUP_LIMIT_REACHED",
  "BUDGET_TOPUP_RESULT_UNKNOWN",
  "PUBLISH_RESULT_UNKNOWN",
]);

export const RECRUITMENT_OPERATION_CODES = Object.freeze([
  "VERIFY_BATCH_FILTERS",
  "ENSURE_INTERNAL_BUSINESS_ROLE",
  "DISCOVER_CREATOR_CANDIDATES",
  "READ_MATCHING_ORDERS",
  "READ_ORDERS_BY_ID",
  "READ_HISTORICAL_ORDER_STATUS",
  "OPEN_FROZEN_ORDER",
  "READ_ORDER_SNAPSHOT",
  "OPEN_RECRUITMENT_ACTIVITY",
  "OPEN_CREATOR_ORDER",
  "PREPARE_RECRUITMENT_DRAFT",
  "COMMIT_RECRUITMENT_DEADLINE",
  "REREAD_RECRUITMENT_DRAFT",
  "SUBMIT_RECRUITMENT_ORDER",
  "READ_RECRUITMENT_SUBMIT_RESULT",
  "READ_RECRUITMENT_BUDGET",
  "TOP_UP_RECRUITMENT_BUDGET",
  "REREAD_RECRUITMENT_BUDGET",
  "REREAD_RECRUITMENT_TASK",
  "PREPARE_INTERNAL_WRITEBACK",
  "REREAD_INTERNAL_WRITEBACK",
  "CONFIRM_INTERNAL_ORDER",
  "REREAD_INTERNAL_FINAL_STATE",
]);

export const STATEFUL_RECRUITMENT_OPERATIONS = Object.freeze([
  "SUBMIT_RECRUITMENT_ORDER",
  "TOP_UP_RECRUITMENT_BUDGET",
  "CONFIRM_INTERNAL_ORDER",
]);

export const DISPATCH_STATES = Object.freeze([
  "NOT_DISPATCHED",
  "DISPATCHING",
  "OBSERVED",
]);

export const ESCALATION_DISPOSITIONS = Object.freeze([
  "PENDING",
  "REVALIDATE",
  "RESOLVED",
  "HUMAN_REQUIRED",
]);

export const TIER_ATTEMPT_OUTCOMES = Object.freeze([
  "COMPLETED",
  "ESCALATE",
  "BLOCKED",
  "HUMAN_REQUIRED",
]);

const recordKeys = Object.freeze([
  "schemaVersion",
  "escalationId",
  "runId",
  "orderId",
  "operation",
  "fromTier",
  "toTier",
  "reasonCode",
  "stage",
  "rulesVersion",
  "rulesDigest",
  "attemptOrdinal",
  "actionIntentDigest",
  "dispatchState",
  "disposition",
  "integritySha256",
]);

const attemptKeys = Object.freeze([
  "schemaVersion",
  "escalationId",
  "runId",
  "orderId",
  "operation",
  "tier",
  "stage",
  "rulesVersion",
  "rulesDigest",
  "attemptOrdinal",
  "actionIntentDigest",
  "outcome",
  "reasonCode",
  "dispatchState",
]);

const automatedTransitions = new Set([
  "SCRIPTED_CHROME>GPT_CHROME",
  "SCRIPTED_CHROME>COMPUTER_USE",
  "GPT_CHROME>COMPUTER_USE",
  "GPT_CHROME>SCRIPTED_CHROME",
  "COMPUTER_USE>SCRIPTED_CHROME",
  "SCRIPTED_CHROME>SCRIPTED_CHROME",
  "EGO_SEMANTIC>EGO_VISUAL",
  "EGO_VISUAL>EGO_SEMANTIC",
  "EGO_SEMANTIC>EGO_SEMANTIC",
  "EGO_VISUAL>EGO_VISUAL",
]);

function requirePlainDataObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) throw new Error(`${label} must be a plain data object`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, "value")) {
      throw new Error(`${label} must contain plain data properties`);
    }
  }
}

function requireExactKeys(value, keys, label) {
  requirePlainDataObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) throw new Error(`${label} shape contains an unknown or missing field`);
}

function requireIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)
  ) throw new Error(`${label} is invalid`);
}

function requireDigest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function integrityFor(value) {
  const canonical = Object.fromEntries(
    Object.keys(value)
      .filter((key) => key !== "integritySha256")
      .sort()
      .map((key) => [key, value[key]]),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function validateBindings(value, label) {
  requireIdentifier(value.escalationId, `${label} escalationId`);
  requireIdentifier(value.runId, `${label} runId`);
  requireIdentifier(value.orderId, `${label} orderId`);
  if (!RECRUITMENT_OPERATION_CODES.includes(value.operation)) {
    throw new Error(`${label} operation is not allowed`);
  }
  if (typeof value.stage !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(value.stage)) {
    throw new Error(`${label} stage is invalid`);
  }
  requireIdentifier(value.rulesVersion, `${label} rulesVersion`);
  requireDigest(value.rulesDigest, `${label} rulesDigest`);
  if (!Number.isSafeInteger(value.attemptOrdinal) || value.attemptOrdinal < 1 || value.attemptOrdinal > 3) {
    throw new Error(`${label} attemptOrdinal is invalid`);
  }
  requireDigest(value.actionIntentDigest, `${label} actionIntentDigest`, { nullable: true });
  const stateful = STATEFUL_RECRUITMENT_OPERATIONS.includes(value.operation);
  if (stateful !== (value.actionIntentDigest !== null)) {
    throw new Error(`${label} action intent binding is invalid`);
  }
  if (!DISPATCH_STATES.includes(value.dispatchState)) {
    throw new Error(`${label} dispatchState is invalid`);
  }
}

export function createEscalationRecord(value) {
  requireExactKeys(value, recordKeys.filter((key) => key !== "integritySha256"), "escalation record input");
  return validateEscalationRecord({
    ...value,
    integritySha256: integrityFor(value),
  });
}

export function validateEscalationRecord(value) {
  requireExactKeys(value, recordKeys, "escalation record");
  if (value.schemaVersion !== 1) throw new Error("escalation record schemaVersion is invalid");
  validateBindings(value, "escalation record");
  const allTiers = new Set([...EXECUTION_TIERS, ...EGO_EXECUTION_TIERS]);
  if (!allTiers.has(value.fromTier) || !allTiers.has(value.toTier)) {
    throw new Error("escalation record tier is invalid");
  }
  if (
    value.toTier !== "HUMAN" &&
    !automatedTransitions.has(`${value.fromTier}>${value.toTier}`)
  ) throw new Error("escalation record tier transition is invalid");
  if (!TIER_REASON_CODES.includes(value.reasonCode)) {
    throw new Error("escalation record reasonCode is invalid");
  }
  if (!ESCALATION_DISPOSITIONS.includes(value.disposition)) {
    throw new Error("escalation record disposition is invalid");
  }
  requireDigest(value.integritySha256, "escalation record integritySha256");
  if (value.integritySha256 !== integrityFor(value)) {
    throw new Error("escalation record integrity is invalid");
  }
  return Object.freeze(structuredClone(value));
}

export function validateTierAttempt(value) {
  requireExactKeys(value, attemptKeys, "tier attempt");
  if (value.schemaVersion !== 1) throw new Error("tier attempt schemaVersion is invalid");
  validateBindings(value, "tier attempt");
  if (![...EXECUTION_TIERS.slice(0, 3), ...EGO_EXECUTION_TIERS.slice(0, 2)].includes(value.tier)) {
    throw new Error("tier attempt tier is invalid");
  }
  if (!TIER_ATTEMPT_OUTCOMES.includes(value.outcome)) {
    throw new Error("tier attempt outcome is invalid");
  }
  if (value.outcome === "COMPLETED") {
    if (value.reasonCode !== null) throw new Error("completed tier attempt cannot carry a reasonCode");
  } else if (!TIER_REASON_CODES.includes(value.reasonCode)) {
    throw new Error("tier attempt reasonCode is invalid");
  }
  return Object.freeze(structuredClone(value));
}
