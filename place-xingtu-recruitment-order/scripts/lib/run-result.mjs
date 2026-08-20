import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isProxy } from "node:util/types";

import { loadRules } from "./rules.mjs";
import {
  classifyRecruitmentCompletionStatus,
  validateRecruitmentCompletionStatus,
} from "./recruitment-completion-status.mjs";
import { STAGES_BY_ORDER_TYPE } from "./state-machine.mjs";

export const RUN_STATUSES = Object.freeze(["DONE", "NEEDS_HUMAN", "BLOCKED"]);
export const EXECUTION_STAGES = Object.freeze([
  "ORDER_LOCKED",
  "DRAFT_READY",
  "WAIT_USER_PUBLISH",
  "TASK_VERIFIED",
  "WRITEBACK_READY",
  "WAIT_USER_CONFIRM",
  "PUBLISH_INTENT",
  "CONFIRM_INTENT",
  "FINAL_OBSERVED",
  "DONE",
]);
export const CHECK_STATUSES = Object.freeze(["NOT_STARTED", "READY", "PASSED", "FAILED"]);
export const ERROR_CODES = Object.freeze([
  "LOGIN_EXPIRED",
  "REQUEST_FAILED",
  "AMBIGUOUS_RESULT",
  "FIELD_MISMATCH",
  "NO_DATA_UNVERIFIED",
  "MALFORMED_EVIDENCE",
  "ORDER_FINGERPRINT_MISMATCH",
  "RULES_VERSION_MISMATCH",
  "ORDER_TYPE_MISMATCH",
  "TASK_LOOKUP_UNVERIFIED",
  "PUBLISH_STATE_UNPROVEN",
  "VERIFIED_TASK_AMBIGUOUS",
  "UNKNOWN_RECOVERY_STAGE",
  "LANDING_DEFAULT_UNAVAILABLE",
  "LANDING_POLICY_UNDEFINED",
  "LANDING_AVAILABILITY_UNVERIFIED",
  "SEMANTIC_ELEMENT_MISSING",
  "WRITEBACK_FAILED",
  "PROFILE_OCCUPIED",
  "CONFIRM_STATE_UNPROVEN",
  "PUBLISH_TASK_AMBIGUOUS",
  "PUBLISH_RESULT_UNKNOWN",
  "CONFIRM_RESULT_UNKNOWN",
  "RECRUITMENT_STATUS_UNCONFIRMED",
  "RECRUITMENT_FINAL_STATUS_MISMATCH",
  "SUBMISSION_FINAL_STATUS_MISMATCH",
  "BATCH_PAUSED",
  "BATCH_RECOVERY_REQUIRED",
]);
export const FIELD_CODES = Object.freeze([
  "AUTH_STATE",
  "PAGE_MATCH_COUNT",
  "ORDER_MATCH_COUNT",
  "TASK_MATCH_COUNT",
  "ORDER_FINGERPRINT",
  "RULES_VERSION",
  "ORDER_TYPE",
  "PROJECT_TYPE",
  "CREATOR_ID",
  "AMOUNT",
  "PLANNED_DATE",
  "ORDER_STATUS",
  "ADVERTISER_ID",
  "BF_REFS",
  "ASSET_REFS",
  "TASK_ID",
  "WRITEBACK",
  "FINAL_STATUS",
  "LANDING_PAGE",
]);
export const VALUE_CODES = Object.freeze([
  "AUTHENTICATED",
  "EXPIRED",
  "MATCHED",
  "MISMATCHED",
  "UNIQUE",
  "MISSING",
  "AMBIGUOUS",
  "AVAILABLE",
  "UNAVAILABLE",
  "NOT_APPLICABLE",
]);
export const TAKEOVER_STEP_CODES = Object.freeze([
  "RESTORE_DEDICATED_PROFILE_LOGIN",
  "VERIFY_UNIQUE_ORDER",
  "VERIFY_UNIQUE_TASK",
  "RESOLVE_FIELD_MISMATCH",
  "DETERMINE_PUBLISH_STATE",
  "CONFIRM_LANDING_FALLBACK",
  "REVIEW_BLOCKED_RUN",
  "CONFIRM_RECRUITMENT_FINAL_STATUS",
  "VERIFY_SUBMISSION_FINAL_STATUS",
  "REVIEW_BATCH_RECOVERY",
]);

const allowedKeys = new Set([
  "schemaVersion",
  "runId",
  "orderId",
  "status",
  "stage",
  "orderFingerprint",
  "verifiedTaskId",
  "writebackEvidenceHash",
  "writebackCheck",
  "finalCheck",
  "errorDetails",
  "expected",
  "actual",
  "takeoverSteps",
  "orderType",
  "rulesVersion",
  "finalObservation",
]);

export const FINAL_STATUS_CODES = Object.freeze([
  "CONFIRMED",
  "NOT_CONFIRMED",
  "商务已下单",
  "待商务下单",
]);
export const FINAL_OBSERVATION_CODES = Object.freeze([
  "SUBMISSION_BUSINESS_ORDERED",
  "SUBMISSION_OTHER",
  "RECRUITMENT_STATUS_OBSERVED_UNCALIBRATED",
  "RECRUITMENT_STATUS_OBSERVED_CALIBRATED",
]);

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

function requireExactKeys(value, allowed, label, required = allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`RunResult ${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`RunResult ${label}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`RunResult ${label}.${key} is required`);
  }
}

function cloneOwnEnumerableDataRecord(value, label, allowed = undefined) {
  if (
    value === null ||
    typeof value !== "object" ||
    isProxy(value) ||
    Array.isArray(value)
  ) throw new Error(`${label} must be a non-proxy object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} prototype cannot be trusted`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new Error(`${label} symbols are not allowed`);
  }
  if (allowed !== undefined) {
    for (const key of ownKeys) {
      if (!allowed.has(key)) throw new Error(`${label} ${key} is not allowed`);
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const clone = Object.create(null);
  for (const key of ownKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.get === "function" ||
      typeof descriptor.set === "function"
    ) throw new Error(`${label} ${key} must be an enumerable data property`);
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return clone;
}

function clonePrimitiveDataRecord(value, label) {
  const clone = cloneOwnEnumerableDataRecord(value, `RunResult ${label}`);
  for (const key of Object.keys(clone)) {
    const property = clone[key];
    if (
      property === null ||
      new Set(["object", "function", "symbol", "bigint", "undefined"]).has(typeof property)
    ) throw new Error(`RunResult ${label}.${key} must be primitive data`);
  }
  return Object.defineProperties({}, Object.getOwnPropertyDescriptors(clone));
}

function cloneRunResultRecord(value) {
  return cloneOwnEnumerableDataRecord(value, "RunResult", allowedKeys);
}

function cloneDataArray(value, label, cloneEntry) {
  if (isProxy(value) || !Array.isArray(value)) {
    throw new Error(`RunResult ${label} must be a non-proxy array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`RunResult ${label} array prototype cannot be trusted`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new Error(`RunResult ${label} symbols are not allowed`);
  }
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    lengthDescriptor.value !== value.length ||
    lengthDescriptor.enumerable !== false
  ) throw new Error(`RunResult ${label} array length descriptor is invalid`);
  const expected = Array.from({ length: value.length }, (_, index) => String(index));
  const actual = keys.filter((key) => key !== "length");
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`RunResult ${label} array properties are invalid`);
  }
  const result = [];
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`RunResult ${label}[${key}] must be an enumerable data property`);
    }
    result.push(cloneEntry(descriptor.value, `${label}[${key}]`));
  }
  return Object.freeze(result);
}

function cloneCheckRecord(value, label) {
  const record = cloneOwnEnumerableDataRecord(
    value,
    `RunResult ${label}`,
    new Set(["status", "fieldResults"]),
  );
  if (Object.hasOwn(record, "fieldResults")) {
    record.fieldResults = cloneDataArray(record.fieldResults, `${label}.fieldResults`, (entry, entryLabel) =>
      Object.freeze(cloneOwnEnumerableDataRecord(
        entry,
        `RunResult ${entryLabel}`,
        new Set(["fieldCode", "status"]),
      )));
  }
  return Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(record)));
}

function cloneErrorDetailsRecord(value) {
  const record = cloneOwnEnumerableDataRecord(
    value,
    "RunResult errorDetails",
    new Set(["code", "fieldCodes"]),
  );
  if (Object.hasOwn(record, "fieldCodes")) {
    record.fieldCodes = cloneDataArray(record.fieldCodes, "errorDetails.fieldCodes", (entry, label) => {
      if (typeof entry !== "string") throw new Error(`RunResult ${label} must be a string`);
      return entry;
    });
  }
  return Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(record)));
}

function cloneTypedSummaryRecord(value, label) {
  return Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(
    cloneOwnEnumerableDataRecord(
      value,
      `RunResult ${label}`,
      new Set(["fieldCode", "valueCode", "booleanValue", "numericValue"]),
    ),
  )));
}

function cloneTypedSummaryInput(value, label) {
  if (isProxy(value)) throw new Error(`RunResult ${label} must not be a proxy`);
  if (Array.isArray(value)) {
    return cloneDataArray(value, label, (entry, entryLabel) => cloneTypedSummaryRecord(entry, entryLabel));
  }
  return cloneTypedSummaryRecord(value, label);
}

function cloneTakeoverSteps(value) {
  return cloneDataArray(value, "takeoverSteps", (entry, label) => {
    if (typeof entry !== "string") throw new Error(`RunResult ${label} must be a string`);
    return entry;
  });
}

function snapshotRunResult(value) {
  const record = cloneRunResultRecord(value);
  if (Object.hasOwn(record, "writebackCheck")) {
    record.writebackCheck = cloneCheckRecord(record.writebackCheck, "writebackCheck");
  }
  if (Object.hasOwn(record, "finalCheck")) {
    record.finalCheck = cloneCheckRecord(record.finalCheck, "finalCheck");
  }
  if (Object.hasOwn(record, "errorDetails")) {
    record.errorDetails = cloneErrorDetailsRecord(record.errorDetails);
  }
  if (Object.hasOwn(record, "expected")) {
    record.expected = cloneTypedSummaryInput(record.expected, "expected");
  }
  if (Object.hasOwn(record, "actual")) {
    record.actual = cloneTypedSummaryInput(record.actual, "actual");
  }
  if (Object.hasOwn(record, "takeoverSteps")) {
    record.takeoverSteps = cloneTakeoverSteps(record.takeoverSteps);
  }
  if (Object.hasOwn(record, "finalObservation") && record.finalObservation !== null) {
    record.finalObservation = clonePrimitiveDataRecord(record.finalObservation, "finalObservation");
  }
  return Object.freeze(record);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateTopLevelScalarSlots(input) {
  if (!Number.isSafeInteger(input.schemaVersion)) {
    throw new Error("RunResult schemaVersion scalar must be a safe integer");
  }
  for (const field of ["runId", "status", "stage", "orderFingerprint"]) {
    if (typeof input[field] !== "string") {
      throw new Error(`RunResult ${field} scalar must be a string`);
    }
  }
  for (const field of ["orderId", "orderType", "rulesVersion"]) {
    if (Object.hasOwn(input, field) && typeof input[field] !== "string") {
      throw new Error(`RunResult ${field} scalar must be a string`);
    }
  }
  for (const field of ["verifiedTaskId", "writebackEvidenceHash"]) {
    if (
      Object.hasOwn(input, field) &&
      input[field] !== null &&
      typeof input[field] !== "string"
    ) throw new Error(`RunResult ${field} scalar must be a string or null`);
  }
}

function validateFinalObservationRecord(record, rules = undefined) {
  const v2 = record.schemaVersion === 2;
  const calibratedRecruitment = v2 &&
    record.observationCode === "RECRUITMENT_STATUS_OBSERVED_CALIBRATED";
  requireExactKeys(record, v2 ? [
    "schemaVersion", "runId", "orderType", "orderId", "orderFingerprint",
    "rulesVersion", "verifiedTaskId", "writebackEvidenceHash", "observationCode",
    ...(calibratedRecruitment ? ["observedStatus"] : []),
    "integritySha256",
  ] : [
    "schemaVersion", "runId", "orderType", "orderId", "orderFingerprint",
    "rulesVersion", "verifiedTaskId", "writebackEvidenceHash", "statusCode",
    "integritySha256",
  ], "finalObservation");
  if (
    !new Set([1, 2]).has(record.schemaVersion) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(record.runId ?? "") ||
    !new Set(["RECRUITMENT", "SUBMISSION"]).has(record.orderType) ||
    typeof record.orderId !== "string" || record.orderId.length === 0 ||
    !/^[a-f0-9]{64}$/u.test(record.orderFingerprint ?? "") ||
    !/^\d{4}-\d{2}-\d{2}(?:-r[1-9]\d*)?$/u.test(record.rulesVersion ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(record.verifiedTaskId ?? "") ||
    !/^[a-f0-9]{64}$/u.test(record.writebackEvidenceHash ?? "") ||
    (v2 ? !FINAL_OBSERVATION_CODES.includes(record.observationCode) : !FINAL_STATUS_CODES.includes(record.statusCode)) ||
    (v2 && (
      (record.orderType === "SUBMISSION" && !record.observationCode.startsWith("SUBMISSION_")) ||
      (record.orderType === "RECRUITMENT" && !new Set([
        "RECRUITMENT_STATUS_OBSERVED_UNCALIBRATED",
        "RECRUITMENT_STATUS_OBSERVED_CALIBRATED",
      ]).has(record.observationCode))
    )) ||
    record.integritySha256 !== integrity(record)
  ) throw new Error("RunResult finalObservation fields, status, or integrity are invalid");
  if (calibratedRecruitment) validateRecruitmentCompletionStatus(record.observedStatus);
  if (rules !== undefined) {
    if (
      rules?.schemaVersion !== 2 ||
      record.schemaVersion !== 2 ||
      record.rulesVersion !== rules.rulesVersion
    ) throw new Error("RunResult finalObservation rules binding is invalid");
    if (record.orderType === "RECRUITMENT") {
      const completion = classifyRecruitmentCompletionStatus(rules.recruitment?.completionStatus);
      if (
        (completion.kind === "UNCALIBRATED" &&
          record.observationCode !== "RECRUITMENT_STATUS_OBSERVED_UNCALIBRATED") ||
        (completion.kind === "CALIBRATED" && (
          record.observationCode !== "RECRUITMENT_STATUS_OBSERVED_CALIBRATED" ||
          record.observedStatus !== completion.value
        ))
      ) throw new Error("RunResult recruitment final observation does not match trusted rules");
    }
  }
  return Object.freeze(record);
}

export function validateFinalObservation(value) {
  return validateFinalObservationRecord(
    clonePrimitiveDataRecord(value, "finalObservation"),
  );
}

export function validateFinalObservationForRules(value, rules) {
  return validateFinalObservationRecord(
    clonePrimitiveDataRecord(value, "finalObservation"),
    rules,
  );
}

export function validateFinalObservationArtifact(value) {
  const record = clonePrimitiveDataRecord(value, "finalObservation");
  return validateFinalObservationRecord(
    record,
    record.schemaVersion === 2 ? loadRules(record.rulesVersion) : undefined,
  );
}

export function createFinalObservation(input) {
  const record = clonePrimitiveDataRecord(input, "finalObservation");
  delete record.integritySha256;
  const complete = { ...record, integritySha256: integrity(record) };
  return validateFinalObservationRecord(complete);
}

export function createRecruitmentFinalObservation(input, observedStatus, suppliedRules) {
  const trustedRules = loadRules(suppliedRules?.rulesVersion);
  if (!isDeepStrictEqual(suppliedRules, trustedRules)) {
    throw new Error("RunResult recruitment observation rules are not trusted");
  }
  const observed = validateRecruitmentCompletionStatus(observedStatus);
  const completion = classifyRecruitmentCompletionStatus(
    trustedRules.recruitment.completionStatus,
  );
  const uncalibrated = completion.kind === "UNCALIBRATED";
  const record = {
    ...clonePrimitiveDataRecord(input, "finalObservation"),
    observationCode: uncalibrated
      ? "RECRUITMENT_STATUS_OBSERVED_UNCALIBRATED"
      : "RECRUITMENT_STATUS_OBSERVED_CALIBRATED",
    ...(uncalibrated ? {} : { observedStatus: observed }),
  };
  delete record.integritySha256;
  const observation = validateFinalObservationRecord({
    ...record,
    integritySha256: integrity(record),
  }, trustedRules);
  if (!uncalibrated && observation.observedStatus !== completion.value) {
    throw new Error("RunResult recruitment observed status does not match trusted calibrated rules");
  }
  return observation;
}

export function validateTypedSummaries(summary, label = "summary") {
  const values = Array.isArray(summary) ? summary : [summary];
  if (values.length === 0) return [];
  for (const value of values) {
    requireExactKeys(
      value,
      ["fieldCode", "valueCode", "booleanValue", "numericValue"],
      label,
      ["fieldCode"],
    );
    if (!FIELD_CODES.includes(value.fieldCode)) {
      throw new Error(`RunResult ${label}.fieldCode is not allowed`);
    }
    const valueKeys = ["valueCode", "booleanValue", "numericValue"].filter((key) => Object.hasOwn(value, key));
    if (valueKeys.length !== 1) throw new Error(`RunResult ${label} must contain exactly one typed value`);
    if (Object.hasOwn(value, "valueCode") && !VALUE_CODES.includes(value.valueCode)) {
      throw new Error(`RunResult ${label}.valueCode is not allowed`);
    }
    if (Object.hasOwn(value, "booleanValue") && typeof value.booleanValue !== "boolean") {
      throw new Error(`RunResult ${label}.booleanValue is invalid`);
    }
    if (Object.hasOwn(value, "numericValue") && !Number.isSafeInteger(value.numericValue)) {
      throw new Error(`RunResult ${label}.numericValue is invalid`);
    }
  }
  return structuredClone(values);
}

function validateCheck(check, label, requiredPassedFields) {
  requireExactKeys(check, ["status", "fieldResults"], label, ["status"]);
  if (!CHECK_STATUSES.includes(check.status)) throw new Error(`RunResult ${label}.status is invalid`);
  const results = check.fieldResults ?? [];
  if (Object.hasOwn(check, "fieldResults")) {
    if (!Array.isArray(check.fieldResults)) throw new Error(`RunResult ${label}.fieldResults is invalid`);
    for (const result of check.fieldResults) {
      requireExactKeys(result, ["fieldCode", "status"], `${label}.fieldResults`);
      if (!FIELD_CODES.includes(result.fieldCode) || !CHECK_STATUSES.includes(result.status)) {
        throw new Error(`RunResult ${label}.fieldResults contains an invalid code`);
      }
    }
  }
  const fieldCodes = results.map((result) => result.fieldCode);
  if (new Set(fieldCodes).size !== fieldCodes.length) {
    throw new Error(`RunResult ${label}.fieldResults contains duplicate child fields`);
  }
  if (check.status === "NOT_STARTED") {
    if (results.length !== 0) {
      throw new Error(`RunResult ${label} NOT_STARTED aggregate cannot contain child results`);
    }
    return;
  }
  if (results.length === 0) {
    throw new Error(`RunResult ${label} ${check.status} aggregate requires non-empty fieldResults`);
  }
  if (check.status === "READY") {
    if (
      results.some((result) => !["READY", "PASSED"].includes(result.status)) ||
      !results.some((result) => result.status === "READY")
    ) throw new Error(`RunResult ${label} READY aggregate contradicts child fieldResults`);
    return;
  }
  if (check.status === "FAILED") {
    if (
      results.some((result) => !["PASSED", "FAILED"].includes(result.status)) ||
      !results.some((result) => result.status === "FAILED")
    ) throw new Error(`RunResult ${label} FAILED aggregate contradicts child fieldResults`);
    return;
  }
  if (
    results.some((result) => result.status !== "PASSED") ||
    requiredPassedFields.some((fieldCode) => !fieldCodes.includes(fieldCode))
  ) throw new Error(`RunResult ${label} PASSED aggregate contradicts child fieldResults`);
}

function validateErrorDetails(errorDetails) {
  requireExactKeys(errorDetails, ["code", "fieldCodes"], "errorDetails", ["code"]);
  if (!ERROR_CODES.includes(errorDetails.code)) throw new Error("RunResult errorDetails.code is not allowed");
  if (Object.hasOwn(errorDetails, "fieldCodes")) {
    if (
      !Array.isArray(errorDetails.fieldCodes) ||
      errorDetails.fieldCodes.length === 0 ||
      errorDetails.fieldCodes.some((code) => !FIELD_CODES.includes(code))
    ) throw new Error("RunResult errorDetails.fieldCodes is invalid");
  }
}

export function createRunResult(untrustedInput) {
  const input = snapshotRunResult(untrustedInput);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new Error(`RunResult ${key} is not allowed`);
  }
  const requiredFields = [
    "schemaVersion", "runId", "status", "stage", "orderFingerprint", "verifiedTaskId",
    "writebackCheck", "finalCheck", "takeoverSteps",
  ];
  let trustedFinalObservation;
  if (input.schemaVersion === 2) {
    requiredFields.push("orderType", "rulesVersion", "writebackEvidenceHash", "finalObservation");
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(input, field)) throw new Error(`RunResult ${field} is required`);
  }
  validateTopLevelScalarSlots(input);
  if (!new Set([1, 2]).has(input.schemaVersion)) throw new Error("RunResult schemaVersion is unsupported");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(input.runId ?? "")) {
    throw new Error("RunResult runId is invalid");
  }
  if (!RUN_STATUSES.includes(input.status)) throw new Error("RunResult status is invalid");
  if (!EXECUTION_STAGES.includes(input.stage)) throw new Error("RunResult stage is invalid");
  if (!/^[a-f0-9]{64}$/u.test(input.orderFingerprint ?? "")) {
    throw new Error("RunResult orderFingerprint is invalid");
  }
  if (
    input.verifiedTaskId !== null &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(input.verifiedTaskId ?? "")
  ) throw new Error("RunResult verifiedTaskId is invalid");
  if (
    !Array.isArray(input.takeoverSteps) ||
    input.takeoverSteps.some((step) => !TAKEOVER_STEP_CODES.includes(step)) ||
    new Set(input.takeoverSteps).size !== input.takeoverSteps.length
  ) throw new Error("RunResult takeover step code is not allowed");
  validateCheck(
    input.writebackCheck,
    "writebackCheck",
    ["TASK_ID", "ADVERTISER_ID", "WRITEBACK"],
  );
  validateCheck(
    input.finalCheck,
    "finalCheck",
    ["ORDER_FINGERPRINT", "TASK_ID", "FINAL_STATUS"],
  );
  if (Object.hasOwn(input, "errorDetails")) validateErrorDetails(input.errorDetails);
  if (Object.hasOwn(input, "expected")) validateTypedSummaries(input.expected, "expected");
  if (Object.hasOwn(input, "actual")) validateTypedSummaries(input.actual, "actual");
  if (new Set(["NEEDS_HUMAN", "BLOCKED"]).has(input.status) && input.takeoverSteps.length === 0) {
    throw new Error(`RunResult ${input.status} requires takeover step codes`);
  }
  if (input.status === "DONE") {
    if (input.stage !== "DONE") throw new Error("RunResult DONE requires DONE stage");
    if (!input.verifiedTaskId) throw new Error("RunResult DONE requires verifiedTaskId");
    if (input.writebackCheck.status !== "PASSED" || input.finalCheck.status !== "PASSED") {
      throw new Error("RunResult DONE requires passed final checks");
    }
    if (input.takeoverSteps.length !== 0) throw new Error("RunResult DONE cannot include takeover steps");
  }
  if (input.schemaVersion === 2) {
    if (!new Set(["RECRUITMENT", "SUBMISSION"]).has(input.orderType)) {
      throw new Error("RunResult orderType is invalid");
    }
    const hasOrderId = Object.hasOwn(input, "orderId");
    if (hasOrderId && (typeof input.orderId !== "string" || input.orderId.length === 0)) {
      throw new Error("RunResult orderId is invalid");
    }
    const rules = loadRules(input.rulesVersion);
    if (rules.schemaVersion !== 2 || rules.rulesVersion !== input.rulesVersion) {
      throw new Error("RunResult rulesVersion is not an executable v2 rule");
    }
    const finalObservation = input.finalObservation === null
      ? null
      : validateFinalObservationForRules(input.finalObservation, rules);
    trustedFinalObservation = finalObservation;
    const trustedOrderId = hasOrderId ? input.orderId : finalObservation?.orderId;
    if (typeof trustedOrderId !== "string" || trustedOrderId.length === 0) {
      throw new Error("RunResult orderId is required when no terminal observation can migrate it");
    }
    if (!STAGES_BY_ORDER_TYPE[input.orderType].includes(input.stage)) {
      throw new Error("RunResult stage is not valid for orderType");
    }
    const writebackRequired = new Set([
      "WRITEBACK_READY", "CONFIRM_INTENT", "FINAL_OBSERVED", "DONE",
    ]).has(input.stage);
    if (
      writebackRequired
        ? !/^[a-f0-9]{64}$/u.test(input.writebackEvidenceHash ?? "")
        : input.writebackEvidenceHash !== null
    ) throw new Error("RunResult writebackEvidenceHash does not match stage");
    const observationStage = new Set(["FINAL_OBSERVED", "DONE"]).has(input.stage);
    if (observationStage !== (finalObservation !== null)) {
      throw new Error("RunResult final observation does not match stage");
    }
    if (finalObservation && (
      finalObservation.schemaVersion !== 2 ||
      finalObservation.runId !== input.runId ||
      finalObservation.orderId !== trustedOrderId ||
      finalObservation.orderType !== input.orderType ||
      finalObservation.orderFingerprint !== input.orderFingerprint ||
      finalObservation.rulesVersion !== input.rulesVersion ||
      finalObservation.verifiedTaskId !== input.verifiedTaskId ||
      finalObservation.writebackEvidenceHash !== input.writebackEvidenceHash
    )) throw new Error("RunResult finalObservation binding mismatch");
    if (
      input.orderType === "RECRUITMENT" &&
      rules.recruitment.completionStatus === "UNCONFIRMED" &&
      input.status === "DONE"
    ) throw new Error("RunResult recruitment UNCONFIRMED can never be DONE");
    if (
      input.orderType === "RECRUITMENT" &&
      input.status === "DONE" &&
      (
        finalObservation.observationCode !== "RECRUITMENT_STATUS_OBSERVED_CALIBRATED" ||
        finalObservation.observedStatus !== rules.recruitment.completionStatus
      )
    ) throw new Error("RunResult recruitment DONE requires the exact calibrated final status");
    if (
      input.orderType === "SUBMISSION" &&
      input.status === "DONE" &&
      finalObservation.observationCode !== "SUBMISSION_BUSINESS_ORDERED"
    ) throw new Error("RunResult submission final status must be 商务已下单");
  }
  if (input.schemaVersion !== 2) return deepFreeze(structuredClone(input));
  const safeResult = {};
  for (const key of Object.keys(input)) {
    if (key !== "finalObservation") safeResult[key] = input[key];
  }
  if (!Object.hasOwn(safeResult, "orderId")) {
    safeResult.orderId = trustedFinalObservation.orderId;
  }
  safeResult.finalObservation = trustedFinalObservation;
  return deepFreeze(structuredClone(safeResult));
}
