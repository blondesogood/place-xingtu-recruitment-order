import { createHash } from "node:crypto";

import { requireTrustedRules } from "./rules.mjs";
import { validateSplitRelease, validateSplitUiContract } from "./split-ui-contract.mjs";

const modes = new Set(["DIRECTED", "SUBMISSION", "RECRUITMENT"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function validateSplitRuntimeBinding(mode, input) {
  if (!modes.has(mode)) throw new Error("split Skill runtime mode is invalid");
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("split Skill runtime binding is invalid");
  }
  const release = validateSplitRelease(input.release);
  if (release.orderType !== mode) throw new Error("split Skill runtime release order type mismatch");
  const rules = requireTrustedRules(input.rules);
  if (rules.rulesVersion !== release.rulesVersion) throw new Error("split Skill runtime rules binding mismatch");
  validateSplitUiContract(input.uiContract, release);
  const runtimeFingerprint = createHash("sha256").update(JSON.stringify(canonical({
    release,
    rules,
    uiContract: input.uiContract,
  }))).digest("hex");
  return Object.freeze({
    release,
    candidateVersion: release.candidateVersion,
    runtimeFingerprint,
    rules: Object.freeze(structuredClone(rules)),
    uiContract: Object.freeze(structuredClone(input.uiContract)),
  });
}
