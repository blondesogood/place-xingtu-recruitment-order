import { createHash } from "node:crypto";

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalize(value[key])
  ).join(",") + "}";
}

export function canonicalFactDigest(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export const FACT_TTL_MS = Object.freeze({
  SUBMIT_BATCH: 2 * 60 * 1000,
  CONFIRM_WRITEBACK: 5 * 60 * 1000,
  OPEN_PAYMENT: 5 * 60 * 1000,
  CONFIRM_PAYMENT: 5 * 60 * 1000,
});

export const EVENT_KEYS = Object.freeze({
  RESUME_FACTS:["command","event","runId","orderTag","expectedRevision","creatorExternalId","internalAmountMinor","externalOrderId","evidenceDigest"],
  INTERNAL_SNAPSHOT: [
    "businessLabel", "command", "contentType", "creatorExternalId", "creatorInternalId",
    "event", "evidenceDigest", "existingExternalTaskId", "internalAmountMinor",
    "internalRole", "internalStatus", "orderTag", "platformLabel", "runId",
  ],
  CART_CLEANUP_FACTS:['command','event','runId','groupId','members','origin','tabDigest','evidenceDigest'],
  CART_MEMBER_ADDED: ["command", "event", "evidenceDigest", "orderTag", "runId"],
  CART_VERIFIED: [
    "advertiserAccountLabel", "advertiserCompanyLabel", "command", "contentType",
    "event", "evidenceDigest", "members", "internalChecks", "cooperationTitle", "negotiatedPrice", "orderTags", "origin", "publishDate",
    "reportingBrandLabel", "retentionDays", "runId", "spuLabels", "tabDigest", "templateLabel",
  ],
  CREATE_OUTCOME: ["candidates", "command", "event", "evidenceDigest", "orderTag", "runId"],
  WRITEBACK_FACTS: [
    "advertiserAccountLabel", "businessLabel", "command", "contentType", "event",
    "evidenceDigest", "externalTaskId", "internalRole", "internalStatus", "orderTag",
    "origin", "platformLabel", "runId", "tabDigest",
  ],
  WRITEBACK_OUTCOME: [
    "advertiserAccountLabel", "command", "event", "evidenceDigest", "internalStatus",
    "orderTag", "runId", "writtenExternalTaskId", "accountEvidence",
  ],
  CREATOR_STATUS: ["command", "event", "evidenceDigest", "orderTag", "runId", "status", "externalOrderId", "creatorExternalId", "advertiserCompanyLabel"],
  PAYMENT_FACTS: [
    "currentInternalTaskId", "currentCreatorInternalId", "currentCreatorExternalId",
    "advertiserCompanyLabel", "businessLabel", "command", "contentType",
    "cooperationAmountMinor", "currentInternalAmountMinor", "event", "evidenceDigest",
    "creatorExternalId", "externalOrderId", "externalStatus", "internalStatus", "orderTag", "origin", "runId",
    "serviceFeeMinor", "spuLabels", "tabDigest", "totalAmountMinor",
  ],
  OPEN_PAYMENT_OUTCOME: ['command','event','runId','orderTag','externalOrderId','creatorExternalId','dialogVisible','evidenceDigest'],
  PAYMENT_OUTCOME: [
    "currentInternalTaskId", "currentCreatorInternalId", "currentCreatorExternalId",
    "advertiserCompanyLabel", "businessLabel", "command", "contentType",
    "cooperationAmountMinor", "currentInternalAmountMinor", "event", "evidenceDigest",
    "creatorExternalId", "externalOrderId", "externalStatus", "internalStatus", "orderTag", "payButtonVisible",
    "runId", "serviceFeeMinor", "spuLabels", "totalAmountMinor",
  ],
  PAYMENT_INTERFACE_FACTS: [
    "dialogVisible", "currentInternalTaskId", "currentCreatorInternalId", "currentCreatorExternalId",
    "advertiserCompanyLabel", "businessLabel", "command", "contentType",
    "cooperationAmountMinor", "currentInternalAmountMinor", "event", "evidenceDigest",
    "creatorExternalId", "externalOrderId", "externalStatus", "internalStatus", "orderTag", "payButtonVisible",
    "runId", "serviceFeeMinor", "spuLabels", "totalAmountMinor",
  ],
  CLICK_RESULT: [
    "clickToken", "dispatchGeneration", "command", "event", "receiptId", "runId", "serverEvidenceDigest", "status",
  ],
  BROWSER_CONTEXT_LOST: ["command", "event", "evidenceDigest", "reason", "runId"],
  LEGACY_PAYMENT_STATUS: ["command", "event", "evidenceDigest", "orderTag", "status"],
  RECONCILE_EXTERNAL_PAID: [
    "currentInternalTaskId", "currentCreatorInternalId", "currentCreatorExternalId",
    "advertiserCompanyLabel", "businessLabel", "command", "contentType",
    "cooperationAmountMinor", "currentInternalAmountMinor", "event", "evidenceDigest",
    "creatorExternalId", "externalOrderId", "externalStatus", "internalStatus", "orderTag", "payButtonVisible",
    "runId", "serviceFeeMinor", "spuLabels", "totalAmountMinor",
  ],
  HISTORICAL_CREATE_GAP_WITNESS: [
    "command", "event", "evidenceDigest", "orderTag", "runId",
  ],
});

export const CREATE_CANDIDATE_KEYS = Object.freeze([
  "advertiserCompanyLabel", "candidateStatus", "contentType", "cooperationAmountMinor",
  "cooperationTitle", "creatorExternalId", "externalOrderId", "publishDate", "attribution", "price",
  "reportingBrandLabel", "templateLabel",
]);

export function exactKeys(value, keys) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
  );
}

export function factExpired(action, capturedAt, nowMs) {
  const ttl = FACT_TTL_MS[action];
  if (!ttl) return true;
  const captured = Date.parse(capturedAt);
  if (!Number.isFinite(captured)) return true;
  return nowMs < captured || nowMs - captured > ttl;
}
