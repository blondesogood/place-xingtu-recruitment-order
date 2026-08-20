import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeShanghaiCreatedAtRange } from "./manifest.mjs";
import { freezeRecruitmentBatch } from "./recruitment-domain.mjs";
import { deriveRecruitmentRunId } from "./run-identity.mjs";
import { computeRulesDigest } from "../validate-business-rules.mjs";
import { requireTrustedRules } from "./rules.mjs";
import { createRunResult, ERROR_CODES, TAKEOVER_STEP_CODES } from "./run-result.mjs";

const stateKeys = [
  "schemaVersion", "batchRunId", "rulesVersion", "rulesDigest", "range", "frozenOrders",
  "completedOrderIds", "takeoverOrderIds", "currentOrderId", "consecutiveBusinessError",
  "status", "pauseReasonCode", "orderOutcomes", "integritySha256",
];
const statuses = new Set(["RUNNING", "PAUSED", "COMPLETED", "NEEDS_HUMAN"]);

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

function withIntegrity(value) {
  const record = structuredClone(value);
  delete record.integritySha256;
  return {
    ...record,
    integritySha256: createHash("sha256").update(JSON.stringify(canonicalize(record))).digest("hex"),
  };
}

function validatePreSnapshotFailure(record, state) {
  if (
    record === null || typeof record !== "object" || Array.isArray(record) ||
    Object.keys(record).sort().join(",") !== "code,kind,orderId,orderType,rulesVersion,runId,status,takeoverSteps" ||
    record.kind !== "PRE_SNAPSHOT_FAILURE" ||
    record.orderType !== "RECRUITMENT" ||
    record.rulesVersion !== state.rulesVersion ||
    !new Set(["BLOCKED", "NEEDS_HUMAN"]).has(record.status) ||
    (record.status === "NEEDS_HUMAN" && !new Set(["FIELD_MISMATCH", "AMBIGUOUS_RESULT", "PUBLISH_TASK_AMBIGUOUS"]).has(record.code)) ||
    !ERROR_CODES.includes(record.code) ||
    !Array.isArray(record.takeoverSteps) || record.takeoverSteps.length === 0 ||
    record.takeoverSteps.some((step) => !TAKEOVER_STEP_CODES.includes(step)) ||
    deriveRecruitmentRunId(state.batchRunId, record.orderId) !== record.runId
  ) throw new Error("batch pre-snapshot outcome is invalid");
  return structuredClone(record);
}

function validateStoredOutcome(outcome, state) {
  if (outcome?.kind === "PRE_SNAPSHOT_FAILURE") return validatePreSnapshotFailure(outcome, state);
  if (
    outcome === null || typeof outcome !== "object" || Array.isArray(outcome) ||
    Object.keys(outcome).sort().join(",") !== "kind,orderId,result" ||
    outcome.kind !== "RUN_RESULT"
  ) throw new Error("batch order outcome shape is invalid");
  const result = createRunResult(outcome.result);
  if (
    result.schemaVersion !== 2 || result.orderType !== "RECRUITMENT" ||
    result.rulesVersion !== state.rulesVersion ||
    deriveRecruitmentRunId(state.batchRunId, outcome.orderId) !== result.runId
  ) throw new Error("batch RunResult outcome binding is invalid");
  return { kind: "RUN_RESULT", orderId: outcome.orderId, result };
}

function validate(state, rules) {
  if (state === null || typeof state !== "object" || Array.isArray(state)) throw new Error("batch state shape is invalid");
  if (Object.keys(state).sort().join(",") !== [...stateKeys].sort().join(",")) throw new Error("batch state shape contains an unknown or missing field");
  if (
    state.schemaVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(state.batchRunId ?? "") ||
    state.rulesVersion !== rules.rulesVersion ||
    state.rulesDigest !== computeRulesDigest(rules) ||
    !statuses.has(state.status) ||
    state.integritySha256 !== withIntegrity(state).integritySha256
  ) throw new Error("batch state cannot be trusted");
  if (state.range !== null && (typeof state.range !== "object" || Object.keys(state.range).sort().join(",") !== "endExclusive,start")) throw new Error("batch state range is invalid");
  if (!Array.isArray(state.frozenOrders) || !Array.isArray(state.completedOrderIds) || !Array.isArray(state.takeoverOrderIds) || !Array.isArray(state.orderOutcomes)) throw new Error("batch state order sets are invalid");
  const ids = state.frozenOrders.map((order) => order.orderId);
  if (new Set(ids).size !== ids.length || new Set(state.completedOrderIds).size !== state.completedOrderIds.length || new Set(state.takeoverOrderIds).size !== state.takeoverOrderIds.length) throw new Error("batch state order sets are invalid");
  for (const order of state.frozenOrders) {
    if (
      order === null || typeof order !== "object" ||
      Object.keys(order).sort().join(",") !== "createdAt,orderId,runId" ||
      deriveRecruitmentRunId(state.batchRunId, order.orderId) !== order.runId ||
      !(state.range === null ? (order.createdAt === null || Number.isFinite(Date.parse(order.createdAt))) : Number.isFinite(Date.parse(order.createdAt)))
    ) throw new Error("batch state frozen order is invalid");
  }
  if ([...state.completedOrderIds, ...state.takeoverOrderIds].some((id) => !ids.includes(id))) throw new Error("batch state outcome order is not frozen");
  if (state.completedOrderIds.some((id) => state.takeoverOrderIds.includes(id))) throw new Error("batch state outcome sets overlap");
  const outcomeOrderIds = state.orderOutcomes.map((outcome) => outcome.orderId);
  if (
    new Set(outcomeOrderIds).size !== outcomeOrderIds.length ||
    outcomeOrderIds.some((id) => !ids.includes(id))
  ) throw new Error("batch order outcomes are invalid");
  state.orderOutcomes = state.orderOutcomes.map((outcome) => validateStoredOutcome(outcome, state));
  if (state.currentOrderId !== null && !ids.includes(state.currentOrderId)) throw new Error("batch state current order is invalid");
  const streak = state.consecutiveBusinessError;
  if (
    streak === null || typeof streak !== "object" || Object.keys(streak).sort().join(",") !== "code,count" ||
    !((streak.code === null && streak.count === 0) || (/^[A-Z][A-Z0-9_]{2,127}$/u.test(streak.code ?? "") && Number.isSafeInteger(streak.count) && streak.count > 0))
  ) throw new Error("batch state business streak is invalid");
  if (
    (state.status === "PAUSED" && !/^[A-Z][A-Z0-9_]{2,127}$/u.test(state.pauseReasonCode ?? "")) ||
    (state.status !== "PAUSED" && state.pauseReasonCode !== null)
  ) throw new Error("batch state pause reason is invalid");
  return structuredClone(state);
}

function nextOrder(state) {
  const handled = new Set([...state.completedOrderIds, ...state.takeoverOrderIds]);
  return state.frozenOrders.find((order) => !handled.has(order.orderId))?.orderId ?? null;
}

export class RecruitmentBatchStore {
  constructor(applicationDataDirectory, rules) {
    this.rules = requireTrustedRules(rules);
    this.directory = join(applicationDataDirectory, "batches");
  }

  pathFor(batchRunId) {
    return join(this.directory, `${createHash("sha256").update(batchRunId).digest("hex")}.json`);
  }

  async read(batchRunId) {
    try {
      const state = validate(JSON.parse(await readFile(this.pathFor(batchRunId), "utf8")), this.rules);
      if (state.batchRunId !== batchRunId) throw new Error("batch state binding mismatch");
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error(`batch state cannot be trusted: ${error.message}`);
    }
  }

  async write(state) {
    const validated = validate(withIntegrity(state), this.rules);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(validated.batchRunId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    return validated;
  }

  async initialize(manifest, queriedOrders) {
    const existing = await this.read(manifest.batchRunId);
    if (existing) {
      if (existing.rulesVersion !== manifest.rulesVersion) throw new Error("batch state rules binding mismatch");
      if (Array.isArray(manifest.orderLocators)) {
        const expected = manifest.orderLocators.map(({ value }) => value);
        const actual = existing.frozenOrders.map(({ orderId }) => orderId);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error("batch state order locator binding mismatch");
        }
      }
      return existing;
    }
    const frozen = freezeRecruitmentBatch(manifest, queriedOrders, this.rules);
    const byId = new Map(queriedOrders.map((order) => [order.orderId, order]));
    const frozenOrders = frozen.frozenOrderIds.map((orderId) => ({
      orderId,
      createdAt: byId.get(orderId).createdAt,
      runId: deriveRecruitmentRunId(manifest.batchRunId, orderId),
    }));
    const state = {
      schemaVersion: 1,
      batchRunId: manifest.batchRunId,
      rulesVersion: manifest.rulesVersion,
      rulesDigest: computeRulesDigest(this.rules),
      range: Array.isArray(manifest.orderLocators)
        ? null
        : normalizeShanghaiCreatedAtRange(manifest.createdAtRange),
      frozenOrders,
      completedOrderIds: [],
      takeoverOrderIds: [],
      currentOrderId: frozenOrders[0]?.orderId ?? null,
      consecutiveBusinessError: { code: null, count: 0 },
      status: frozenOrders.length === 0 ? "NEEDS_HUMAN" : "RUNNING",
      pauseReasonCode: null,
      orderOutcomes: [],
    };
    return this.write(state);
  }

  async recordOutcome(batchRunId, outcome) {
    const state = await this.read(batchRunId);
    if (!state || state.status !== "RUNNING" || outcome?.orderId !== state.currentOrderId) throw new Error("batch outcome does not bind the current running order");
    if (!new Set(["SUCCESS", "BUSINESS_ERROR", "ORDER_TAKEOVER", "INFRASTRUCTURE_PAUSE", "LANDING_PAUSE"]).has(outcome.kind)) throw new Error("batch outcome kind is invalid");
    if (outcome.kind !== "SUCCESS" && !/^[A-Z][A-Z0-9_]{2,127}$/u.test(outcome.code ?? "")) throw new Error("batch outcome code is invalid");
    if (Object.hasOwn(outcome, "orderOutcome")) {
      const stored = validateStoredOutcome(outcome.orderOutcome, state);
      if (stored.orderId !== outcome.orderId) throw new Error("batch order outcome does not bind current order");
      const existingIndex = state.orderOutcomes.findIndex((item) => item.orderId === outcome.orderId);
      if (existingIndex === -1) state.orderOutcomes.push(stored);
      else state.orderOutcomes[existingIndex] = stored;
      const orderIndex = new Map(state.frozenOrders.map((item, index) => [item.orderId, index]));
      state.orderOutcomes.sort((left, right) => orderIndex.get(left.orderId) - orderIndex.get(right.orderId));
    }
    if (outcome.kind === "INFRASTRUCTURE_PAUSE" || outcome.kind === "LANDING_PAUSE") {
      state.status = "PAUSED";
      state.pauseReasonCode = outcome.code;
      return this.write(state);
    }
    if (outcome.kind === "SUCCESS") {
      state.completedOrderIds.push(outcome.orderId);
      state.consecutiveBusinessError = { code: null, count: 0 };
    } else {
      state.takeoverOrderIds.push(outcome.orderId);
      if (outcome.kind === "BUSINESS_ERROR") {
        const prior = state.consecutiveBusinessError;
        const count = prior.code === outcome.code ? prior.count + 1 : 1;
        state.consecutiveBusinessError = { code: outcome.code, count };
        if (count >= this.rules.recruitment.sameBusinessErrorThreshold) {
          state.status = "PAUSED";
          state.pauseReasonCode = outcome.code;
          state.currentOrderId = nextOrder(state);
        }
      } else {
        state.consecutiveBusinessError = { code: null, count: 0 };
      }
    }
    if (state.status === "RUNNING") {
      state.currentOrderId = nextOrder(state);
      if (state.currentOrderId === null) state.status = "COMPLETED";
    }
    return this.write(state);
  }

  async resumePaused(batchRunId, request) {
    const state = await this.read(batchRunId);
    const isBusinessFuse = state?.consecutiveBusinessError.count >= this.rules.recruitment.sameBusinessErrorThreshold;
    const requiredKeys = isBusinessFuse
      ? "actorId,code,decision,orderId,recordedAt"
      : "code,orderId";
    if (
      request === null || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== requiredKeys
    ) throw new Error("batch resume requires exact human authority for a business fuse");
    if (isBusinessFuse && (
      request.decision !== "RESUME_BUSINESS_FUSE" ||
      !/^[A-Za-z0-9._-]{3,128}$/u.test(request.actorId ?? "") ||
      typeof request.recordedAt !== "string" ||
      new Date(request.recordedAt).toISOString() !== request.recordedAt
    )) throw new Error("batch resume human authority is invalid");
    if (
      !state || state.status !== "PAUSED" ||
      request.orderId !== state.currentOrderId ||
      request.code !== state.pauseReasonCode
    ) throw new Error("batch resume does not match the paused current order and reason");
    state.status = state.currentOrderId === null ? "COMPLETED" : "RUNNING";
    state.pauseReasonCode = null;
    return this.write(state);
  }
}
