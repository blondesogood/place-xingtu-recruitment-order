import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const names = new Set([
  "place-xingtu-directed-order",
  "place-xingtu-submission-order",
  "place-xingtu-recruitment-order",
]);
const types = new Set(["DIRECTED", "SUBMISSION", "RECRUITMENT"]);
const versionPattern = /^\d{4}-\d{2}-\d{2}(?:-r[1-9]\d*)?$/u;
const expectedReleases = Object.freeze({
  DIRECTED: Object.freeze({
    skillName: "place-xingtu-directed-order", candidateVersion: "1.0.0-rc.4", schemaVersion: 3,
    orderType: "DIRECTED", rulesVersion: "2026-08-11", rulesFile: "business-rules.v2026-08-11.json",
    uiContractVersion: "2026-08-17-r1", uiContractFile: "ui-contract.v2026-08-17-r1.json",
    publishAuthority: "USER", internalConfirmationAuthority: "USER", liveAcceptance: "PENDING",
  }),
  SUBMISSION: Object.freeze({
    skillName: "place-xingtu-submission-order", candidateVersion: "1.0.0-rc.4", schemaVersion: 3,
    orderType: "SUBMISSION", rulesVersion: "2026-08-13-r1", rulesFile: "business-rules.v2026-08-13-r1.json",
    uiContractVersion: "2026-08-17-r1", uiContractFile: "ui-contract.v2026-08-17-r1.json",
    publishAuthority: "USER", internalConfirmationAuthority: "AGENT", liveAcceptance: "PENDING",
  }),
  RECRUITMENT: Object.freeze({
    skillName: "place-xingtu-recruitment-order", candidateVersion: "1.0.0-rc.12", schemaVersion: 4,
    orderType: "RECRUITMENT", rulesVersion: "2026-08-17-r1", rulesFile: "business-rules.v2026-08-17-r1.json",
    uiContractVersion: "2026-08-19", uiContractFile: "xingtu-ui-contract.v2026-08-19.json",
    publishAuthority: "AGENT", internalConfirmationAuthority: "AGENT", liveAcceptance: "PENDING_CURRENT_REVISION",
  }),
});
const expectedUiContractDigests = Object.freeze({
  DIRECTED: "c7da7ec95a213cdebef8d657c557d12785ba245e242f5af6d35e937844837e88",
  SUBMISSION: "5a1cfd5b3fd8338799349a23dfdb734e53a3bba7cfc3d4fa530741dad9bf00cc",
  RECRUITMENT: "446cdbea62a2ec223684bcef05d164d1d9921a70ab175f332870a0281febf225",
});

function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  plain(value, "split UI contract value");
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error("split UI contract must contain only plain JSON objects");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (keys.some((key) => !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))) {
    throw new Error("split UI contract must contain only enumerable data fields");
  }
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(descriptors[key].value)}`).join(",")}}`;
}

export function validateSplitRelease(release) {
  plain(release, "split release");
  const required = [
    "skillName", "candidateVersion", "schemaVersion", "orderType", "rulesVersion", "rulesFile",
    "uiContractVersion", "uiContractFile", "publishAuthority", "internalConfirmationAuthority", "liveAcceptance",
  ];
  if (Object.keys(release).sort().join(",") !== [...required].sort().join(",")) {
    throw new Error("split release fields are not exact");
  }
  if (
    !names.has(release.skillName) ||
    !new Set(["1.0.0-rc.4", "1.0.0-rc.12"]).has(release.candidateVersion) ||
    !new Set([3, 4]).has(release.schemaVersion) || !types.has(release.orderType) ||
    !versionPattern.test(release.rulesVersion) || !versionPattern.test(release.uiContractVersion) ||
    basename(release.rulesFile) !== release.rulesFile || basename(release.uiContractFile) !== release.uiContractFile ||
    !new Set(["USER", "AGENT"]).has(release.publishAuthority) ||
    !new Set(["USER", "AGENT"]).has(release.internalConfirmationAuthority)
  ) throw new Error("split release binding is invalid");
  const expected = expectedReleases[release.orderType];
  if (!expected || !isDeepStrictEqual(release, expected)) throw new Error("split release does not match the trusted candidate binding");
  return Object.freeze(structuredClone(release));
}

export function validateSplitUiContract(contract, releaseInput) {
  const release = validateSplitRelease(releaseInput);
  plain(contract, "split UI contract");
  const contractOrderType = contract.orderType ?? (
    contract.schemaVersion === 2 && Array.isArray(contract.recruitmentLookup)
      ? "RECRUITMENT"
      : null
  );
  const execution = contract.executionBoundary;
  const expectedExecution = release.orderType === "RECRUITMENT"
    ? ["EGO_ISOLATED_TASK_SPACE", "EGO_LITE", "EGO_BROWSER_CLI", "INHERITED_LOGIN_ISOLATED_TASK_SPACE"]
    : ["USER_AUTHORIZED_DAILY_CHROME", "GOOGLE_CHROME", "BUNDLED_CHROME_EXTENSION", "NO_DEDICATED_PROFILE"];
  if (
    contract.contractVersion !== release.uiContractVersion || contractOrderType !== release.orderType ||
    contract.sanitizedDataPolicy !== "SEMANTICS_ONLY" ||
    [execution?.session, execution?.browser, execution?.connection, execution?.profileMode]
      .some((value, index) => value !== expectedExecution[index]) ||
    contract.evidence?.artifactPolicy !== "NO_IDS_DOM_SCREENSHOTS_COOKIES_TOKENS_OR_PROFILE_DATA"
  ) throw new Error("split UI contract does not match its release");
  const digest = createHash("sha256").update(canonicalJson(contract)).digest("hex");
  if (digest !== expectedUiContractDigests[release.orderType]) {
    throw new Error("split UI contract does not match the trusted complete contract content");
  }
  if (release.orderType === "RECRUITMENT") {
    if (
      contract.actions?.recruitmentFinalSubmit?.stateful !== true ||
      contract.actions?.forbiddenRecruitmentGlobalAction?.availability !== "FORBIDDEN" ||
      contract.evidence?.egoLiteOrderIdLiveAcceptance?.status !== "COMPLETED" ||
      contract.evidence?.egoLiteDateModeLiveAcceptance?.status !== "COMPLETED" ||
      execution?.tierOrder?.join(",") !== "EGO_SEMANTIC,EGO_VISUAL,HUMAN"
    ) throw new Error("recruitment UI contract does not preserve its action authority");
  } else if (
    contract.actions?.publish?.authority !== release.publishAuthority ||
    contract.actions?.internalConfirmation?.authority !== release.internalConfirmationAuthority ||
    contract.evidence?.liveAcceptance !== release.liveAcceptance
  ) throw new Error("split UI contract authority or acceptance does not match its release");
  return Object.freeze(structuredClone(contract));
}

export function trustedSplitRelease(orderType) {
  if (!Object.hasOwn(expectedReleases, orderType)) throw new Error("split release order type is unsupported");
  return Object.freeze(structuredClone(expectedReleases[orderType]));
}

export function loadSplitReleaseAndUiContract(releasePath) {
  if (typeof releasePath !== "string" || !isAbsolute(releasePath) || basename(releasePath) !== "release.json") {
    throw new Error("split release path must be an absolute release.json path");
  }
  const release = validateSplitRelease(JSON.parse(readFileSync(releasePath, "utf8")));
  const contractPath = join(dirname(releasePath), release.uiContractFile);
  const contract = validateSplitUiContract(JSON.parse(readFileSync(contractPath, "utf8")), release);
  return Object.freeze({ release, contract });
}
