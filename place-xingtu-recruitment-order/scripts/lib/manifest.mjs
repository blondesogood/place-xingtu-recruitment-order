import { containsForbiddenPrivateValue } from "./redaction.mjs";
import { loadRules, requireTrustedRules } from "./rules.mjs";

const manifestKeys = new Set([
  "schemaVersion",
  "runId",
  "rulesVersion",
  "orderType",
  "orderLocator",
  "bfRefs",
  "assetRefs",
  "userNote",
]);
const allOrderTypes = new Set(["DIRECTED", "SUBMISSION", "RECRUITMENT"]);
const referencePattern = /^[a-z][a-z0-9+.-]*:[^\s]+$/u;
const v2RulesVersionPattern = /^\d{4}-\d{2}-\d{2}(?:-r[1-9]\d*)?$/u;
const v2RunIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;

function fail(message) {
  throw new Error(`TaskManifest: ${message}`);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    fail(`${field} must be a non-empty trimmed string`);
  }
}

function requireV2RunId(value, field, manifestName) {
  requireString(value, field);
  if (!v2RunIdPattern.test(value)) fail(`${manifestName}: ${field} has an invalid format`);
}

function requireV2RulesVersion(value, manifestName) {
  requireString(value, "rulesVersion");
  if (!v2RulesVersionPattern.test(value)) {
    fail(`${manifestName}: rulesVersion has an invalid format`);
  }
}

function parseStrictDate(value, field, manifestName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail(`${manifestName}: ${field} must use YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    utcDate.getUTCFullYear() !== year
    || utcDate.getUTCMonth() !== month - 1
    || utcDate.getUTCDate() !== day
  ) {
    fail(`${manifestName}: ${field} must be a real calendar date`);
  }
  return { year, month, day };
}

function parseV2OrderLocator(locator, manifestName) {
  if (locator === null || typeof locator !== "object" || Array.isArray(locator)) {
    fail(`${manifestName}: orderLocator must identify exactly one order`);
  }
  if (Object.keys(locator).some((key) => !["kind", "value"].includes(key))) {
    fail(`${manifestName}: orderLocator contains an unknown field`);
  }
  if (locator.kind !== "ORDER_ID") fail(`${manifestName}: orderLocator.kind must be ORDER_ID`);
  requireString(locator.value, "orderLocator.value");
  if (/\r|\n|[,;]/u.test(locator.value)) {
    fail(`${manifestName}: orderLocator must identify exactly one order`);
  }
}

function parseV2UserNote(input, manifestName) {
  if (!Object.hasOwn(input, "userNote")) return;
  requireString(input.userNote, "userNote");
  if (input.userNote.length > 500 || containsForbiddenPrivateValue(input.userNote)) {
    fail(`${manifestName}: userNote must be short and redacted`);
  }
}

function requireV2Rules(input, orderType, manifestName, suppliedRules) {
  const rules = suppliedRules === undefined
    ? loadRules(input.rulesVersion)
    : requireTrustedRules(suppliedRules);
  if (rules.rulesVersion !== input.rulesVersion) {
    fail(`${manifestName}: rulesVersion does not match loaded rules`);
  }
  if (rules.schemaVersion !== 2 || !rules.executionV2?.executableOrderTypes?.includes(orderType)) {
    fail(`${manifestName}: orderType is not executable under v2 rules`);
  }
  return rules;
}

function addOneCalendarDay({ year, month, day }) {
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function formatDate({ year, month, day }) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeShanghaiCreatedAtRange(createdAtRange) {
  const start = parseStrictDate(createdAtRange?.startDate, "createdAtRange.startDate", "RecruitmentBatchManifest");
  const end = parseStrictDate(createdAtRange?.endDate, "createdAtRange.endDate", "RecruitmentBatchManifest");
  if (Date.UTC(start.year, start.month - 1, start.day) > Date.UTC(end.year, end.month - 1, end.day)) {
    fail("RecruitmentBatchManifest: createdAtRange.startDate must not be after endDate");
  }
  return {
    start: `${formatDate(start)}T00:00:00+08:00`,
    endExclusive: `${formatDate(addOneCalendarDay(end))}T00:00:00+08:00`,
  };
}

export function normalizeRecruitmentTargetScope(targetScope = undefined) {
  if (targetScope === undefined) return Object.freeze({ creatorId: null, maxOrders: null });
  if (
    targetScope === null || typeof targetScope !== "object" || Array.isArray(targetScope) ||
    Object.keys(targetScope).sort().join(",") !== "creatorId,maxOrders"
  ) fail("RecruitmentBatchManifest: targetScope must contain creatorId and maxOrders only");
  if (
    targetScope.creatorId !== null && (
      typeof targetScope.creatorId !== "string" || targetScope.creatorId.length === 0 ||
      targetScope.creatorId !== targetScope.creatorId.trim() || /\r|\n|[,;]/u.test(targetScope.creatorId)
    )
  ) fail("RecruitmentBatchManifest: targetScope creatorId must identify one creator");
  if (
    targetScope.maxOrders !== null &&
    (!Number.isSafeInteger(targetScope.maxOrders) || targetScope.maxOrders < 1)
  ) {
    fail("RecruitmentBatchManifest: targetScope maxOrders must be null or a positive safe integer");
  }
  return Object.freeze(structuredClone(targetScope));
}

function normalizeRecruitmentOrderLocators(orderLocators) {
  if (!Array.isArray(orderLocators) || orderLocators.length === 0) {
    fail("RecruitmentBatchManifest: orderLocators must be a non-empty array");
  }
  const values = new Set();
  return Object.freeze(orderLocators.map((locator) => {
    parseV2OrderLocator(locator, "RecruitmentBatchManifest");
    if (values.has(locator.value)) {
      fail("RecruitmentBatchManifest: orderLocators must be unique");
    }
    values.add(locator.value);
    return Object.freeze(structuredClone(locator));
  }));
}

export function normalizeRecruitmentTargetScopeV4(targetScope) {
  if (
    targetScope === null || typeof targetScope !== "object" || Array.isArray(targetScope) ||
    Object.keys(targetScope).sort().join(",") !== "creatorId,creatorName,maxOrders"
  ) fail("RecruitmentBatchManifest: schema-4 targetScope must contain creatorId, creatorName and maxOrders only");
  const creatorId = targetScope.creatorId;
  const creatorName = targetScope.creatorName;
  if (creatorId !== null && (
    typeof creatorId !== "string" || creatorId.length === 0 || creatorId !== creatorId.trim() || /\r|\n|[,;]/u.test(creatorId)
  )) fail("RecruitmentBatchManifest: targetScope creatorId must identify one creator");
  if (creatorName !== null && (
    typeof creatorName !== "string" || creatorName.length === 0 || creatorName !== creatorName.trim() || /\r|\n/u.test(creatorName)
  )) fail("RecruitmentBatchManifest: targetScope creatorName must identify one creator name");
  if (creatorId !== null && creatorName !== null) {
    fail("RecruitmentBatchManifest: targetScope must not bind creatorId and creatorName together");
  }
  if (targetScope.maxOrders !== null && (!Number.isSafeInteger(targetScope.maxOrders) || targetScope.maxOrders < 1)) {
    fail("RecruitmentBatchManifest: targetScope maxOrders must be null or a positive safe integer");
  }
  return Object.freeze(structuredClone(targetScope));
}

export function parseSubmissionManifest(input, rules = undefined) {
  const manifestName = "SubmissionManifest";
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail(`${manifestName}: must be an object`);
  const allowed = new Set([
    "schemaVersion", "runId", "rulesVersion", "orderType", "orderLocator", "creatorUid",
    "submissionStartDate", "expectedPublishDate", "userNote",
  ]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${manifestName}: ${key} is not allowed`);
  for (const required of ["schemaVersion", "runId", "rulesVersion", "orderType", "orderLocator", "creatorUid", "submissionStartDate", "expectedPublishDate"]) {
    if (!Object.hasOwn(input, required)) fail(`${manifestName}: ${required} is required`);
  }
  if (input.schemaVersion !== 2) fail(`${manifestName}: unsupported schemaVersion`);
  if (input.orderType === "DIRECTED") fail(`${manifestName}: DIRECTED is not issuable`);
  if (input.orderType !== "SUBMISSION") fail(`${manifestName}: orderType must be SUBMISSION`);
  requireV2RunId(input.runId, "runId", manifestName);
  requireV2RulesVersion(input.rulesVersion, manifestName);
  parseV2OrderLocator(input.orderLocator, manifestName);
  requireString(input.creatorUid, "creatorUid");
  if (/\r|\n|[,;]/u.test(input.creatorUid)) fail(`${manifestName}: creatorUid must identify one creator`);
  parseStrictDate(input.submissionStartDate, "submissionStartDate", manifestName);
  parseStrictDate(input.expectedPublishDate, "expectedPublishDate", manifestName);
  parseV2UserNote(input, manifestName);
  requireV2Rules(input, "SUBMISSION", manifestName, rules);
  return structuredClone(input);
}

export function parseRecruitmentBatchManifest(input, rules = undefined) {
  const manifestName = "RecruitmentBatchManifest";
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail(`${manifestName}: must be an object`);
  const allowed = new Set([
    "schemaVersion", "batchRunId", "rulesVersion", "orderType", "createdAtRange", "orderLocators", "timeZone", "targetScope", "userNote",
  ]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`${manifestName}: ${key} is not allowed`);
  for (const required of ["schemaVersion", "batchRunId", "rulesVersion", "orderType", "timeZone"]) {
    if (!Object.hasOwn(input, required)) fail(`${manifestName}: ${required} is required`);
  }
  if (!new Set([2, 3, 4]).has(input.schemaVersion)) fail(`${manifestName}: unsupported schemaVersion`);
  if (input.orderType === "DIRECTED") fail(`${manifestName}: DIRECTED is not issuable`);
  if (input.orderType !== "RECRUITMENT") fail(`${manifestName}: orderType must be RECRUITMENT`);
  requireV2RunId(input.batchRunId, "batchRunId", manifestName);
  requireV2RulesVersion(input.rulesVersion, manifestName);
  const hasRange = Object.hasOwn(input, "createdAtRange");
  const hasLocators = Object.hasOwn(input, "orderLocators");
  if (input.schemaVersion < 4 && (!hasRange || hasLocators)) {
    fail(`${manifestName}: legacy manifests require createdAtRange only`);
  }
  if (input.schemaVersion === 4 && hasRange === hasLocators) {
    fail(`${manifestName}: schema-4 requires either orderLocators or createdAtRange exclusively`);
  }
  if (hasRange) {
    if (input.createdAtRange === null || typeof input.createdAtRange !== "object" || Array.isArray(input.createdAtRange)) {
      fail(`${manifestName}: createdAtRange must be an object`);
    }
    if (Object.keys(input.createdAtRange).some((key) => !["startDate", "endDate"].includes(key))) {
      fail(`${manifestName}: createdAtRange contains an unknown field`);
    }
    if (!Object.hasOwn(input.createdAtRange, "startDate") || !Object.hasOwn(input.createdAtRange, "endDate")) {
      fail(`${manifestName}: createdAtRange startDate and endDate are required`);
    }
    normalizeShanghaiCreatedAtRange(input.createdAtRange);
  }
  if (hasLocators) normalizeRecruitmentOrderLocators(input.orderLocators);
  if (input.timeZone !== "Asia/Shanghai") fail(`${manifestName}: timeZone must be Asia/Shanghai`);
  if (input.schemaVersion === 4) {
    if (hasLocators && Object.hasOwn(input, "targetScope")) {
      fail(`${manifestName}: orderLocators mode does not accept targetScope`);
    }
    if (hasRange) normalizeRecruitmentTargetScopeV4(input.targetScope);
  } else {
    normalizeRecruitmentTargetScope(input.targetScope);
  }
  parseV2UserNote(input, manifestName);
  requireV2Rules(input, "RECRUITMENT", manifestName, rules);
  return structuredClone(input);
}

function parseManifestShape(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!manifestKeys.has(key)) fail(`${key} is not allowed`);
  }
  for (const required of [
    "schemaVersion",
    "runId",
    "rulesVersion",
    "orderType",
    "orderLocator",
    "bfRefs",
    "assetRefs",
  ]) {
    if (!Object.hasOwn(input, required)) fail(`${required} is required`);
  }
  if (input.schemaVersion !== 1) fail("unsupported schemaVersion");
  requireString(input.runId, "runId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(input.runId)) {
    fail("runId has an invalid format");
  }
  requireString(input.rulesVersion, "rulesVersion");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.rulesVersion)) {
    fail("rulesVersion has an invalid format");
  }
  if (!allOrderTypes.has(input.orderType)) fail("orderType is unsupported");

  const locator = input.orderLocator;
  if (locator === null || typeof locator !== "object" || Array.isArray(locator)) {
    fail("orderLocator must identify exactly one order");
  }
  if (Object.keys(locator).some((key) => !["kind", "value"].includes(key))) {
    fail("orderLocator contains an unknown field");
  }
  if (locator.kind !== "ORDER_ID") fail("orderLocator.kind must be ORDER_ID");
  requireString(locator.value, "orderLocator.value");
  if (/\r|\n|[,;]/u.test(locator.value)) {
    fail("orderLocator must identify exactly one order");
  }

  for (const field of ["bfRefs", "assetRefs"]) {
    const refs = input[field];
    if (!Array.isArray(refs)) fail(`${field} must be an array`);
    if (new Set(refs).size !== refs.length) fail(`${field} must be unique`);
    for (const ref of refs) {
      if (typeof ref !== "string" || !referencePattern.test(ref)) {
        fail(`${field} must contain opaque references`);
      }
      if (containsForbiddenPrivateValue(ref)) fail(`${field} contains private data`);
    }
  }
  if (Object.hasOwn(input, "userNote")) {
    requireString(input.userNote, "userNote");
    if (input.userNote.length > 500 || containsForbiddenPrivateValue(input.userNote)) {
      fail("userNote must be short and redacted");
    }
  }
  return structuredClone(input);
}

export function parseDirectedManifest(input, rules = undefined) {
  const parsed = parseManifestShape(input);
  if (parsed.orderType !== "DIRECTED") {
    fail("browser execution accepts DIRECTED only");
  }
  if (rules !== undefined) requireTrustedRules(rules);
  else loadRules(parsed.rulesVersion);
  fail("DIRECTED is not issuable");
}

const submissionChecklist = [
  "VERIFY_ORDER_AND_CREATOR_UID",
  "DETERMINE_HISTORY_SEQUENCE",
  "CHECK_BUDGET_AND_PRICING",
  "PREPARE_TASK_FIELDS",
  "VERIFY_ASSETS_COMPONENT_AND_MONITORING",
  "WAIT_USER_PUBLISH",
  "VERIFY_TASK_DETAIL",
  "PREPARE_WRITEBACK_AND_WAIT_CONFIRM",
];
const recruitmentChecklist = [
  "VERIFY_ORDER_AND_ACTIVITY",
  "DETERMINE_ACTIVITY_SEQUENCE",
  "VERIFY_ACTIVITY_CONFIGURATION",
  "VERIFY_THREE_IDENTIFIERS",
  "VERIFY_CREATOR_PRICE_AND_DATE",
  "VERIFY_ASSETS_COMPONENT_AND_MONITORING",
  "WAIT_USER_PROTECTED_ACTIONS",
  "VERIFY_ORIGINAL_ACTIVITY_WRITEBACK",
];

const checklistInstructions = {
  VERIFY_ORDER_AND_CREATOR_UID: "Verify the single internal order, creator identity, and submission UID before preparing any task fields.",
  DETERMINE_HISTORY_SEQUENCE: "Read the authoritative task history and stop for human determination when the configured count cannot be proven.",
  CHECK_BUDGET_AND_PRICING: "Reconcile the current order amount, budget, pricing method, and configured submission limits without guessing.",
  PREPARE_TASK_FIELDS: "Prepare the manual submission task name, dates, attempts, and current-order fields from the loaded rules.",
  VERIFY_ASSETS_COMPONENT_AND_MONITORING: "Verify current-order asset references, landing-page policy, monitoring values, and switches before handoff.",
  WAIT_USER_PUBLISH: "Stop before the protected publish action and give the user the completed field-by-field review checklist.",
  VERIFY_TASK_DETAIL: "After the user publishes, uniquely locate the task detail and re-read every recovery-significant field.",
  PREPARE_WRITEBACK_AND_WAIT_CONFIRM: "Prepare only the verified task identifier for writeback, then stop before the protected confirmation action.",
  VERIFY_ORDER_AND_ACTIVITY: "Verify the single recruitment order and its original activity identifier before handling any creator.",
  DETERMINE_ACTIVITY_SEQUENCE: "Read authoritative recruitment history and require human determination when the activity sequence is unproven.",
  VERIFY_ACTIVITY_CONFIGURATION: "Verify the recruitment activity budget, dates, capacity, pricing, and configured task fields from current data.",
  VERIFY_THREE_IDENTIFIERS: "Compare the activity identifier, internal creator identifier, and creator Xingtu identifier as three distinct values.",
  VERIFY_CREATOR_PRICE_AND_DATE: "Process one creator at a time and stop when the registered price, proposed price, or delivery date conflicts.",
  WAIT_USER_PROTECTED_ACTIONS: "Stop before every protected publish or confirmation action and return control to the user for the click.",
  VERIFY_ORIGINAL_ACTIVITY_WRITEBACK: "Re-read the verified activity and write back only the original recruitment activity identifier required by the rules.",
};

function checklistRuleData(orderType, id, rules) {
  if (id === "DETERMINE_HISTORY_SEQUENCE") return { numbering: rules.numbering.submission };
  if (id === "DETERMINE_ACTIVITY_SEQUENCE") return { numbering: rules.numbering.recruitment };
  if (id === "PREPARE_WRITEBACK_AND_WAIT_CONFIRM") return { writeback: rules.writeback.submission };
  if (id === "VERIFY_ORIGINAL_ACTIVITY_WRITEBACK") return { writeback: rules.writeback.recruitment };
  if (id === "VERIFY_THREE_IDENTIFIERS") return { identifiers: rules.identifiers };
  if (id === "VERIFY_ASSETS_COMPONENT_AND_MONITORING") {
    return {
      landingPage: rules.landingPage,
      monitoring: rules.monitoring,
      common: rules.common,
    };
  }
  return { mode: rules[orderType.toLocaleLowerCase("en-US")] };
}

function manualChecklist(orderType, rules) {
  const ids = orderType === "SUBMISSION" ? submissionChecklist : recruitmentChecklist;
  return ids.map((id) => ({
    id,
    instruction: checklistInstructions[id],
    source: `business-rules.${rules.rulesVersion}`,
    protectedActions: [...rules.common.protectedActions],
    ruleData: structuredClone(checklistRuleData(orderType, id, rules)),
  }));
}

export function planTaskManifest(input, rules = undefined) {
  if (input?.schemaVersion === 2) {
    if (input.orderType === "DIRECTED") fail("DIRECTED is not issuable");
    if (input.orderType === "SUBMISSION") {
      const manifest = parseSubmissionManifest(input, rules);
      return {
        decision: "EXECUTABLE",
        browserExecution: true,
        orderType: manifest.orderType,
        manifest,
      };
    }
    if (input.orderType === "RECRUITMENT") {
      const manifest = parseRecruitmentBatchManifest(input, rules);
      return {
        decision: "EXECUTABLE",
        browserExecution: true,
        orderType: manifest.orderType,
        manifest,
        createdAtRange: normalizeShanghaiCreatedAtRange(manifest.createdAtRange),
      };
    }
    fail("v2 orderType is unsupported");
  }
  if (input?.orderType === "DIRECTED") fail("DIRECTED is not issuable");
  const parsed = parseManifestShape(input);
  const loadedRules = rules ?? loadRules(parsed.rulesVersion);
  if (loadedRules.rulesVersion !== parsed.rulesVersion) {
    fail("rulesVersion does not match loaded rules");
  }
  if (loadedRules.executionV1.manualChecklistOnly.includes(parsed.orderType)) {
    return {
      decision: "MANUAL_ONLY",
      orderType: parsed.orderType,
      browserExecution: false,
      rulesVersion: parsed.rulesVersion,
      checklist: manualChecklist(parsed.orderType, loadedRules),
    };
  }
  return {
    decision: "EXECUTABLE",
    browserExecution: true,
    manifest: parseDirectedManifest(parsed, loadedRules),
  };
}
