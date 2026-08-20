import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { validateOrderSnapshotRecord } from "./order-snapshot.mjs";
import { planLandingPage } from "./landing-page.mjs";
import { requireTrustedRules } from "./rules.mjs";
import { advanceStage, STAGES_BY_ORDER_TYPE } from "./state-machine.mjs";
import { parseExecutorAction } from "./action-policy.mjs";
import { validateFinalObservationForRules } from "./run-result.mjs";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== "integritySha256")
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function withIntegrity(record) {
  return {
    ...record,
    integritySha256: createHash("sha256")
      .update(JSON.stringify(canonicalize(record)))
      .digest("hex"),
  };
}

function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} cannot be trusted: not an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} shape cannot be trusted`);
  }
}

function validateMutationRecord(record) {
  requireExactKeys(record, [
    "schemaVersion", "writerId", "runId", "orderId", "fingerprint", "nonce", "integritySha256",
  ], "run-state mutation owner");
  if (
    record.schemaVersion !== 1 ||
    !/^pid-[1-9][0-9]*-[A-Za-z0-9._-]+$/u.test(record.writerId ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(record.runId ?? "") ||
    typeof record.orderId !== "string" ||
    record.orderId.length === 0 ||
    !/^[a-f0-9]{64}$/u.test(record.fingerprint ?? "") ||
    !/^[A-Za-z0-9-]{16,128}$/u.test(record.nonce ?? "") ||
    record.integritySha256 !== withIntegrity(record).integritySha256
  ) throw new Error("run-state mutation owner cannot be trusted");
  return structuredClone(record);
}

function assertWriterInactive(writerId) {
  const match = /^pid-([1-9][0-9]*)-[A-Za-z0-9._-]+$/u.exec(writerId);
  if (!match) throw new Error("run-state mutation writer liveness cannot be determined");
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) {
    throw new Error("run-state mutation writer liveness cannot be determined");
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw new Error("run-state mutation writer liveness cannot be determined");
  }
  throw new Error("run-state mutation writer is still active");
}

async function writeExclusive(path, value) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readTrustedJson(path, label) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("record is not an object");
    }
    return value;
  } catch (error) {
    throw new Error(`${label} cannot be trusted: ${error.message}`);
  }
}

function allowedLandingPagesFromRules(rules) {
  const landingPage = rules?.landingPage;
  if (
    typeof rules?.rulesVersion !== "string" ||
    typeof landingPage?.defaultId !== "string" ||
    landingPage.defaultId.length === 0 ||
    !Array.isArray(landingPage.fallbackOrder) ||
    landingPage.fallbackOrder.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set([landingPage.defaultId, ...landingPage.fallbackOrder]).size !== 1 + landingPage.fallbackOrder.length
  ) throw new Error("run-state rules landing-page policy cannot be trusted");
  const allowed = new Set([landingPage.defaultId, ...landingPage.fallbackOrder]);
  for (const projectType of ["DIRECTED_IN_STREAM", "DIRECTED_CUSTOM"]) {
    const planned = planLandingPage({ projectType, defaultAvailability: "AVAILABLE", rules });
    if (planned.status === "READY" && planned.selection !== "DEFAULT") allowed.add(planned.selection);
  }
  return allowed;
}

function validate(record, allowedLandingPages, rules) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("run state must be an object");
  }
  const keys = [
    "schemaVersion", "runId", "orderType", "stage", "orderSnapshot", "verifiedTaskId",
    "landingPage", "writebackEvidenceHash", "pendingAction", "finalObservation",
  ];
  if (Object.keys(record).sort().join(",") !== keys.sort().join(",")) {
    throw new Error("run state shape cannot be trusted");
  }
  if (
    record.schemaVersion !== 2 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(record.runId ?? "") ||
    !new Set(["RECRUITMENT", "SUBMISSION"]).has(record.orderType) ||
    !STAGES_BY_ORDER_TYPE[record.orderType]?.includes(record.stage) ||
    (record.verifiedTaskId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(record.verifiedTaskId ?? ""))
  ) throw new Error("run state fields cannot be trusted");
  if (
    record.landingPage !== null &&
    !allowedLandingPages.has(record.landingPage)
  ) throw new Error("run state landingPage cannot be trusted");
  const snapshot = validateOrderSnapshotRecord(record.orderSnapshot);
  if (
    snapshot.orderType !== record.orderType ||
    snapshot.rulesVersion !== rules.rulesVersion
  ) throw new Error("run state order snapshot binding mismatch");
  const taskRequiredStages = new Set([
    "TASK_VERIFIED", "WRITEBACK_READY", "CONFIRM_INTENT", "FINAL_OBSERVED", "DONE",
  ]);
  if (taskRequiredStages.has(record.stage) !== (record.verifiedTaskId !== null)) {
    throw new Error("run state verifiedTaskId does not match stage");
  }
  const writebackRequiredStages = new Set([
    "WRITEBACK_READY", "CONFIRM_INTENT", "FINAL_OBSERVED", "DONE",
  ]);
  if (
    writebackRequiredStages.has(record.stage)
      ? !/^[a-f0-9]{64}$/u.test(record.writebackEvidenceHash ?? "")
      : record.writebackEvidenceHash !== null
  ) throw new Error("run state writebackEvidenceHash does not match stage");
  const intentStages = new Set([
    "PUBLISH_INTENT", "BUDGET_TOPUP_INTENT", "PUBLISH_RETRY_READY", "CONFIRM_INTENT",
  ]);
  if (intentStages.has(record.stage) !== (record.pendingAction !== null)) {
    throw new Error("run state pendingAction does not match intent stage");
  }
  let pendingAction = null;
  if (record.pendingAction !== null) {
    pendingAction = parseExecutorAction(record.pendingAction, rules);
    const binding = pendingAction.intentionEvidence;
    if (
      pendingAction.orderType !== record.orderType ||
      pendingAction.stage !== record.stage ||
      binding.runId !== record.runId ||
      binding.orderId !== snapshot.orderId ||
      binding.orderFingerprint !== snapshot.fingerprint ||
      binding.rulesVersion !== snapshot.rulesVersion ||
      (pendingAction.type === "CONFIRM_INTERNAL_ORDER" &&
        (binding.verifiedTaskId !== record.verifiedTaskId ||
          binding.writebackEvidenceHash !== record.writebackEvidenceHash))
    ) throw new Error("run state pendingAction binding mismatch");
  }
  const observationStages = new Set(["FINAL_OBSERVED", "DONE"]);
  if (observationStages.has(record.stage) !== (record.finalObservation !== null)) {
    throw new Error("run state finalObservation does not match stage");
  }
  let finalObservation = null;
  if (record.finalObservation !== null) {
    finalObservation = validateFinalObservationForRules(record.finalObservation, rules);
    if (
      finalObservation.schemaVersion !== 2 ||
      finalObservation.runId !== record.runId ||
      finalObservation.orderType !== record.orderType ||
      finalObservation.orderId !== snapshot.orderId ||
      finalObservation.orderFingerprint !== snapshot.fingerprint ||
      finalObservation.rulesVersion !== snapshot.rulesVersion ||
      finalObservation.verifiedTaskId !== record.verifiedTaskId ||
      finalObservation.writebackEvidenceHash !== record.writebackEvidenceHash
    ) throw new Error("run state finalObservation binding mismatch");
    if (
      record.stage === "DONE" &&
      record.orderType === "RECRUITMENT" &&
      rules.recruitment.completionStatus === "UNCONFIRMED"
    ) throw new Error("run state recruitment UNCONFIRMED can never be DONE");
  }
  const recordWithoutFinalObservation = {};
  for (const key of Object.keys(record)) {
    if (key !== "finalObservation") recordWithoutFinalObservation[key] = record[key];
  }
  return {
    ...structuredClone(recordWithoutFinalObservation),
    orderSnapshot: snapshot,
    pendingAction,
    finalObservation,
  };
}

export class RunStateStore {
  constructor(applicationDataDirectory, rules) {
    const trustedRules = requireTrustedRules(rules);
    this.rules = trustedRules;
    this.allowedLandingPages = allowedLandingPagesFromRules(trustedRules);
    this.directory = join(applicationDataDirectory, "runs");
    this.adjudicationDirectory = join(
      applicationDataDirectory,
      "evidence",
      "run-state-mutation-adjudications",
    );
  }

  pathFor(runId) {
    const name = createHash("sha256").update(runId).digest("hex");
    return join(this.directory, `${name}.json`);
  }

  mutationPathFor(runId) {
    return `${this.pathFor(runId)}.mutation`;
  }

  async readMutation(runId) {
    const record = await readTrustedJson(
      join(this.mutationPathFor(runId), "owner.json"),
      "run-state mutation owner",
    );
    const validated = validateMutationRecord(record);
    if (validated.runId !== runId) throw new Error("run-state mutation owner binding mismatch");
    return validated;
  }

  async acquireMutation(current) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const mutationPath = this.mutationPathFor(current.runId);
    const temporaryDirectory = await mkdtemp(`${mutationPath}.prepare-`);
    const record = withIntegrity({
      schemaVersion: 1,
      writerId: `pid-${process.pid}-${randomUUID()}`,
      runId: current.runId,
      orderId: current.orderSnapshot.orderId,
      fingerprint: current.orderSnapshot.fingerprint,
      nonce: randomUUID(),
    });
    await writeExclusive(join(temporaryDirectory, "owner.json"), record);
    try {
      await rename(temporaryDirectory, mutationPath);
    } catch (error) {
      await unlink(join(temporaryDirectory, "owner.json")).catch(() => {});
      await rmdir(temporaryDirectory).catch(() => {});
      if (new Set(["EEXIST", "ENOTEMPTY"]).has(error.code)) {
        const existing = await this.readMutation(current.runId);
        throw new Error(`run state is being transitioned by ${existing.writerId}`);
      }
      throw error;
    }
    return record;
  }

  async releaseMutation(record) {
    const existing = await this.readMutation(record.runId);
    if (
      existing.writerId !== record.writerId ||
      existing.nonce !== record.nonce ||
      existing.orderId !== record.orderId ||
      existing.fingerprint !== record.fingerprint
    ) throw new Error("run-state mutation ownership changed before release");
    const mutationPath = this.mutationPathFor(record.runId);
    const releasedPath = `${mutationPath}.released-${record.nonce}`;
    await rename(mutationPath, releasedPath);
    await unlink(join(releasedPath, "owner.json")).catch(() => {});
    await rmdir(releasedPath).catch(() => {});
  }

  async adjudicateStaleMutation(input) {
    requireExactKeys(input, [
      "expectedWriterId", "runId", "orderId", "fingerprint",
      "actorId", "reasonCode", "recordedAt",
    ], "stale run-state mutation adjudication");
    if (
      typeof input.expectedWriterId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(input.runId ?? "") ||
      typeof input.orderId !== "string" ||
      input.orderId.length === 0 ||
      !/^[a-f0-9]{64}$/u.test(input.fingerprint ?? "") ||
      !/^[A-Za-z0-9._-]{3,128}$/u.test(input.actorId ?? "") ||
      input.reasonCode !== "HUMAN_STALE_RUN_MUTATION_CONFIRMED" ||
      typeof input.recordedAt !== "string" ||
      new Date(input.recordedAt).toISOString() !== input.recordedAt
    ) throw new Error("stale run-state mutation adjudication is invalid");
    const current = await this.read(input.runId);
    if (
      !current ||
      current.orderSnapshot.orderId !== input.orderId ||
      current.orderSnapshot.fingerprint !== input.fingerprint
    ) throw new Error("stale run-state mutation adjudication binding mismatch");
    const owner = await this.readMutation(input.runId);
    if (
      owner.writerId !== input.expectedWriterId ||
      owner.runId !== input.runId ||
      owner.orderId !== input.orderId ||
      owner.fingerprint !== input.fingerprint
    ) throw new Error("stale run-state mutation adjudication binding mismatch");
    assertWriterInactive(owner.writerId);
    const record = withIntegrity({
      schemaVersion: 1,
      expectedWriterId: input.expectedWriterId,
      runId: input.runId,
      orderId: input.orderId,
      fingerprint: input.fingerprint,
      mutationNonce: owner.nonce,
      actorId: input.actorId,
      reasonCode: input.reasonCode,
      recordedAt: input.recordedAt,
    });
    await mkdir(this.adjudicationDirectory, { recursive: true, mode: 0o700 });
    const name = createHash("sha256")
      .update(`${input.runId}:${input.orderId}:${input.fingerprint}:${owner.writerId}:${owner.nonce}`)
      .digest("hex");
    const adjudicationPath = join(this.adjudicationDirectory, `${name}.json`);
    try {
      await writeExclusive(adjudicationPath, record);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readTrustedJson(adjudicationPath, "run-state mutation adjudication");
      requireExactKeys(existing, Object.keys(record), "run-state mutation adjudication");
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error("run-state mutation adjudication cannot be trusted");
      }
    }
    const stillOwned = await this.readMutation(input.runId);
    if (stillOwned.nonce !== owner.nonce || stillOwned.writerId !== owner.writerId) {
      throw new Error("run-state mutation ownership changed before adjudication");
    }
    const mutationPath = this.mutationPathFor(input.runId);
    const adjudicatedPath = `${mutationPath}.adjudicated-${owner.nonce}`;
    await rename(mutationPath, adjudicatedPath);
    await unlink(join(adjudicatedPath, "owner.json")).catch(() => {});
    await rmdir(adjudicatedPath).catch(() => {});
    return { adjudicated: true, adjudicationPath };
  }

  async read(runId) {
    try {
      const record = JSON.parse(await readFile(this.pathFor(runId), "utf8"));
      const validated = validate(record, this.allowedLandingPages, this.rules);
      if (validated.runId !== runId) throw new Error("run state binding mismatch");
      return validated;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error(`run state cannot be trusted: ${error.message}`);
    }
  }

  async write(record) {
    const validated = validate(record, this.allowedLandingPages, this.rules);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(validated.runId);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
    return structuredClone(validated);
  }

  async advance(runId, proposedStage, evidence, patch = {}) {
    if (Object.keys(patch).some((key) => !new Set([
      "verifiedTaskId", "landingPage", "writebackEvidenceHash", "pendingAction", "finalObservation",
    ]).has(key))) {
      throw new Error("run state transition patch contains an unknown field");
    }
    const before = await this.read(runId);
    if (!before) throw new Error("run state does not exist");
    const mutation = await this.acquireMutation(before);
    try {
      const current = await this.read(runId);
      if (!current) throw new Error("run state does not exist");
      if (
        current.orderSnapshot.orderId !== mutation.orderId ||
        current.orderSnapshot.fingerprint !== mutation.fingerprint
      ) throw new Error("run-state mutation compare-and-swap binding changed");
      if (Object.hasOwn(patch, "writebackEvidenceHash") && (
        current.writebackEvidenceHash !== null || proposedStage !== "WRITEBACK_READY"
      )) throw new Error("run state writebackEvidenceHash can only be recorded at WRITEBACK_READY");
      const stage = advanceStage(current.orderType, current.stage, proposedStage, evidence);
      return await this.write({ ...current, ...structuredClone(patch), stage });
    } finally {
      await this.releaseMutation(mutation);
    }
  }

  async runExclusive(runId, operation) {
    if (typeof operation !== "function") throw new Error("run-state exclusive operation is invalid");
    const before = await this.read(runId);
    if (!before) throw new Error("run state does not exist");
    const mutation = await this.acquireMutation(before);
    try {
      const current = await this.read(runId);
      if (
        !current ||
        current.orderSnapshot.orderId !== mutation.orderId ||
        current.orderSnapshot.fingerprint !== mutation.fingerprint
      ) throw new Error("run-state mutation compare-and-swap binding changed");
      return await operation(structuredClone(current));
    } finally {
      await this.releaseMutation(mutation);
    }
  }
}
