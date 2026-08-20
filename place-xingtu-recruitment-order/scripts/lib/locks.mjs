import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import { createRunResult } from "./run-result.mjs";

const stages = new Set([
  "ORDER_LOCKED",
  "DRAFT_READY",
  "WAIT_USER_PUBLISH",
  "TASK_VERIFIED",
  "WRITEBACK_READY",
  "WAIT_USER_CONFIRM",
  "DONE",
]);

function lockName(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

function verifyIntegrity(record, label) {
  if (record.integritySha256 !== withIntegrity(record).integritySha256) {
    throw new Error(`${label} integrity check failed`);
  }
}

function requireExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    const unknown = actual.find((key) => !expected.includes(key));
    const missing = expected.find((key) => !actual.includes(key));
    throw new Error(
      unknown
        ? `${label} ${unknown} is not allowed`
        : `${label} ${missing} is required`,
    );
  }
}

async function readJson(path, label) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("record is not an object");
    }
    return value;
  } catch (error) {
    throw new Error(`${label} record cannot be trusted: ${error.message}`);
  }
}

async function createExclusive(path, value) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOrCreateEvidence(path, record, validateExisting, label) {
  try {
    await createExclusive(path, record);
    return { record: structuredClone(record), created: true };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const existing = await readJson(path, label);
  validateExisting(existing);
  return { record: structuredClone(existing), created: false };
}

function validateIsoTimestamp(value, label) {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error(`${label} timestamp is invalid`);
  }
}

function validateProfileStopRecord(record, expected = undefined) {
  requireExactKeys(record, [
    "schemaVersion", "profileId", "profileNonce", "writerId", "runId", "orderId",
    "fingerprint", "stopReasonCode", "recordedAt", "integritySha256",
  ], "profile stop");
  verifyIntegrity(record, "profile stop");
  validateIdentity({ orderId: record.orderId, fingerprint: record.fingerprint, runId: record.runId });
  validateIsoTimestamp(record.recordedAt, "profile stop");
  if (
    record.schemaVersion !== 1 ||
    typeof record.profileId !== "string" || record.profileId.length === 0 ||
    typeof record.profileNonce !== "string" || record.profileNonce.length === 0 ||
    typeof record.writerId !== "string" || record.writerId.length === 0 ||
    !new Set(["PROFILE_OWNER_RELEASED", "HUMAN_STALE_PROFILE_ADJUDICATED"]).has(record.stopReasonCode)
  ) throw new Error("profile stop record cannot be trusted");
  if (expected) {
    for (const key of [
      "profileId", "profileNonce", "writerId", "runId", "orderId", "fingerprint", "stopReasonCode",
    ]) {
      if (record[key] !== expected[key]) throw new Error("profile stop binding mismatch");
    }
    if (expected.recordedAt !== undefined && record.recordedAt !== expected.recordedAt) {
      throw new Error("profile stop timestamp binding mismatch");
    }
  }
  return structuredClone(record);
}

function validateProfileAdjudicationRecord(record, expected = undefined) {
  requireExactKeys(record, [
    "schemaVersion", "profileId", "profileNonce", "expectedWriterId", "runId", "orderId",
    "fingerprint", "actorId", "reasonCode", "recordedAt", "integritySha256",
  ], "profile adjudication");
  verifyIntegrity(record, "profile adjudication");
  validateIdentity({ orderId: record.orderId, fingerprint: record.fingerprint, runId: record.runId });
  validateIsoTimestamp(record.recordedAt, "profile adjudication");
  if (
    record.schemaVersion !== 1 ||
    typeof record.profileId !== "string" || record.profileId.length === 0 ||
    typeof record.profileNonce !== "string" || record.profileNonce.length === 0 ||
    typeof record.expectedWriterId !== "string" || record.expectedWriterId.length === 0 ||
    !/^[A-Za-z0-9._-]{3,128}$/u.test(record.actorId ?? "") ||
    record.reasonCode !== "HUMAN_STALE_PROFILE_CONFIRMED"
  ) throw new Error("profile adjudication record cannot be trusted");
  if (expected) {
    for (const key of [
      "profileId", "profileNonce", "expectedWriterId", "runId", "orderId", "fingerprint",
      "actorId", "reasonCode", "recordedAt",
    ]) {
      if (record[key] !== expected[key]) throw new Error("profile adjudication binding mismatch");
    }
  }
  return structuredClone(record);
}

function validateTerminalReleaseRecord(record, expected = undefined) {
  requireExactKeys(record, [
    "schemaVersion", "orderId", "fingerprint", "ownerRunId", "stage",
    "evidenceKind", "decision", "recordedAt", "integritySha256",
  ], "terminal release");
  verifyIntegrity(record, "terminal release");
  validateIdentity({ orderId: record.orderId, fingerprint: record.fingerprint, runId: record.ownerRunId });
  validateIsoTimestamp(record.recordedAt, "terminal release");
  const validDecision =
    (record.evidenceKind === "DONE_RUN_RESULT" && record.stage === "DONE" && record.decision === "TERMINAL_DONE") ||
    (record.evidenceKind === "HUMAN_ABORT_ADJUDICATION" && record.stage !== "DONE" && record.decision === "ABORT_RUN");
  if (record.schemaVersion !== 1 || !stages.has(record.stage) || !validDecision) {
    throw new Error("terminal release record cannot be trusted");
  }
  if (expected) {
    for (const key of [
      "orderId", "fingerprint", "ownerRunId", "stage", "evidenceKind", "decision", "recordedAt",
    ]) {
      if (record[key] !== expected[key]) throw new Error("terminal release binding mismatch");
    }
  }
  return structuredClone(record);
}

async function replaceAtomically(path, value) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await createExclusive(temporaryPath, value);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function orderLockPath(applicationDataDirectory, orderId) {
  return join(
    applicationDataDirectory,
    "locks",
    "orders",
    `${lockName(orderId)}.json`,
  );
}

const mutationOperationCodes = new Set([
  "PROFILE_ACQUIRE",
  "PROFILE_RELEASE",
  "PROFILE_STALE_ADJUDICATE",
  "ORDER_RELEASE",
  "ORDER_TRANSFER",
]);

function validateOrderMutationRecord(record) {
  requireExactKeys(record, [
    "schemaVersion", "writerId", "runId", "orderId", "fingerprint", "operationCode",
    "targetRunId", "nonce", "integritySha256",
  ], "order mutation owner");
  validateIdentity(record);
  if (
    record.schemaVersion !== 1 ||
    !/^pid-[1-9][0-9]*-[A-Za-z0-9._-]+$/u.test(record.writerId ?? "") ||
    !mutationOperationCodes.has(record.operationCode) ||
    !/^[A-Za-z0-9-]{16,128}$/u.test(record.nonce ?? "") ||
    (record.operationCode === "ORDER_TRANSFER"
      ? typeof record.targetRunId !== "string" || record.targetRunId.length === 0 || record.targetRunId === record.runId
      : record.targetRunId !== null)
  ) throw new Error("order mutation owner cannot be trusted");
  verifyIntegrity(record, "order mutation owner");
  return structuredClone(record);
}

async function readOrderMutation(mutationPath) {
  return validateOrderMutationRecord(
    await readJson(join(mutationPath, "owner.json"), "order mutation owner"),
  );
}

async function withOrderMutationLock(applicationDataDirectory, bindings, operationCode, targetRunId, operation) {
  validateIdentity(bindings);
  if (!mutationOperationCodes.has(operationCode)) throw new Error("order mutation operation is invalid");
  if (operationCode === "ORDER_TRANSFER") {
    if (typeof targetRunId !== "string" || targetRunId.length === 0 || targetRunId === bindings.runId) {
      throw new Error("order mutation transfer target is invalid");
    }
  } else if (targetRunId !== null) throw new Error("order mutation target is not allowed");
  const path = orderLockPath(applicationDataDirectory, bindings.orderId);
  await mkdir(join(applicationDataDirectory, "locks", "orders"), {
    recursive: true,
    mode: 0o700,
  });
  const mutationPath = `${path}.mutation`;
  const temporaryDirectory = await mkdtemp(`${mutationPath}.prepare-`);
  const owner = withIntegrity({
    schemaVersion: 1,
    writerId: `pid-${process.pid}-${randomUUID()}`,
    runId: bindings.runId,
    orderId: bindings.orderId,
    fingerprint: bindings.fingerprint,
    operationCode,
    targetRunId,
    nonce: randomUUID(),
  });
  await createExclusive(join(temporaryDirectory, "owner.json"), owner);
  try {
    await rename(temporaryDirectory, mutationPath);
  } catch (error) {
    await unlink(join(temporaryDirectory, "owner.json")).catch(() => {});
    await rmdir(temporaryDirectory).catch(() => {});
    if (new Set(["EEXIST", "ENOTEMPTY"]).has(error.code)) {
      const existing = await readOrderMutation(mutationPath);
      throw new Error(`order ${bindings.orderId} lock is being mutated by ${existing.writerId}`);
    }
    throw error;
  }
  try {
    const current = await readJson(path, "order lock");
    validateOrderRecord(current);
    if (
      current.orderId !== bindings.orderId ||
      current.ownerRunId !== bindings.runId ||
      current.fingerprint !== bindings.fingerprint
    ) throw new Error("order mutation no longer matches the unresolved owner binding");
    return await operation(path, current);
  } finally {
    const currentOwner = await readOrderMutation(mutationPath);
    if (
      currentOwner.writerId !== owner.writerId ||
      currentOwner.nonce !== owner.nonce ||
      currentOwner.runId !== owner.runId ||
      currentOwner.orderId !== owner.orderId ||
      currentOwner.fingerprint !== owner.fingerprint
    ) throw new Error("order mutation ownership changed before release");
    const releasedPath = `${mutationPath}.released-${owner.nonce}`;
    await rename(mutationPath, releasedPath);
    await unlink(join(releasedPath, "owner.json")).catch(() => {});
    await rmdir(releasedPath).catch(() => {});
  }
}

function validateIdentity({ orderId, fingerprint, runId }) {
  for (const [field, value] of Object.entries({ orderId, runId })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${field} is invalid`);
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(fingerprint ?? "")) {
    throw new Error("fingerprint is invalid");
  }
}

function evidenceKey({ orderId, fingerprint, runId }) {
  return lockName(`${orderId}:${runId}:${fingerprint}`);
}

function validateAdjudication(input) {
  requireExactKeys(input, [
    "schemaVersion",
    "decision",
    "ownerRunId",
    "orderId",
    "fingerprint",
    "stage",
    "targetRunId",
    "reasonCode",
    "actorId",
    "recordedAt",
  ], "human adjudication");
  validateIdentity({
    orderId: input.orderId,
    fingerprint: input.fingerprint,
    runId: input.ownerRunId,
  });
  if (input.schemaVersion !== 1 || !stages.has(input.stage)) {
    throw new Error("human adjudication schema or stage is invalid");
  }
  if (input.stage === "DONE") {
    throw new Error("human adjudication requires an unresolved non-DONE stage");
  }
  if (!/^[A-Za-z0-9._-]{3,128}$/u.test(input.actorId ?? "")) {
    throw new Error("human adjudication actorId is invalid");
  }
  if (typeof input.recordedAt !== "string" || new Date(input.recordedAt).toISOString() !== input.recordedAt) {
    throw new Error("human adjudication timestamp is invalid");
  }
  if (input.decision === "ABORT_RUN") {
    if (input.targetRunId !== null || input.reasonCode !== "HUMAN_ABORT_CONFIRMED") {
      throw new Error("human abort adjudication is invalid");
    }
  } else if (input.decision === "TRANSFER_RUN") {
    if (
      typeof input.targetRunId !== "string" ||
      input.targetRunId.length === 0 ||
      input.targetRunId === input.ownerRunId ||
      input.reasonCode !== "HUMAN_TRANSFER_CONFIRMED"
    ) {
      throw new Error("human transfer adjudication is invalid");
    }
  } else {
    throw new Error("human adjudication decision is invalid");
  }
}

export class RunEvidenceStore {
  constructor(applicationDataDirectory) {
    this.runResultDirectory = join(applicationDataDirectory, "evidence", "run-results");
    this.adjudicationDirectory = join(applicationDataDirectory, "evidence", "human-adjudications");
  }

  async persistRunResult(input) {
    requireExactKeys(input, ["orderId", "fingerprint", "result", "recordedAt"], "run-result evidence input");
    const { orderId, fingerprint, result, recordedAt } = input;
    if (typeof recordedAt !== "string" || new Date(recordedAt).toISOString() !== recordedAt) {
      throw new Error("run-result evidence timestamp is invalid");
    }
    const validated = createRunResult(result);
    validateIdentity({ orderId, fingerprint, runId: validated.runId });
    if (validated.orderFingerprint !== fingerprint) {
      throw new Error("terminal evidence fingerprint does not match RunResult");
    }
    const record = withIntegrity({
      schemaVersion: 1,
      orderId,
      fingerprint,
      ownerRunId: validated.runId,
      recordedAt,
      result: validated,
    });
    await mkdir(this.runResultDirectory, { recursive: true, mode: 0o700 });
    const path = join(
      this.runResultDirectory,
      `${lockName(`${evidenceKey({ orderId, fingerprint, runId: validated.runId })}:${validated.status}:${validated.stage}`)}.json`,
    );
    await createExclusive(path, record);
    return { path, record: structuredClone(record) };
  }

  async readRunResult(bindings, status = "DONE", stage = "DONE") {
    validateIdentity(bindings);
    const path = join(
      this.runResultDirectory,
      `${lockName(`${evidenceKey(bindings)}:${status}:${stage}`)}.json`,
    );
    let record;
    try {
      record = await readJson(path, "run-result evidence");
    } catch (error) {
      if (error.message.includes("ENOENT")) return null;
      throw error;
    }
    requireExactKeys(record, [
      "schemaVersion",
      "orderId",
      "fingerprint",
      "ownerRunId",
      "recordedAt",
      "result",
      "integritySha256",
    ], "run-result evidence");
    verifyIntegrity(record, "run-result evidence");
    if (
      record.schemaVersion !== 1 ||
      record.orderId !== bindings.orderId ||
      record.fingerprint !== bindings.fingerprint ||
      record.ownerRunId !== bindings.runId
    ) {
      throw new Error("run-result evidence binding mismatch");
    }
    if (new Date(record.recordedAt).toISOString() !== record.recordedAt) {
      throw new Error("run-result evidence timestamp is invalid");
    }
    record.result = createRunResult(record.result);
    if (record.result.status !== status || record.result.stage !== stage) {
      throw new Error("run-result evidence status binding mismatch");
    }
    return record;
  }

  async persistHumanAdjudication(input) {
    validateAdjudication(input);
    const record = withIntegrity(structuredClone(input));
    await mkdir(this.adjudicationDirectory, { recursive: true, mode: 0o700 });
    const key = `${evidenceKey({
      orderId: input.orderId,
      fingerprint: input.fingerprint,
      runId: input.ownerRunId,
    })}:${input.decision}:${input.targetRunId ?? "none"}`;
    const path = join(this.adjudicationDirectory, `${lockName(key)}.json`);
    await createExclusive(path, record);
    return { path, record: structuredClone(record) };
  }

  async readHumanAdjudication(bindings, decision, targetRunId = null) {
    validateIdentity(bindings);
    const key = `${evidenceKey(bindings)}:${decision}:${targetRunId ?? "none"}`;
    const path = join(this.adjudicationDirectory, `${lockName(key)}.json`);
    let record;
    try {
      record = await readJson(path, "human adjudication");
    } catch (error) {
      if (error.message.includes("ENOENT")) return null;
      throw error;
    }
    requireExactKeys(record, [
      "schemaVersion",
      "decision",
      "ownerRunId",
      "orderId",
      "fingerprint",
      "stage",
      "targetRunId",
      "reasonCode",
      "actorId",
      "recordedAt",
      "integritySha256",
    ], "human adjudication");
    verifyIntegrity(record, "human adjudication");
    const withoutIntegrity = { ...record };
    delete withoutIntegrity.integritySha256;
    validateAdjudication(withoutIntegrity);
    if (
      record.orderId !== bindings.orderId ||
      record.fingerprint !== bindings.fingerprint ||
      record.ownerRunId !== bindings.runId ||
      record.decision !== decision ||
      record.targetRunId !== targetRunId
    ) {
      throw new Error("human adjudication binding mismatch");
    }
    return record;
  }
}

function validateOrderRecord(record) {
  const base = ["schemaVersion", "orderId", "fingerprint", "ownerRunId", "resolution"];
  const keys = Object.hasOwn(record, "lastEvidenceKind") ? [...base, "lastEvidenceKind"] : base;
  requireExactKeys(record, keys, "order lock");
  validateIdentity({ orderId: record.orderId, fingerprint: record.fingerprint, runId: record.ownerRunId });
  if (record.schemaVersion !== 1 || record.resolution !== "UNRESOLVED") {
    throw new Error("order lock record is invalid");
  }
}

function validateProfileRecord(record) {
  requireExactKeys(record, [
    "schemaVersion",
    "profileId",
    "writerId",
    "runId",
    "orderId",
    "fingerprint",
    "nonce",
  ], "profile lock");
  validateIdentity({ orderId: record.orderId, fingerprint: record.fingerprint, runId: record.runId });
  if (record.schemaVersion !== 1 || typeof record.profileId !== "string" || typeof record.writerId !== "string") {
    throw new Error("profile lock record is invalid");
  }
}

function assertWriterProcessInactive(writerId) {
  const match = /^pid-([1-9][0-9]*)-[A-Za-z0-9._-]+$/u.exec(writerId);
  if (!match) throw new Error("stale profile writer liveness cannot be determined");
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) throw new Error("stale profile writer liveness cannot be determined");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw new Error("stale profile writer liveness cannot be determined");
  }
  throw new Error("stale profile writer is still active");
}

async function readCurrentOrderForAdjudication(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`order mutation post-state cannot be trusted: ${error.message}`);
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    throw new Error(`order mutation post-state cannot be trusted: ${error.message}`);
  }
  validateOrderRecord(record);
  return record;
}

async function terminalReleaseMatches(applicationDataDirectory, owner) {
  const path = join(
    applicationDataDirectory,
    "locks",
    "orders",
    "terminal-releases",
    `${lockName(`${owner.orderId}:${owner.runId}`)}.json`,
  );
  const record = validateTerminalReleaseRecord(await readJson(path, "terminal release"));
  if (
    record.schemaVersion !== 1 ||
    record.orderId !== owner.orderId ||
    record.ownerRunId !== owner.runId ||
    record.fingerprint !== owner.fingerprint
  ) throw new Error("terminal release binding mismatch");
  return true;
}

async function mutationObservation(applicationDataDirectory, owner) {
  const current = await readCurrentOrderForAdjudication(
    orderLockPath(applicationDataDirectory, owner.orderId),
  );
  if (current === null) {
    if (owner.operationCode !== "ORDER_RELEASE") {
      throw new Error("order mutation post-state cannot be trusted");
    }
    await terminalReleaseMatches(applicationDataDirectory, owner);
    return { stateCode: "TERMINAL_RELEASE", observedOwnerRunId: null };
  }
  if (current.orderId !== owner.orderId || current.fingerprint !== owner.fingerprint) {
    throw new Error("order mutation post-state binding mismatch");
  }
  if (current.ownerRunId === owner.runId) {
    return { stateCode: "SOURCE_OWNER", observedOwnerRunId: owner.runId };
  }
  if (
    owner.operationCode === "ORDER_TRANSFER" &&
    current.ownerRunId === owner.targetRunId &&
    current.lastEvidenceKind === "TRANSFER_ADJUDICATION"
  ) return { stateCode: "TRANSFER_TARGET", observedOwnerRunId: owner.targetRunId };
  throw new Error("order mutation post-state binding mismatch");
}

async function adjudicateOrderMutation(applicationDataDirectory, input) {
  requireExactKeys(input, [
    "expectedWriterId", "expectedOperationCode", "expectedTargetRunId",
    "runId", "orderId", "fingerprint", "actorId", "reasonCode", "recordedAt",
  ], "stale order mutation adjudication");
  validateIdentity(input);
  if (
    typeof input.expectedWriterId !== "string" ||
    !mutationOperationCodes.has(input.expectedOperationCode) ||
    (input.expectedOperationCode === "ORDER_TRANSFER"
      ? typeof input.expectedTargetRunId !== "string" || input.expectedTargetRunId.length === 0
      : input.expectedTargetRunId !== null) ||
    !/^[A-Za-z0-9._-]{3,128}$/u.test(input.actorId ?? "") ||
    input.reasonCode !== "HUMAN_STALE_ORDER_MUTATION_CONFIRMED" ||
    typeof input.recordedAt !== "string" ||
    new Date(input.recordedAt).toISOString() !== input.recordedAt
  ) throw new Error("stale order mutation adjudication is invalid");
  const mutationPath = `${orderLockPath(applicationDataDirectory, input.orderId)}.mutation`;
  const owner = await readOrderMutation(mutationPath);
  if (
    owner.writerId !== input.expectedWriterId ||
    owner.runId !== input.runId ||
    owner.orderId !== input.orderId ||
    owner.fingerprint !== input.fingerprint ||
    owner.operationCode !== input.expectedOperationCode ||
    owner.targetRunId !== input.expectedTargetRunId
  ) throw new Error("stale order mutation adjudication binding mismatch");
  assertWriterProcessInactive(owner.writerId);
  const observed = await mutationObservation(applicationDataDirectory, owner);
  const record = withIntegrity({
    schemaVersion: 1,
    expectedWriterId: owner.writerId,
    runId: owner.runId,
    orderId: owner.orderId,
    fingerprint: owner.fingerprint,
    operationCode: owner.operationCode,
    targetRunId: owner.targetRunId,
    mutationNonce: owner.nonce,
    observedStateCode: observed.stateCode,
    observedOwnerRunId: observed.observedOwnerRunId,
    actorId: input.actorId,
    reasonCode: input.reasonCode,
    recordedAt: input.recordedAt,
  });
  const directory = join(applicationDataDirectory, "evidence", "order-mutation-adjudications");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const adjudicationPath = join(directory, `${lockName(`${owner.writerId}:${owner.nonce}`)}.json`);
  try {
    await createExclusive(adjudicationPath, record);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readJson(adjudicationPath, "order mutation adjudication");
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error("order mutation adjudication cannot be trusted");
    }
  }
  const stillOwned = await readOrderMutation(mutationPath);
  const stillObserved = await mutationObservation(applicationDataDirectory, stillOwned);
  if (
    stillOwned.writerId !== owner.writerId ||
    stillOwned.nonce !== owner.nonce ||
    JSON.stringify(stillObserved) !== JSON.stringify(observed)
  ) throw new Error("order mutation ownership or post-state changed before adjudication");
  const adjudicatedPath = `${mutationPath}.adjudicated-${owner.nonce}`;
  await rename(mutationPath, adjudicatedPath);
  await unlink(join(adjudicatedPath, "owner.json")).catch(() => {});
  await rmdir(adjudicatedPath).catch(() => {});
  return { adjudicated: true, adjudicationPath, observedStateCode: observed.stateCode };
}

export class OrderLockStore {
  constructor(applicationDataDirectory) {
    this.root = applicationDataDirectory;
    this.directory = join(applicationDataDirectory, "locks", "orders");
    this.profileDirectory = join(applicationDataDirectory, "locks", "profiles");
    this.profileStopDirectory = join(applicationDataDirectory, "evidence", "profile-stops");
    this.evidence = new RunEvidenceStore(applicationDataDirectory);
  }

  pathFor(orderId) {
    return join(this.directory, `${lockName(orderId)}.json`);
  }

  async readOrder(path) {
    const record = await readJson(path, "order lock");
    validateOrderRecord(record);
    return record;
  }

  async acquire({ orderId, fingerprint, runId }) {
    validateIdentity({ orderId, fingerprint, runId });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(orderId);
    const record = {
      schemaVersion: 1,
      orderId,
      fingerprint,
      ownerRunId: runId,
      resolution: "UNRESOLVED",
    };
    try {
      await createExclusive(path, record);
      return { ...record, path, resumed: false };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const existing = await this.readOrder(path);
    if (
      existing.orderId === orderId &&
      existing.ownerRunId === runId &&
      existing.fingerprint === fingerprint
    ) {
      return { ...existing, path, resumed: true };
    }
    throw new Error(`unresolved order ${orderId} is owned by ${String(existing.ownerRunId)}`);
  }

  async withMutationLock(bindings, operationCode, targetRunId, operation) {
    return withOrderMutationLock(this.root, bindings, operationCode, targetRunId, operation);
  }

  async adjudicateStaleMutation(input) {
    return adjudicateOrderMutation(this.root, input);
  }

  async matchingProfileRecords(bindings) {
    let names = [];
    try {
      names = await readdir(this.profileDirectory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const matches = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const record = await readJson(join(this.profileDirectory, name), "profile lock");
      validateProfileRecord(record);
      if (
        record.runId === bindings.runId &&
        record.orderId === bindings.orderId &&
        record.fingerprint === bindings.fingerprint
      ) matches.push(record);
    }
    return matches;
  }

  async assertPriorWriterStopped(bindings) {
    if ((await this.matchingProfileRecords(bindings)).length > 0) {
      throw new Error("prior profile writer is still active");
    }
    let names = [];
    try {
      names = await readdir(this.profileStopDirectory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let matched = false;
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const record = await readJson(join(this.profileStopDirectory, name), "profile stop");
      validateProfileStopRecord(record);
      if (
        record.schemaVersion === 1 &&
        record.runId === bindings.runId &&
        record.orderId === bindings.orderId &&
        record.fingerprint === bindings.fingerprint &&
        new Set(["PROFILE_OWNER_RELEASED", "HUMAN_STALE_PROFILE_ADJUDICATED"]).has(record.stopReasonCode)
      ) matched = true;
    }
    if (!matched) throw new Error("prior profile writer stop proof is missing");
  }

  async transfer(input) {
    requireExactKeys(input, ["orderId", "fromRunId", "toRunId"], "order transfer request");
    if (typeof input.toRunId !== "string" || input.toRunId.length === 0 || input.toRunId === input.fromRunId) {
      throw new Error("order transfer target is invalid");
    }
    const path = this.pathFor(input.orderId);
    const prior = await this.readOrder(path);
    if (prior.ownerRunId !== input.fromRunId) throw new Error("order transfer owner mismatch");
    const bindings = { orderId: prior.orderId, fingerprint: prior.fingerprint, runId: prior.ownerRunId };
    return this.withMutationLock(bindings, "ORDER_TRANSFER", input.toRunId, async (lockedPath, existing) => {
      if (existing.ownerRunId !== input.fromRunId) throw new Error("order transfer owner mismatch");
      const adjudication = await this.evidence.readHumanAdjudication(
        bindings,
        "TRANSFER_RUN",
        input.toRunId,
      );
      if (!adjudication) throw new Error("persisted transfer adjudication is required");
      await this.assertPriorWriterStopped(bindings);
      const transferred = {
        ...existing,
        ownerRunId: input.toRunId,
        lastEvidenceKind: "TRANSFER_ADJUDICATION",
      };
      await replaceAtomically(lockedPath, transferred);
      return structuredClone(transferred);
    });
  }

  async release(input) {
    requireExactKeys(input, ["orderId", "runId"], "order release request");
    const path = this.pathFor(input.orderId);
    let prior;
    try {
      prior = await this.readOrder(path);
    } catch (error) {
      if (!error.message.includes("ENOENT")) throw error;
      const auditPath = join(
        this.directory,
        "terminal-releases",
        `${lockName(`${input.orderId}:${input.runId}`)}.json`,
      );
      const existing = validateTerminalReleaseRecord(await readJson(auditPath, "terminal release"));
      if (existing.orderId !== input.orderId || existing.ownerRunId !== input.runId) {
        throw new Error("terminal release binding mismatch");
      }
      return {
        released: true,
        idempotent: true,
        evidenceKind: existing.evidenceKind,
        auditPath,
      };
    }
    if (prior.ownerRunId !== input.runId) throw new Error("order release owner mismatch");
    const bindings = { orderId: prior.orderId, fingerprint: prior.fingerprint, runId: prior.ownerRunId };
    return this.withMutationLock(bindings, "ORDER_RELEASE", null, async (lockedPath, existing) => {
      if (existing.ownerRunId !== input.runId) throw new Error("order release owner mismatch");
      const bindings = {
        orderId: existing.orderId,
        fingerprint: existing.fingerprint,
        runId: existing.ownerRunId,
      };
      const resultEvidence = await this.evidence.readRunResult(bindings);
      const done =
        resultEvidence?.result.status === "DONE" &&
        resultEvidence.result.stage === "DONE" &&
        resultEvidence.result.writebackCheck.status === "PASSED" &&
        resultEvidence.result.finalCheck.status === "PASSED";
      const abort = await this.evidence.readHumanAdjudication(bindings, "ABORT_RUN", null);
      if (!done && !abort) {
        throw new Error("persisted terminal evidence or human abort adjudication is required");
      }
      await this.assertPriorWriterStopped(bindings);
      const evidenceKind = done ? "DONE_RUN_RESULT" : "HUMAN_ABORT_ADJUDICATION";
      const auditDirectory = join(this.directory, "terminal-releases");
      await mkdir(auditDirectory, { recursive: true, mode: 0o700 });
      const auditPath = join(auditDirectory, `${lockName(`${existing.orderId}:${existing.ownerRunId}`)}.json`);
      const auditRecord = withIntegrity({
        schemaVersion: 1,
        orderId: existing.orderId,
        fingerprint: existing.fingerprint,
        ownerRunId: existing.ownerRunId,
        stage: done ? "DONE" : abort.stage,
        evidenceKind,
        decision: done ? "TERMINAL_DONE" : abort.decision,
        recordedAt: done ? resultEvidence.recordedAt : abort.recordedAt,
      });
      const persistedAudit = await readOrCreateEvidence(
        auditPath,
        auditRecord,
        (record) => validateTerminalReleaseRecord(record, auditRecord),
        "terminal release",
      );
      const stillOwned = await this.readOrder(lockedPath);
      if (
        stillOwned.orderId !== existing.orderId ||
        stillOwned.ownerRunId !== existing.ownerRunId ||
        stillOwned.fingerprint !== existing.fingerprint
      ) throw new Error("order release owner changed before unlink");
      await unlink(lockedPath);
      return { released: true, idempotent: !persistedAudit.created, evidenceKind, auditPath };
    });
  }
}

export class ProfileLockStore {
  constructor(applicationDataDirectory) {
    this.root = applicationDataDirectory;
    this.directory = join(applicationDataDirectory, "locks", "profiles");
    this.stopDirectory = join(applicationDataDirectory, "evidence", "profile-stops");
  }

  async withMutationLock(bindings, operationCode, targetRunId, operation) {
    return withOrderMutationLock(this.root, bindings, operationCode, targetRunId, operation);
  }

  async adjudicateStaleMutation(input) {
    return adjudicateOrderMutation(this.root, input);
  }

  async completedStaleAdjudication(input) {
    const adjudicationDirectory = join(this.root, "evidence", "profile-adjudications");
    let names;
    try {
      names = await readdir(adjudicationDirectory);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("completed stale profile evidence is missing");
      throw error;
    }
    for (const name of names.filter((value) => value.endsWith(".json"))) {
      const adjudicationPath = join(adjudicationDirectory, name);
      const adjudication = validateProfileAdjudicationRecord(
        await readJson(adjudicationPath, "profile adjudication"),
      );
      if (
        adjudication.profileId !== input.profileId ||
        adjudication.expectedWriterId !== input.expectedWriterId ||
        adjudication.runId !== input.runId ||
        adjudication.orderId !== input.orderId ||
        adjudication.fingerprint !== input.fingerprint ||
        adjudication.actorId !== input.actorId ||
        adjudication.reasonCode !== input.reasonCode ||
        adjudication.recordedAt !== input.recordedAt
      ) continue;
      const stopReceiptPath = join(
        this.stopDirectory,
        `${lockName(`${input.profileId}:${adjudication.profileNonce}`)}.json`,
      );
      validateProfileStopRecord(
        await readJson(stopReceiptPath, "profile stop"),
        {
          profileId: input.profileId,
          profileNonce: adjudication.profileNonce,
          writerId: input.expectedWriterId,
          runId: input.runId,
          orderId: input.orderId,
          fingerprint: input.fingerprint,
          stopReasonCode: "HUMAN_STALE_PROFILE_ADJUDICATED",
          recordedAt: input.recordedAt,
        },
      );
      return { adjudicated: true, idempotent: true, adjudicationPath, stopReceiptPath };
    }
    throw new Error("completed stale profile evidence is missing or does not match");
  }

  async adjudicateStale(input) {
    requireExactKeys(input, [
      "profileId", "expectedWriterId", "runId", "orderId", "fingerprint",
      "actorId", "reasonCode", "recordedAt",
    ], "stale profile adjudication");
    validateIdentity(input);
    if (
      typeof input.profileId !== "string" || input.profileId.length === 0 ||
      typeof input.expectedWriterId !== "string" || input.expectedWriterId.length === 0 ||
      !/^[A-Za-z0-9._-]{3,128}$/u.test(input.actorId ?? "") ||
      input.reasonCode !== "HUMAN_STALE_PROFILE_CONFIRMED" ||
      typeof input.recordedAt !== "string" ||
      new Date(input.recordedAt).toISOString() !== input.recordedAt
    ) throw new Error("stale profile adjudication is invalid");
    return this.withMutationLock(input, "PROFILE_STALE_ADJUDICATE", null, async (orderPath, order) => {
      if (order.ownerRunId !== input.runId || order.fingerprint !== input.fingerprint) {
        throw new Error("stale profile adjudication does not match the unresolved order owner");
      }
      const profilePath = join(this.directory, `${lockName(input.profileId)}.json`);
      let profile;
      try {
        profile = await readJson(profilePath, "profile lock");
      } catch (error) {
        if (error.message.includes("ENOENT")) return this.completedStaleAdjudication(input);
        throw error;
      }
      validateProfileRecord(profile);
      if (
        profile.profileId !== input.profileId ||
        profile.writerId !== input.expectedWriterId ||
        profile.runId !== input.runId ||
        profile.orderId !== input.orderId ||
        profile.fingerprint !== input.fingerprint
      ) throw new Error("stale profile adjudication binding mismatch");
      assertWriterProcessInactive(profile.writerId);

      const adjudicationDirectory = join(this.root, "evidence", "profile-adjudications");
      await mkdir(adjudicationDirectory, { recursive: true, mode: 0o700 });
      const adjudicationPath = join(adjudicationDirectory, `${lockName(`${input.profileId}:${profile.nonce}`)}.json`);
      const adjudicationRecord = withIntegrity({
        schemaVersion: 1,
        profileId: input.profileId,
        profileNonce: profile.nonce,
        expectedWriterId: input.expectedWriterId,
        runId: input.runId,
        orderId: input.orderId,
        fingerprint: input.fingerprint,
        actorId: input.actorId,
        reasonCode: input.reasonCode,
        recordedAt: input.recordedAt,
      });
      const persistedAdjudication = await readOrCreateEvidence(
        adjudicationPath,
        adjudicationRecord,
        (record) => validateProfileAdjudicationRecord(record, adjudicationRecord),
        "profile adjudication",
      );
      await mkdir(this.stopDirectory, { recursive: true, mode: 0o700 });
      const stopReceiptPath = join(this.stopDirectory, `${lockName(`${input.profileId}:${profile.nonce}`)}.json`);
      const stopRecord = withIntegrity({
        schemaVersion: 1,
        profileId: input.profileId,
        profileNonce: profile.nonce,
        writerId: input.expectedWriterId,
        runId: input.runId,
        orderId: input.orderId,
        fingerprint: input.fingerprint,
        stopReasonCode: "HUMAN_STALE_PROFILE_ADJUDICATED",
        recordedAt: input.recordedAt,
      });
      const persistedStop = await readOrCreateEvidence(
        stopReceiptPath,
        stopRecord,
        (record) => validateProfileStopRecord(record, stopRecord),
        "profile stop",
      );
      const stillOwned = await readJson(profilePath, "profile lock");
      validateProfileRecord(stillOwned);
      if (
        stillOwned.profileId !== profile.profileId ||
        stillOwned.nonce !== profile.nonce ||
        stillOwned.writerId !== profile.writerId ||
        stillOwned.runId !== profile.runId ||
        stillOwned.orderId !== profile.orderId ||
        stillOwned.fingerprint !== profile.fingerprint
      ) throw new Error("stale profile ownership changed before unlink");
      await unlink(profilePath);
      return {
        adjudicated: true,
        idempotent: !persistedAdjudication.created || !persistedStop.created,
        adjudicationPath,
        stopReceiptPath,
      };
    });
  }

  async acquire(input) {
    requireExactKeys(input, ["profileId", "writerId", "runId", "orderId", "fingerprint"], "profile acquire request");
    validateIdentity(input);
    if (typeof input.profileId !== "string" || input.profileId.length === 0 || typeof input.writerId !== "string" || input.writerId.length === 0) {
      throw new Error("profile lock identity is invalid");
    }
    return this.withMutationLock(input, "PROFILE_ACQUIRE", null, async (currentOrderPath, orderRecord) => {
      if (orderRecord.ownerRunId !== input.runId || orderRecord.fingerprint !== input.fingerprint) {
        throw new Error("profile lock run does not match the unresolved order owner");
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, `${lockName(input.profileId)}.json`);
      const nonce = randomUUID();
      const record = {
        schemaVersion: 1,
        profileId: input.profileId,
        writerId: input.writerId,
        runId: input.runId,
        orderId: input.orderId,
        fingerprint: input.fingerprint,
        nonce,
      };
      try {
        await createExclusive(path, record);
      } catch (error) {
        if (error.code === "EEXIST") {
          const existing = await readJson(path, "profile lock");
          validateProfileRecord(existing);
          throw new Error(`profile ${input.profileId} is locked by ${String(existing.writerId)}`);
        }
        throw error;
      }
      let released = false;
      let releasedReceiptPath;
      const stopDirectory = this.stopDirectory;
      const profileStore = this;
      return {
        ...structuredClone(input),
        path,
        async release() {
          if (released) {
            return { released: true, idempotent: true, stopReceiptPath: releasedReceiptPath };
          }
          return profileStore.withMutationLock(input, "PROFILE_RELEASE", null, async (orderPath, currentOrder) => {
            if (currentOrder.ownerRunId !== input.runId || currentOrder.fingerprint !== input.fingerprint) {
              throw new Error("profile release no longer matches the unresolved order owner");
            }
            const existing = await readJson(path, "profile lock");
            validateProfileRecord(existing);
            if (existing.nonce !== nonce || existing.writerId !== input.writerId) {
              throw new Error("profile lock ownership changed before release");
            }
            await mkdir(stopDirectory, { recursive: true, mode: 0o700 });
            const recordedAt = new Date().toISOString();
            const stopReceiptPath = join(stopDirectory, `${lockName(`${input.profileId}:${nonce}`)}.json`);
            const stopRecord = withIntegrity({
              schemaVersion: 1,
              profileId: input.profileId,
              profileNonce: nonce,
              writerId: input.writerId,
              runId: input.runId,
              orderId: input.orderId,
              fingerprint: input.fingerprint,
              stopReasonCode: "PROFILE_OWNER_RELEASED",
              recordedAt,
            });
            const persistedStop = await readOrCreateEvidence(
              stopReceiptPath,
              stopRecord,
              (record) => validateProfileStopRecord(record, {
                ...stopRecord,
                recordedAt: undefined,
              }),
              "profile stop",
            );
            const stillOwned = await readJson(path, "profile lock");
            validateProfileRecord(stillOwned);
            if (
              stillOwned.profileId !== existing.profileId ||
              stillOwned.nonce !== existing.nonce ||
              stillOwned.writerId !== existing.writerId ||
              stillOwned.runId !== existing.runId ||
              stillOwned.orderId !== existing.orderId ||
              stillOwned.fingerprint !== existing.fingerprint
            ) throw new Error("profile lock ownership changed before unlink");
            await unlink(path);
            released = true;
            releasedReceiptPath = stopReceiptPath;
            return { released: true, idempotent: !persistedStop.created, stopReceiptPath };
          });
        },
      };
    });
  }
}
