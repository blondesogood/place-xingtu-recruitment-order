import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { validateRuleFile } from "../validate-business-rules.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const referencesDirectory = resolve(moduleDirectory, "../../references");
const rulesVersionPattern = /^\d{4}-\d{2}-\d{2}(?:-r[1-9]\d*)?$/u;

export function isRulesVersion(value) {
  if (typeof value !== "string" || !rulesVersionPattern.test(value)) return false;
  const [datePart] = value.split("-r");
  const [year, month, day] = datePart.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function loadRules(rulesVersion) {
  if (!isRulesVersion(rulesVersion)) {
    throw new Error("rules version must use YYYY-MM-DD or YYYY-MM-DD-rN");
  }

  const path = resolve(
    referencesDirectory,
    `business-rules.v${rulesVersion}.json`,
  );
  let loaded;
  try {
    loaded = validateRuleFile(path);
  } catch (error) {
    throw new Error(`rules version ${rulesVersion} could not be loaded: ${error.message}`);
  }
  if (!loaded.result.valid) {
    throw new Error(
      `rules version ${rulesVersion} failed validation: ${loaded.result.errors.join("; ")}`,
    );
  }
  if (loaded.rules.rulesVersion !== rulesVersion) {
    throw new Error(`rules version mismatch: expected ${rulesVersion}`);
  }
  return structuredClone(loaded.rules);
}

export function requireTrustedRules(suppliedRules) {
  if (suppliedRules === null || typeof suppliedRules !== "object" || Array.isArray(suppliedRules)) {
    throw new Error("supplied rules must be a trusted canonical rule object");
  }
  const canonicalRules = loadRules(suppliedRules.rulesVersion);
  if (!isDeepStrictEqual(suppliedRules, canonicalRules)) {
    throw new Error("supplied rules do not match the trusted canonical rule content");
  }
  return canonicalRules;
}

export function requireExecutableV2Rules(suppliedRules) {
  const rules = requireTrustedRules(suppliedRules);
  if (
    rules.schemaVersion !== 2 ||
    rules.executionV2 === null ||
    typeof rules.executionV2 !== "object" ||
    !Array.isArray(rules.executionV2.executableOrderTypes) ||
    rules.executionV2.executableOrderTypes.length === 0 ||
    rules.executionV2.executableOrderTypes.some(
      (orderType) => !new Set(["RECRUITMENT", "SUBMISSION"]).has(orderType),
    ) ||
    !Array.isArray(rules.executionV2.rejectedOrderTypes) ||
    !rules.executionV2.rejectedOrderTypes.includes("DIRECTED")
  ) {
    throw new Error("rules version is not an issued executable schemaVersion 2 rule");
  }
  return rules;
}
