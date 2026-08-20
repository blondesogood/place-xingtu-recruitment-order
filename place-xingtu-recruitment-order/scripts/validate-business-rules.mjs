#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  classifyRecruitmentCompletionStatus,
} from "./lib/recruitment-completion-status.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const trustedSchemaPaths = new Map([
  ["./business-rules.schema.json", resolve(moduleDirectory, "../references/business-rules.schema.json")],
  ["./business-rules.schema.v2.json", resolve(moduleDirectory, "../references/business-rules.schema.v2.json")],
]);
const semanticSetPaths = new Set([
  "advertiser.disabledLegacyIds",
  "common.protectedActions",
  "executionV1.browserExecutable",
  "executionV1.manualChecklistOnly",
  "numbering.submission.excludedStates",
  "numbering.recruitment.excludedStates",
  "directed.lowDiscountWhitelistWeekdays",
  "landingPage.fallbackConfirmationGate.tokenBindings",
  "executionV2.executableOrderTypes",
  "executionV2.rejectedOrderTypes",
  "numbering.submission.excludedStates",
  "recruitment.verificationFields",
]);

function canonicalizeValue(value, path = []) {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => canonicalizeValue(item, path));
    if (semanticSetPaths.has(path.join("."))) {
      normalized.sort((left, right) => {
        const leftKey = JSON.stringify(left);
        const rightKey = JSON.stringify(right);
        if (leftKey < rightKey) return -1;
        if (leftKey > rightKey) return 1;
        return 0;
      });
    }
    return normalized;
  }

  if (value !== null && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (path.length === 0 && key === "integritySha256") continue;
      normalized[key] = canonicalizeValue(value[key], [...path, key]);
    }
    return normalized;
  }

  return value;
}

export function canonicalizeRules(rules) {
  return JSON.stringify(canonicalizeValue(rules));
}

export function computeRulesDigest(rules) {
  return createHash("sha256").update(canonicalizeRules(rules)).digest("hex");
}

function typeMatches(value, expected) {
  if (expected === "array") return Array.isArray(value);
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === expected;
}

function resolveReference(rootSchema, reference) {
  if (!reference.startsWith("#/")) throw new Error(`unsupported schema reference: ${reference}`);
  return reference
    .slice(2)
    .split("/")
    .reduce((current, segment) => current[segment.replaceAll("~1", "/").replaceAll("~0", "~")], rootSchema);
}

function validateSchema(value, schema, rootSchema, path, errors) {
  if (schema.$ref) {
    validateSchema(value, resolveReference(rootSchema, schema.$ref), rootSchema, path, errors);
    return;
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}`);
    return;
  }

  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((allowed) => isDeepStrictEqual(value, allowed))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must not be empty`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path} does not match ${schema.pattern}`);
    }
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) {
      errors.push(`${path} must contain at most ${schema.maxLength} character(s)`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some((other) => isDeepStrictEqual(item, other)))) {
      errors.push(`${path} items must be unique`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchema(item, schema.items, rootSchema, `${path}[${index}]`, errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required`);
    }

    const declared = schema.properties ?? {};
    for (const [key, childValue] of Object.entries(value)) {
      if (Object.hasOwn(declared, key)) {
        validateSchema(childValue, declared[key], rootSchema, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateSchema(childValue, schema.additionalProperties, rootSchema, `${path}.${key}`, errors);
      }
    }
  }
}

function requireEqual(errors, actual, expected, path) {
  if (actual !== expected) errors.push(`${path} must be ${JSON.stringify(expected)}`);
}

function setsEqual(actualValues, expectedValues) {
  const actual = new Set(actualValues ?? []);
  const expected = new Set(expectedValues);
  return actual.size === expected.size && [...expected].every((value) => actual.has(value));
}

function requireSet(errors, actual, expected, path) {
  if (!setsEqual(actual, expected)) {
    errors.push(`${path} must contain exactly ${JSON.stringify(expected)}`);
  }
}

function validateV1Domain(rules, errors) {
  requireEqual(errors, rules.schemaVersion, 1, "$.schemaVersion");

  requireEqual(errors, rules.scope?.platform, "DOUYIN_XINGTU", "$.scope.platform");
  requireEqual(errors, rules.scope?.account, "AIHUISHOU_MAIN", "$.scope.account");

  requireSet(errors, rules.executionV1?.browserExecutable, ["DIRECTED"], "$.executionV1.browserExecutable");
  requireSet(
    errors,
    rules.executionV1?.manualChecklistOnly,
    ["SUBMISSION", "RECRUITMENT"],
    "$.executionV1.manualChecklistOnly",
  );
  requireEqual(errors, rules.executionV1?.oneOrderAtATime, true, "$.executionV1.oneOrderAtATime");

  requireSet(errors, rules.common?.protectedActions, ["发布任务", "确认下单"], "$.common.protectedActions");

  if (rules.advertiser?.disabledLegacyIds?.includes(rules.advertiser.fixedId)) {
    errors.push("$.advertiser.fixedId must not be a disabled legacy advertiser ID");
  }

  requireEqual(errors, rules.landingPage?.automaticFallback, false, "$.landingPage.automaticFallback");
  requireEqual(errors, rules.landingPage?.fallbackConfirmationGate?.required, true, "$.landingPage.fallbackConfirmationGate.required");
  requireEqual(errors, rules.landingPage?.fallbackConfirmationGate?.blockedResult, "NEEDS_HUMAN", "$.landingPage.fallbackConfirmationGate.blockedResult");
  requireEqual(errors, rules.landingPage?.fallbackConfirmationGate?.singleUse, true, "$.landingPage.fallbackConfirmationGate.singleUse");
  requireEqual(errors, rules.landingPage?.modeApplicability?.directedCustom, false, "$.landingPage.modeApplicability.directedCustom");
  requireEqual(errors, rules.landingPage?.modeApplicability?.directedInStream, true, "$.landingPage.modeApplicability.directedInStream");
  requireEqual(errors, rules.landingPage?.modeApplicability?.submission, true, "$.landingPage.modeApplicability.submission");
  requireEqual(errors, rules.landingPage?.modeApplicability?.recruitment, true, "$.landingPage.modeApplicability.recruitment");

  const requiredTokenBindings = new Set(["runId", "orderFingerprint", "rulesVersion", "candidateId"]);
  const tokenBindings = new Set(rules.landingPage?.fallbackConfirmationGate?.tokenBindings ?? []);
  if (tokenBindings.size !== requiredTokenBindings.size || [...requiredTokenBindings].some((binding) => !tokenBindings.has(binding))) {
    errors.push("$.landingPage.fallbackConfirmationGate.tokenBindings must bind run, order, rules version, and candidate");
  }

  if (rules.landingPage?.fallbackOrder?.includes(rules.landingPage.defaultId)) {
    errors.push("$.landingPage.fallbackOrder must not repeat $.landingPage.defaultId");
  }

  if (rules.writeback?.directed?.value !== rules.writeback?.submission?.value) {
    errors.push("$.writeback directed and submission must use the same generated task value");
  }
  if (rules.writeback?.recruitment?.value === rules.writeback?.directed?.value) {
    errors.push("$.writeback.recruitment must preserve the distinct original activity value");
  }
  for (const mode of ["directed", "submission", "recruitment"]) {
    requireEqual(errors, rules.writeback?.[mode]?.verificationRequired, true, `$.writeback.${mode}.verificationRequired`);
  }
  for (const mode of ["directed", "submission"]) {
    requireEqual(errors, rules.writeback?.[mode]?.source, "xingtu.generatedTask.detail", `$.writeback.${mode}.source`);
    requireEqual(errors, rules.writeback?.[mode]?.value, "generatedVerifiedTaskId", `$.writeback.${mode}.value`);
  }
  requireEqual(errors, rules.writeback?.recruitment?.value, "originalRecruitmentActivityId", "$.writeback.recruitment.value");

  const identifiers = rules.identifiers ?? {};
  const identifierDefinitions = Object.entries(identifiers).filter(
    ([name]) => name !== "creatorMatch",
  );
  const identifierSources = identifierDefinitions.map(([, definition]) => definition?.source);
  if (identifierSources.some((source) => !source) || new Set(identifierSources).size !== identifierSources.length) {
    errors.push("$.identifiers identifier sources must be present and distinct");
  }
  const creatorIdentifierNames = identifierDefinitions
    .filter(([, definition]) => !Object.hasOwn(definition ?? {}, "compareTo"))
    .map(([name]) => name);
  const creatorMatchNames = [
    identifiers.creatorMatch?.left,
    identifiers.creatorMatch?.right,
  ];
  if (!setsEqual(creatorMatchNames, creatorIdentifierNames)) {
    errors.push("$.identifiers.creatorMatch must connect the two configured creator identifiers");
  }
  requireEqual(errors, identifiers.creatorMatch?.relation, "EQUALS", "$.identifiers.creatorMatch.relation");
  if (rules.writeback?.recruitment?.source !== identifiers.recruitmentActivityId?.source) {
    errors.push("$.writeback.recruitment.source must be the original recruitment activity source");
  }

  const submissionNumbering = rules.numbering?.submission;
  const recruitmentNumbering = rules.numbering?.recruitment;
  if (submissionNumbering?.source !== recruitmentNumbering?.source) {
    errors.push("$.numbering submission and recruitment must use the same authoritative history source");
  }
  if (
    submissionNumbering?.countWhen?.creationState !== recruitmentNumbering?.countWhen?.creationState ||
    submissionNumbering?.countWhen?.effectiveState !== recruitmentNumbering?.countWhen?.effectiveState
  ) {
    errors.push("$.numbering submission and recruitment must share successful/effective count states");
  }
  if (submissionNumbering?.undetermined !== recruitmentNumbering?.undetermined) {
    errors.push("$.numbering submission and recruitment must share a fail-closed undetermined policy");
  }
  if (!setsEqual(submissionNumbering?.excludedStates, recruitmentNumbering?.excludedStates ?? [])) {
    errors.push("$.numbering submission and recruitment must share non-counting states");
  }

  if (submissionNumbering?.scope === recruitmentNumbering?.scope) {
    errors.push("$.numbering submission and recruitment scopes must remain distinct");
  }
  for (const [mode, numbering] of Object.entries({ submission: submissionNumbering, recruitment: recruitmentNumbering })) {
    const creationState = numbering?.countWhen?.creationState;
    const effectiveState = numbering?.countWhen?.effectiveState;
    if (creationState === effectiveState) {
      errors.push(`$.numbering.${mode}.countWhen states must be distinct`);
    }
    if (numbering?.excludedStates?.includes(creationState) || numbering?.excludedStates?.includes(effectiveState)) {
      errors.push(`$.numbering.${mode}.excludedStates must not exclude a counted state`);
    }
  }
  if (submissionNumbering?.nameTemplate === recruitmentNumbering?.nameTemplate) {
    errors.push("$.numbering submission and recruitment name templates must remain distinct");
  }

  const browserModes = new Set(rules.executionV1?.browserExecutable ?? []);
  const manualModes = new Set(rules.executionV1?.manualChecklistOnly ?? []);
  if (browserModes.size !== 1) {
    errors.push("$.executionV1.browserExecutable must contain exactly one v1 mode");
  }
  if (manualModes.size !== 2) {
    errors.push("$.executionV1.manualChecklistOnly must contain exactly two modes");
  }
  if ([...browserModes].some((mode) => manualModes.has(mode))) {
    errors.push("$.executionV1 browser and manual-only modes must be disjoint");
  }

  const positiveNumbers = [
    [rules.common?.projectTaskLimit, "$.common.projectTaskLimit"],
    [rules.directed?.acceptanceDays, "$.directed.acceptanceDays"],
    [rules.directed?.expectedPublishDays, "$.directed.expectedPublishDays"],
    [rules.directed?.retentionDays, "$.directed.retentionDays"],
    [rules.directed?.normalDiscountMinimum, "$.directed.normalDiscountMinimum"],
    [rules.directed?.normalDiscountMaximum, "$.directed.normalDiscountMaximum"],
    [rules.submission?.minimumCpm, "$.submission.minimumCpm"],
    [rules.submission?.minimumBudget, "$.submission.minimumBudget"],
    [rules.submission?.submissionAttempts, "$.submission.submissionAttempts"],
    [rules.submission?.deadlineOffsetDays, "$.submission.deadlineOffsetDays"],
    [rules.recruitment?.monthlyActivityMinimum, "$.recruitment.monthlyActivityMinimum"],
    [rules.recruitment?.monthlyActivityMaximum, "$.recruitment.monthlyActivityMaximum"],
    [rules.recruitment?.defaultBudget, "$.recruitment.defaultBudget"],
    [rules.recruitment?.creatorPriceMinimum, "$.recruitment.creatorPriceMinimum"],
    [rules.recruitment?.creatorPriceMaximum, "$.recruitment.creatorPriceMaximum"],
    [rules.recruitment?.retentionAndCycleDays, "$.recruitment.retentionAndCycleDays"],
  ];
  for (const [value, path] of positiveNumbers) {
    if (!(value > 0)) errors.push(`${path} must be greater than zero`);
  }
  if (rules.directed?.normalDiscountMinimum > rules.directed?.normalDiscountMaximum) {
    errors.push("$.directed normalDiscountMinimum must not exceed normalDiscountMaximum");
  }
  const videoTiers = rules.directed?.videoTiersSeconds ?? [];
  for (const [index, tier] of videoTiers.entries()) {
    if (!(tier.minimum > 0) || tier.minimum > tier.maximum) {
      errors.push(`$.directed.videoTiersSeconds[${index}] must have a positive ordered range`);
    }
    if (index > 0 && videoTiers[index - 1].maximum >= tier.minimum) {
      errors.push("$.directed.videoTiersSeconds must be ordered and non-overlapping");
    }
  }
  if (rules.recruitment?.monthlyActivityMinimum > rules.recruitment?.monthlyActivityMaximum) {
    errors.push("$.recruitment monthlyActivityMinimum must not exceed monthlyActivityMaximum");
  }
  if (rules.recruitment?.creatorPriceMinimum > rules.recruitment?.creatorPriceMaximum) {
    errors.push("$.recruitment creatorPriceMinimum must not exceed creatorPriceMaximum");
  }
}

function validateV2Domain(rules, errors) {
  requireEqual(errors, rules.schemaVersion, 2, "$.schemaVersion");
  requireEqual(errors, rules.scope?.platform, "DOUYIN_XINGTU", "$.scope.platform");
  requireEqual(errors, rules.scope?.account, "AIHUISHOU_MAIN", "$.scope.account");
  requireSet(errors, rules.executionV2?.executableOrderTypes, ["RECRUITMENT", "SUBMISSION"], "$.executionV2.executableOrderTypes");
  requireSet(errors, rules.executionV2?.rejectedOrderTypes, ["DIRECTED"], "$.executionV2.rejectedOrderTypes");
  requireEqual(errors, rules.executionV2?.oneOrderAtATime, true, "$.executionV2.oneOrderAtATime");
  if (rules.rulesVersion === "2026-08-13-r1") {
    requireEqual(errors, rules.uiContractRelease?.contractVersion, "2026-08-13", "$.uiContractRelease.contractVersion");
  }

  requireEqual(errors, rules.advertiser?.fixedId, "1762153969171463", "$.advertiser.fixedId");
  requireSet(errors, rules.advertiser?.disabledLegacyIds, [
    "1860803013800522", "1860808266285195", "1806234813200384",
    "1822097842247684", "1822097840698372", "1820760797834249",
  ], "$.advertiser.disabledLegacyIds");

  requireEqual(errors, rules.landingPage?.defaultId, "6", "$.landingPage.defaultId");
  requireSet(errors, rules.landingPage?.fallbackOrder, ["7", "8", "9"], "$.landingPage.fallbackOrder");
  requireEqual(errors, rules.landingPage?.automaticFallback, false, "$.landingPage.automaticFallback");
  requireEqual(errors, rules.landingPage?.fallbackConfirmationGate?.required, true, "$.landingPage.fallbackConfirmationGate.required");
  requireEqual(errors, rules.landingPage?.fallbackConfirmationGate?.blockedResult, "NEEDS_HUMAN", "$.landingPage.fallbackConfirmationGate.blockedResult");
  requireEqual(errors, rules.landingPage?.fallbackConfirmationGate?.singleUse, true, "$.landingPage.fallbackConfirmationGate.singleUse");
  requireSet(errors, rules.landingPage?.fallbackConfirmationGate?.tokenBindings, ["runId", "orderFingerprint", "rulesVersion", "candidateId"], "$.landingPage.fallbackConfirmationGate.tokenBindings");
  requireEqual(errors, rules.landingPage?.modeApplicability?.submission, true, "$.landingPage.modeApplicability.submission");
  requireEqual(errors, rules.landingPage?.modeApplicability?.recruitment, true, "$.landingPage.modeApplicability.recruitment");

  requireEqual(errors, rules.common?.referenceAsset, "references/assets/爱回收logo.png", "$.common.referenceAsset");
  requireEqual(errors, rules.monitoring?.clickTemplate, "https://app-data-analysis.aihuishou.com/application-data-analysis-service/callback/douyin-xintu?ts=TS&os=OS&ua=UA&ip=IP&ipv6=IPV6&model=MODEL&demandId=DEMAND_ID&itemId=ITEM_ID&callbackParam=CALLBACK_PARAM&callbackUrl=CALLBACK_URL&awemeAuthorId=AWEME_AUTHOR_ID&grouping=A&type=click", "$.monitoring.clickTemplate");
  requireEqual(errors, rules.monitoring?.exposureTemplate, "https://app-data-analysis.aihuishou.com/application-data-analysis-service/callback/douyin-xintu?ts=TS&os=OS&ua=UA&ip=IP&ipv6=IPV6&model=MODEL&demandId=DEMAND_ID&itemId=ITEM_ID&callbackParam=CALLBACK_PARAM&callbackUrl=CALLBACK_URL&awemeAuthorId=AWEME_AUTHOR_ID&grouping=A&type=exposure", "$.monitoring.exposureTemplate");

  requireEqual(errors, rules.writeback?.submission?.source, "xingtu.generatedTask.detail", "$.writeback.submission.source");
  requireEqual(errors, rules.writeback?.submission?.value, "generatedVerifiedTaskId", "$.writeback.submission.value");
  requireEqual(errors, rules.writeback?.recruitment?.source, "internalOrder.taskId", "$.writeback.recruitment.source");
  requireEqual(errors, rules.writeback?.recruitment?.value, "originalRecruitmentActivityId", "$.writeback.recruitment.value");
  requireEqual(errors, rules.writeback?.submission?.verificationRequired, true, "$.writeback.submission.verificationRequired");
  requireEqual(errors, rules.writeback?.recruitment?.verificationRequired, true, "$.writeback.recruitment.verificationRequired");
  requireEqual(errors, rules.identifiers?.recruitmentActivityId?.source, "internalOrder.taskId", "$.identifiers.recruitmentActivityId.source");
  requireEqual(errors, rules.identifiers?.recruitmentActivityId?.compareTo, "xingtu.recruitmentActivity.id", "$.identifiers.recruitmentActivityId.compareTo");
  requireEqual(errors, rules.identifiers?.internalCreatorId?.source, "internalOrder.creatorId", "$.identifiers.internalCreatorId.source");
  requireEqual(errors, rules.identifiers?.creatorXingtuId?.source, "xingtu.recruitmentActivity.creator.xingtuId", "$.identifiers.creatorXingtuId.source");
  requireEqual(errors, rules.identifiers?.creatorMatch?.relation, "EQUALS", "$.identifiers.creatorMatch.relation");
  requireEqual(errors, rules.identifiers?.nicknameChangeAllowed, true, "$.identifiers.nicknameChangeAllowed");

  const numbering = rules.numbering?.submission;
  requireEqual(errors, numbering?.scope, "creatorSubmissionStartCalendarMonth", "$.numbering.submission.scope");
  requireEqual(errors, numbering?.countWhen?.creationState, "SUCCESSFUL", "$.numbering.submission.countWhen.creationState");
  requireEqual(errors, numbering?.countWhen?.effectiveState, "EFFECTIVE", "$.numbering.submission.countWhen.effectiveState");
  requireSet(errors, numbering?.excludedStates, ["UNPUBLISHED", "CANCELLED", "WRONG_ORDER", "PUBLISH_FAILED", "INEFFECTIVE"], "$.numbering.submission.excludedStates");
  requireEqual(errors, numbering?.undetermined, "HUMAN_DETERMINATION_REQUIRED", "$.numbering.submission.undetermined");
  requireEqual(errors, numbering?.nameTemplate, "爱回收 CPM投稿 {creatorName} {month}月-{sequence}", "$.numbering.submission.nameTemplate");

  for (const [orderType, expected] of Object.entries({
    submission: { publish: "USER", internalConfirmation: "AGENT" },
    recruitment: { publish: "AGENT", internalConfirmation: "AGENT" },
  })) {
    const permissions = rules.actionPermissions?.[orderType];
    requireEqual(errors, permissions?.publish, expected.publish, `$.actionPermissions.${orderType}.publish`);
    requireEqual(errors, permissions?.internalConfirmation, expected.internalConfirmation, `$.actionPermissions.${orderType}.internalConfirmation`);
    for (const action of ["login", "captcha", "securityVerification", "landingPageFallback"]) {
      requireEqual(errors, permissions?.[action], "USER", `$.actionPermissions.${orderType}.${action}`);
    }
  }

  requireEqual(errors, rules.submission?.taskConfiguration?.taskKind, "SHORT_VIDEO_SUBMISSION", "$.submission.taskConfiguration.taskKind");
  requireEqual(errors, rules.submission?.taskConfiguration?.hardRequirementEnabled, false, "$.submission.taskConfiguration.hardRequirementEnabled");
  requireEqual(errors, rules.submission?.taskConfiguration?.specialRequirements, "NONE", "$.submission.taskConfiguration.specialRequirements");
  requireEqual(errors, rules.submission?.budgetSource, "internalOrder.upperPrice", "$.submission.budgetSource");
  requireEqual(errors, rules.submission?.minimumCpm, 5, "$.submission.minimumCpm");
  requireEqual(errors, rules.submission?.minimumBudget, 10000, "$.submission.minimumBudget");
  requireEqual(errors, rules.submission?.maximumPrice, 10000, "$.submission.maximumPrice");
  requireEqual(errors, rules.submission?.submissionAttempts, 2, "$.submission.submissionAttempts");
  requireEqual(errors, rules.submission?.deadlineOffsetDays, 7, "$.submission.deadlineOffsetDays");
  requireEqual(errors, rules.submission?.creatorUidDoubleCheck, true, "$.submission.creatorUidDoubleCheck");
  requireEqual(errors, rules.submission?.bfRequirement, "NOT_REQUIRED", "$.submission.bfRequirement");
  requireEqual(errors, rules.submission?.assetSource, "BUILT_IN_LOGO", "$.submission.assetSource");
  requireEqual(errors, rules.submission?.completionStatus, "商务已下单", "$.submission.completionStatus");

  requireEqual(errors, rules.recruitment?.existingActivityOnly, true, "$.recruitment.existingActivityOnly");
  requireEqual(errors, rules.recruitment?.createMonthlyActivity, false, "$.recruitment.createMonthlyActivity");
  requireEqual(errors, rules.recruitment?.numbering, "NONE", "$.recruitment.numbering");
  requireEqual(errors, rules.recruitment?.oneCreatorAtATime, true, "$.recruitment.oneCreatorAtATime");
  if (rules.rulesVersion === "2026-08-17-r1") {
    requireEqual(errors, rules.uiContractRelease?.contractVersion, "2026-08-17", "$.uiContractRelease.contractVersion");
    requireEqual(errors, rules.recruitment?.budgetTopUp?.stepMinorUnits, 1_000_000, "$.recruitment.budgetTopUp.stepMinorUnits");
    requireEqual(errors, rules.recruitment?.budgetTopUp?.maxPerActivityPerBatch, 1, "$.recruitment.budgetTopUp.maxPerActivityPerBatch");
    requireEqual(errors, rules.recruitment?.budgetTopUp?.maxPerBatch, 3, "$.recruitment.budgetTopUp.maxPerBatch");
    requireEqual(errors, rules.recruitment?.budgetTopUp?.requiresExplicitInsufficientBudgetEvidence, true, "$.recruitment.budgetTopUp.requiresExplicitInsufficientBudgetEvidence");
  } else if (Object.hasOwn(rules.recruitment ?? {}, "budgetTopUp")) {
    errors.push("$.recruitment.budgetTopUp is reserved for the 2026-08-17-r1 recruitment release");
  }
  if (rules.rulesVersion !== "2026-08-12") {
    const expectedDeadlineBasis = /-r[1-9][0-9]*$/u.test(rules.rulesVersion ?? "")
      ? "CURRENT_OPERATION_CALENDAR_MONTH_END"
      : "ORDER_CALENDAR_MONTH_END";
    requireEqual(errors, rules.recruitment?.deliveryDeadline?.basis, expectedDeadlineBasis, "$.recruitment.deliveryDeadline.basis");
    requireEqual(errors, rules.recruitment?.deliveryDeadline?.timeZone, "Asia/Shanghai", "$.recruitment.deliveryDeadline.timeZone");
    requireEqual(errors, rules.recruitment?.deliveryDeadline?.internalPlannedPublishDatePolicy, "IGNORE", "$.recruitment.deliveryDeadline.internalPlannedPublishDatePolicy");
  }
  const recruitmentCompletionStatus = rules.recruitment?.completionStatus;
  try {
    const classified = classifyRecruitmentCompletionStatus(recruitmentCompletionStatus);
    if (
      classified.kind === "CALIBRATED" &&
      !/-r[1-9][0-9]*$/u.test(rules.rulesVersion ?? "")
    ) {
      errors.push("$.recruitment.completionStatus may be calibrated only by a revisioned rules version");
    }
  } catch (error) {
    errors.push(`$.recruitment.completionStatus is invalid: ${error.message}`);
  }
  requireEqual(errors, rules.recruitment?.sameBusinessErrorThreshold, 3, "$.recruitment.sameBusinessErrorThreshold");
  requireSet(errors, rules.recruitment?.verificationFields, ["ACTIVITY_ID", "INTERNAL_CREATOR_ID", "XINGTU_CREATOR_ID", "PRICE", "DATE"], "$.recruitment.verificationFields");
}

export function validateRules(rules, schema) {
  const errors = [];
  validateSchema(rules, schema, schema, "$", errors);
  if (errors.length === 0) {
    if (rules.schemaVersion === 1) validateV1Domain(rules, errors);
    if (rules.schemaVersion === 2) validateV2Domain(rules, errors);
  }
  const computedDigest = computeRulesDigest(rules);
  if (rules.integritySha256 !== computedDigest) {
    errors.push(
      `$.integritySha256 does not match canonical rule digest ${computedDigest}`,
    );
  }
  return { valid: errors.length === 0, errors };
}

export function validateRuleFile(rulePath) {
  const rules = JSON.parse(readFileSync(rulePath, "utf8"));
  const schemaPath = trustedSchemaPaths.get(rules.$schema);
  if (!schemaPath) throw new Error("$schema must reference a trusted business-rules schema exactly");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const result = validateRules(rules, schema);
  const versionMatch = basename(rulePath).match(/^business-rules\.v(.+)\.json$/);
  if (versionMatch && rules.rulesVersion !== versionMatch[1]) {
    result.errors.push("$.rulesVersion must match the version encoded in the rule filename");
    result.valid = false;
  }
  return { rules, result };
}

function main() {
  const rulePath = process.argv[2];
  if (!rulePath) {
    process.stdout.write(`${JSON.stringify({ valid: false, errors: ["usage: validate-business-rules.mjs <rules.json>"] })}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const { rules, result } = validateRuleFile(resolve(rulePath));
    if (result.valid) {
      process.stdout.write(`${JSON.stringify({ valid: true, rulesVersion: rules.rulesVersion, schemaVersion: rules.schemaVersion })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ valid: false, errors: [error.message] })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
