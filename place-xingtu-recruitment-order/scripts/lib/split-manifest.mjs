import { containsForbiddenPrivateValue } from "./redaction.mjs";
import {
  normalizeRecruitmentTargetScope,
  normalizeShanghaiCreatedAtRange,
  parseRecruitmentBatchManifest,
  parseSubmissionManifest,
} from "./manifest.mjs";
import { loadRules, requireTrustedRules } from "./rules.mjs";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const referencePattern = /^[a-z][a-z0-9+.-]*:[^\s]+$/u;
const exactTypes = new Set(["DIRECTED", "SUBMISSION", "RECRUITMENT"]);

function fail(name, message) {
  throw new Error(`${name}: ${message}`);
}

function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(name, "must be an object");
}

function exactKeys(value, allowed, required, name) {
  plainObject(value, name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(name, `${key} is not allowed`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(name, `${key} is required`);
}

function trimmed(value, field, name) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    fail(name, `${field} must be a non-empty trimmed string`);
  }
}

function envelope(input, expectedType, allowed, required, name) {
  exactKeys(input, allowed, required, name);
  if (input.schemaVersion !== 3) fail(name, "schemaVersion must be 3");
  if (!exactTypes.has(input.orderType) || input.orderType !== expectedType) {
    fail(name, `orderType must be ${expectedType}`);
  }
  const runField = expectedType === "RECRUITMENT" ? "batchRunId" : "runId";
  trimmed(input[runField], runField, name);
  if (!idPattern.test(input[runField])) fail(name, `${runField} has an invalid format`);
  trimmed(input.rulesVersion, "rulesVersion", name);
  if (!/^\d{4}-\d{2}-\d{2}(?:-r[1-9]\d*)?$/u.test(input.rulesVersion)) {
    fail(name, "rulesVersion has an invalid format");
  }
  if (Object.hasOwn(input, "userNote")) {
    trimmed(input.userNote, "userNote", name);
    if (input.userNote.length > 500 || containsForbiddenPrivateValue(input.userNote)) {
      fail(name, "userNote must be short and redacted");
    }
  }
}

function uniqueOrderLocator(locator, name) {
  exactKeys(locator, ["kind", "value"], ["kind", "value"], `${name}.orderLocator`);
  if (locator.kind !== "ORDER_ID") fail(name, "orderLocator.kind must be ORDER_ID");
  trimmed(locator.value, "orderLocator.value", name);
  if (/[\r\n,;]/u.test(locator.value)) fail(name, "orderLocator must identify exactly one order");
}

function references(values, field, name) {
  if (!Array.isArray(values) || new Set(values).size !== values.length) fail(name, `${field} must be a unique array`);
  for (const value of values) {
    if (typeof value !== "string" || !referencePattern.test(value) || containsForbiddenPrivateValue(value)) {
      fail(name, `${field} must contain redacted opaque references`);
    }
  }
}

function trustedRules(input, suppliedRules) {
  const rules = suppliedRules === undefined ? loadRules(input.rulesVersion) : requireTrustedRules(suppliedRules);
  if (rules.rulesVersion !== input.rulesVersion) throw new Error("split manifest rulesVersion does not match loaded rules");
  return rules;
}

export function parseDirectedManifestV3(input, suppliedRules = undefined) {
  const name = "DirectedManifest";
  const fields = ["schemaVersion", "runId", "rulesVersion", "orderType", "orderLocator", "bfRefs", "assetRefs", "userNote"];
  envelope(input, "DIRECTED", fields, fields.filter((field) => field !== "userNote"), name);
  uniqueOrderLocator(input.orderLocator, name);
  references(input.bfRefs, "bfRefs", name);
  references(input.assetRefs, "assetRefs", name);
  const rules = trustedRules(input, suppliedRules);
  if (rules.schemaVersion !== 1 || !rules.executionV1?.browserExecutable?.includes("DIRECTED")) {
    fail(name, "DIRECTED is not executable under the bound rules");
  }
  return Object.freeze(structuredClone(input));
}

export function parseSubmissionManifestV3(input, suppliedRules = undefined) {
  const name = "SubmissionManifest";
  const fields = [
    "schemaVersion", "runId", "rulesVersion", "orderType", "orderLocator", "creatorUid",
    "submissionStartDate", "expectedPublishDate", "userNote",
  ];
  envelope(input, "SUBMISSION", fields, fields.filter((field) => field !== "userNote"), name);
  uniqueOrderLocator(input.orderLocator, name);
  const rules = trustedRules(input, suppliedRules);
  parseSubmissionManifest({ ...structuredClone(input), schemaVersion: 2 }, rules);
  return Object.freeze(structuredClone(input));
}

export function parseRecruitmentBatchManifestV3(input, suppliedRules = undefined) {
  const name = "RecruitmentBatchManifest";
  const fields = [
    "schemaVersion", "batchRunId", "rulesVersion", "orderType", "createdAtRange",
    "timeZone", "targetScope", "userNote",
  ];
  const required = fields.filter((field) => !new Set(["targetScope", "userNote"]).has(field));
  envelope(input, "RECRUITMENT", fields, required, name);
  const rules = trustedRules(input, suppliedRules);
  parseRecruitmentBatchManifest(structuredClone(input), rules);
  normalizeShanghaiCreatedAtRange(input.createdAtRange);
  normalizeRecruitmentTargetScope(input.targetScope);
  return Object.freeze(structuredClone(input));
}

export function parseRecruitmentBatchManifestV4(input, suppliedRules = undefined) {
  const rules = trustedRules(input, suppliedRules);
  const parsed = parseRecruitmentBatchManifest(structuredClone(input), rules);
  if (parsed.schemaVersion !== 4) fail("RecruitmentBatchManifest", "schemaVersion must be 4");
  return Object.freeze(parsed);
}

export function parseRecruitmentBatchManifestSplit(input, suppliedRules = undefined) {
  return input?.schemaVersion === 4
    ? parseRecruitmentBatchManifestV4(input, suppliedRules)
    : parseRecruitmentBatchManifestV3(input, suppliedRules);
}

export function parseSplitManifest(expectedType, input, rules = undefined) {
  if (expectedType === "DIRECTED") return parseDirectedManifestV3(input, rules);
  if (expectedType === "SUBMISSION") return parseSubmissionManifestV3(input, rules);
  if (expectedType === "RECRUITMENT") return parseRecruitmentBatchManifestSplit(input, rules);
  throw new Error("split manifest expected type is unsupported");
}
