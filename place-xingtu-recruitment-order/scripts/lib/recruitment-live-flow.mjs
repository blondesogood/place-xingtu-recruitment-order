import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createActionIntent } from "./action-policy.mjs";
import { EscalationStore } from "./escalation-store.mjs";
import { ActiveOperationStore } from "./active-operation-store.mjs";
import { OrderLockStore } from "./locks.mjs";
import {
  normalizeRecruitmentTargetScope,
  normalizeShanghaiCreatedAtRange,
  parseRecruitmentBatchManifest,
} from "./manifest.mjs";
import { createOrderSnapshot } from "./order-snapshot.mjs";
import { RecruitmentBatchStore } from "./recruitment-batch-store.mjs";
import { RecruitmentBindingStore } from "./recruitment-binding-store.mjs";
import { RecruitmentBudgetStore } from "./recruitment-budget-store.mjs";
import { RecruitmentDateDiscoveryStore } from "./recruitment-date-discovery.mjs";
import { deriveRecruitmentDeliveryDeadline } from "./recruitment-deadline.mjs";
import { RecruitmentOrchestrator } from "./recruitment-orchestrator.mjs";
import { RecruitmentRuntimeBindingStore } from "./recruitment-runtime-binding-store.mjs";
import { createRecruitmentFinalObservation } from "./run-result.mjs";
import { deriveRecruitmentRunId } from "./run-identity.mjs";
import { RunStateStore } from "./run-state.mjs";

const MAX_DELTA_SWEEPS = 3;

function clone(value) {
  return structuredClone(value);
}

function frozen(value) {
  return Object.freeze(clone(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => key !== "integritySha256")
      .sort()
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalExact(value) {
  if (Array.isArray(value)) return value.map(canonicalExact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .sort()
      .map((key) => [key, canonicalExact(value[key])]));
  }
  return value;
}

function integrity(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function expectedFilters(uiContract) {
  const value = uiContract?.pages?.internalOrders?.effectiveFilters;
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "createdAt,match,platform,status,taskType" ||
    value.match !== "EXACT"
  ) throw new Error("trusted exact recruitment filters are required");
  return frozen(value);
}

function exactObject(actual, expected, label) {
  if (
    actual === null || typeof actual !== "object" || Array.isArray(actual) ||
    JSON.stringify(canonicalExact(actual)) !== JSON.stringify(canonicalExact(expected))
  ) throw new Error(`${label} is not an exact match`);
  return frozen(actual);
}

function initialRunState(runId, snapshot) {
  return {
    schemaVersion: 2,
    runId,
    orderType: "RECRUITMENT",
    stage: "ORDER_LOCKED",
    orderSnapshot: snapshot,
    verifiedTaskId: null,
    landingPage: null,
    writebackEvidenceHash: null,
    pendingAction: null,
    finalObservation: null,
  };
}

function waveBatchRunId(batchRunId, ordinal) {
  return ordinal === 0 ? batchRunId : `${batchRunId}-delta-${ordinal}`;
}

function waveManifest(manifest, wave) {
  return { ...clone(manifest), batchRunId: wave.waveBatchRunId };
}

function validateOrders(value, targetScope) {
  if (!Array.isArray(value)) throw new Error("matching recruitment orders must be an array");
  const seen = new Set();
  return value.map((order) => {
    const expectedKeys = targetScope.creatorId === null ? "createdAt,orderId" : "createdAt,creatorId,orderId";
    if (
      order === null || typeof order !== "object" || Array.isArray(order) ||
      Object.keys(order).sort().join(",") !== expectedKeys ||
      typeof order.orderId !== "string" || order.orderId.length === 0 ||
      typeof order.createdAt !== "string" || !Number.isFinite(Date.parse(order.createdAt)) ||
      (targetScope.creatorId !== null && order.creatorId !== targetScope.creatorId) ||
      seen.has(order.orderId)
    ) throw new Error("matching recruitment order evidence is invalid");
    seen.add(order.orderId);
    return { orderId: order.orderId, createdAt: order.createdAt };
  }).sort((left, right) => (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.orderId.localeCompare(right.orderId)
  ));
}

function validateSweepState(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "batchRunId,completedOrderIds,deltaSweeps,finalZeroVerified,historicalOrderStatuses,integritySha256,range,remainingOrderCount,rulesVersion,schemaVersion,status,targetScope,waves" ||
    value.schemaVersion !== 1 ||
    typeof value.batchRunId !== "string" || value.batchRunId.length < 3 ||
    typeof value.rulesVersion !== "string" ||
    !new Set(["RUNNING", "COMPLETED", "BLOCKED"]).has(value.status) ||
    !Number.isSafeInteger(value.deltaSweeps) || value.deltaSweeps < 0 || value.deltaSweeps > MAX_DELTA_SWEEPS ||
    typeof value.finalZeroVerified !== "boolean" ||
    !(value.remainingOrderCount === null || (Number.isSafeInteger(value.remainingOrderCount) && value.remainingOrderCount >= 0)) ||
    !Array.isArray(value.completedOrderIds) || new Set(value.completedOrderIds).size !== value.completedOrderIds.length ||
    !Array.isArray(value.historicalOrderStatuses) || value.historicalOrderStatuses.some((entry) => (
      entry === null || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "orderId,status" ||
      typeof entry.orderId !== "string" || entry.orderId.length === 0 ||
      typeof entry.status !== "string" || entry.status.length === 0
    )) ||
    !Array.isArray(value.waves) ||
    value.range === null || typeof value.range !== "object" || Array.isArray(value.range) ||
    Object.keys(value.range).sort().join(",") !== "endExclusive,start" ||
    value.targetScope === null || typeof value.targetScope !== "object" || Array.isArray(value.targetScope) ||
    Object.keys(value.targetScope).sort().join(",") !== "creatorId,maxOrders" ||
    !(value.targetScope.creatorId === null || (typeof value.targetScope.creatorId === "string" && value.targetScope.creatorId.length > 0)) ||
    !(
      value.targetScope.maxOrders === null ||
      (Number.isSafeInteger(value.targetScope.maxOrders) && value.targetScope.maxOrders > 0)
    ) ||
    ![value.range.start, value.range.endExclusive].every((entry) => typeof entry === "string") ||
    value.integritySha256 !== integrity(value)
  ) throw new Error("recruitment sweep state cannot be trusted");
  const all = [];
  for (const [index, wave] of value.waves.entries()) {
    if (wave === null || typeof wave !== "object" || Array.isArray(wave)) {
      throw new Error("recruitment sweep wave must be an object");
    }
    if (Object.keys(wave).sort().join(",") !== "orders,ordinal,waveBatchRunId") {
      throw new Error("recruitment sweep wave shape cannot be trusted");
    }
    if (wave.ordinal !== index || wave.waveBatchRunId !== waveBatchRunId(value.batchRunId, index)) {
      throw new Error("recruitment sweep wave identity cannot be trusted");
    }
    if (!Array.isArray(wave.orders) || wave.orders.length === 0 || wave.orders.some((order) => (
      order === null || typeof order !== "object" || Array.isArray(order) ||
      Object.keys(order).sort().join(",") !== "createdAt,orderId" ||
      typeof order.orderId !== "string" || order.orderId.length === 0 ||
      typeof order.createdAt !== "string" || !Number.isFinite(Date.parse(order.createdAt))
    ))) throw new Error("recruitment sweep frozen orders cannot be trusted");
    all.push(...wave.orders.map(({ orderId }) => orderId));
  }
  if (new Set(all).size !== all.length || value.completedOrderIds.some((id) => !all.includes(id))) {
    throw new Error("recruitment sweep order binding cannot be trusted");
  }
  if (value.status === "COMPLETED") {
    const limited = value.targetScope.maxOrders !== null;
    if (!limited && (!value.finalZeroVerified || value.remainingOrderCount !== 0)) {
      throw new Error("recruitment sweep completion evidence is invalid");
    }
  } else if (value.finalZeroVerified || value.remainingOrderCount !== null) {
    throw new Error("unfinished recruitment sweep cannot claim completion evidence");
  }
  return clone(value);
}

export class RecruitmentSweepStore {
  constructor(applicationDataDirectory) {
    this.directory = join(applicationDataDirectory, "recruitment-sweeps");
  }

  pathFor(batchRunId) {
    return join(this.directory, `${createHash("sha256").update(batchRunId).digest("hex")}.json`);
  }

  async read(batchRunId) {
    try {
      const state = validateSweepState(JSON.parse(await readFile(this.pathFor(batchRunId), "utf8")));
      if (state.batchRunId !== batchRunId) throw new Error("recruitment sweep binding mismatch");
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value) {
    const state = validateSweepState({ ...clone(value), integritySha256: integrity(value) });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(state.batchRunId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    return state;
  }

  async initialize(manifest) {
    const existing = await this.read(manifest.batchRunId);
    if (existing) {
      if (existing.rulesVersion !== manifest.rulesVersion) throw new Error("recruitment sweep rules binding mismatch");
      const range = normalizeShanghaiCreatedAtRange(manifest.createdAtRange);
      const targetScope = normalizeRecruitmentTargetScope(manifest.targetScope);
      if (JSON.stringify(existing.range) !== JSON.stringify(range)) {
        throw new Error("recruitment sweep range binding mismatch");
      }
      if (JSON.stringify(existing.targetScope) !== JSON.stringify(targetScope)) {
        throw new Error("recruitment sweep target scope binding mismatch");
      }
      return existing;
    }
    return this.write({
      schemaVersion: 1,
      batchRunId: manifest.batchRunId,
      rulesVersion: manifest.rulesVersion,
      range: normalizeShanghaiCreatedAtRange(manifest.createdAtRange),
      targetScope: normalizeRecruitmentTargetScope(manifest.targetScope),
      waves: [],
      completedOrderIds: [],
      historicalOrderStatuses: [],
      deltaSweeps: 0,
      finalZeroVerified: false,
      remainingOrderCount: null,
      status: "RUNNING",
    });
  }

  async addWave(batchRunId, orders, { delta }) {
    const state = await this.read(batchRunId);
    if (!state || state.status !== "RUNNING") throw new Error("recruitment sweep is not running");
    const existing = new Set(state.waves.flatMap(({ orders: frozenOrders }) => (
      frozenOrders.map(({ orderId }) => orderId)
    )));
    if (orders.some(({ orderId }) => existing.has(orderId))) {
      state.status = "BLOCKED";
      return this.write(state);
    }
    const ordinal = state.waves.length;
    if (delta) state.deltaSweeps += 1;
    state.waves.push({
      ordinal,
      waveBatchRunId: waveBatchRunId(batchRunId, ordinal),
      orders: orders.map(({ orderId, createdAt }) => ({ orderId, createdAt })),
    });
    return this.write(state);
  }

  async recordCompleted(batchRunId, orderId) {
    const state = await this.read(batchRunId);
    const all = state.waves.flatMap(({ orders }) => orders.map(({ orderId: id }) => id));
    if (!all.includes(orderId)) throw new Error("completed recruitment order was not frozen");
    if (!state.completedOrderIds.includes(orderId)) state.completedOrderIds.push(orderId);
    return this.write(state);
  }

  async recordZero(batchRunId) {
    const state = await this.read(batchRunId);
    state.finalZeroVerified = true;
    state.remainingOrderCount = 0;
    state.status = "COMPLETED";
    return this.write(state);
  }

  async recordLimitedComplete(batchRunId, remainingOrderCount = null) {
    const state = await this.read(batchRunId);
    if (
      state.targetScope.maxOrders === null ||
      !(remainingOrderCount === null || (Number.isSafeInteger(remainingOrderCount) && remainingOrderCount >= 0))
    ) {
      throw new Error("limited recruitment completion evidence is invalid");
    }
    state.remainingOrderCount = remainingOrderCount;
    state.status = "COMPLETED";
    return this.write(state);
  }

  async recordHistoricalComplete(batchRunId, historicalOrderStatuses) {
    const state = await this.read(batchRunId);
    if (state.targetScope.creatorId === null || !Array.isArray(historicalOrderStatuses)) {
      throw new Error("historical recruitment completion evidence is invalid");
    }
    state.historicalOrderStatuses = structuredClone(historicalOrderStatuses);
    state.finalZeroVerified = true;
    state.remainingOrderCount = 0;
    state.status = "COMPLETED";
    return this.write(state);
  }

  async block(batchRunId) {
    const state = await this.read(batchRunId);
    state.status = "BLOCKED";
    return this.write(state);
  }
}

export class RecruitmentDeliveryStore {
  constructor(applicationDataDirectory) {
    this.directory = join(applicationDataDirectory, "recruitment-deliveries");
  }

  pathFor(runId) {
    return join(this.directory, `${createHash("sha256").update(runId).digest("hex")}.json`);
  }

  #validate(value) {
    if (
      value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "activityId,creatorId,deliveryDeadline,deliveryId,integritySha256,orderId,priceMinorUnits,runId,schemaVersion" ||
      value.schemaVersion !== 1 ||
      !["runId", "orderId", "activityId", "creatorId", "deliveryId"].every((key) => (
        typeof value[key] === "string" && value[key].length > 0
      )) ||
      !Number.isSafeInteger(value.priceMinorUnits) || value.priceMinorUnits < 0 ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(value.deliveryDeadline) ||
      value.integritySha256 !== integrity(value)
    ) throw new Error("recruitment delivery evidence cannot be trusted");
    return clone(value);
  }

  async read(runId) {
    try {
      const value = this.#validate(JSON.parse(await readFile(this.pathFor(runId), "utf8")));
      if (value.runId !== runId) throw new Error("recruitment delivery evidence run binding mismatch");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value) {
    const record = this.#validate({ ...clone(value), integritySha256: integrity(value) });
    const existing = await this.read(record.runId);
    if (existing && JSON.stringify(canonical(existing)) !== JSON.stringify(canonical(record))) {
      throw new Error("recruitment delivery evidence is immutable");
    }
    if (existing) return existing;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(record.runId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    return record;
  }
}

export function createLocalRecruitmentStores({
  applicationDataDirectory,
  rules,
  consumeConfirmation,
  recovery,
}) {
  if (typeof consumeConfirmation !== "function") {
    throw new Error("local recruitment stores require action-time confirmation consumption");
  }
  const runStates = new RunStateStore(applicationDataDirectory, rules);
  const orderLocks = new OrderLockStore(applicationDataDirectory);
  if (recovery !== undefined && (
    typeof recovery?.read !== "function" || typeof recovery?.plan !== "function"
  )) throw new Error("local recruitment recovery dependency is invalid");
  return Object.freeze({
    sweeps: new RecruitmentSweepStore(applicationDataDirectory),
    dateDiscovery: new RecruitmentDateDiscoveryStore(applicationDataDirectory),
    deliveries: new RecruitmentDeliveryStore(applicationDataDirectory),
    bindings: new RecruitmentBindingStore(applicationDataDirectory),
    batchFor: () => new RecruitmentBatchStore(applicationDataDirectory, rules),
    runStates,
    orderLocks,
    ...(rules.recruitment?.budgetTopUp
      ? { budgets: new RecruitmentBudgetStore(applicationDataDirectory, rules) }
      : {}),
    escalations: new EscalationStore(applicationDataDirectory),
    activeOperations: new ActiveOperationStore(applicationDataDirectory),
    runtimeBindings: new RecruitmentRuntimeBindingStore(applicationDataDirectory),
    confirmations: { consume: consumeConfirmation },
    ...(recovery === undefined ? {} : { recovery }),
    mutations: {
      async runExclusive(binding, task) {
        return runStates.runExclusive(binding.runId, task);
      },
    },
    runIdFor: deriveRecruitmentRunId,
  });
}

export function createScriptedRecruitmentFlowAdapter(scriptedAdapter) {
  if (typeof scriptedAdapter?.readEvidence !== "function") {
    throw new Error("scripted recruitment flow requires the production evidence adapter");
  }
  const read = (operation, input, controls = {}) => scriptedAdapter.readEvidence(operation, input, controls);
  return Object.freeze({
    ensureInternalBusinessRole: () => read("ENSURE_INTERNAL_BUSINESS_ROLE", {}),
    verifyBatchFilters: (filters, discoveryMode = "FILTER_FIRST") => (
      read("VERIFY_BATCH_FILTERS", { filters, discoveryMode })
    ),
    readMatchingOrders: (filters, targetScope, discoveryMode = "FILTER_FIRST") => (
      read("READ_MATCHING_ORDERS", { filters, targetScope, discoveryMode })
    ),
    readOrdersById: (orderLocators) => read("READ_ORDERS_BY_ID", { orderIds: orderLocators.map(({ value }) => value) }),
    readHistoricalOrderStatuses: (filters, targetScope) => read("READ_HISTORICAL_ORDER_STATUS", { filters, targetScope }),
    readOrder: ({ orderId }) => read("READ_ORDER_SNAPSHOT", { orderId }),
    openExactActivityCreator: (binding) => read("OPEN_CREATOR_ORDER", binding),
    prepareRecruitmentDraft: (binding) => read("PREPARE_RECRUITMENT_DRAFT", binding),
    lookupExactDeliveries: (binding) => read("REREAD_RECRUITMENT_TASK", { ...binding, lookup: true }),
    commitDeliveryDeadline: (binding) => read("COMMIT_RECRUITMENT_DEADLINE", binding),
    rereadRecruitmentDraft: (binding) => read("REREAD_RECRUITMENT_DRAFT", binding),
    submitRecruitmentOrder: (binding, controls) => read("SUBMIT_RECRUITMENT_ORDER", binding, controls),
    readRecruitmentSubmitResult: (binding) => read("READ_RECRUITMENT_SUBMIT_RESULT", binding),
    readRecruitmentBudget: (binding) => read("READ_RECRUITMENT_BUDGET", binding),
    topUpRecruitmentBudget: (binding, controls) => read("TOP_UP_RECRUITMENT_BUDGET", binding, controls),
    rereadRecruitmentBudget: (binding) => read("REREAD_RECRUITMENT_BUDGET", binding),
    reopenExactDelivery: (binding) => read("REREAD_RECRUITMENT_TASK", { ...binding, lookup: false }),
    prepareInternalWriteback: (binding) => read("PREPARE_INTERNAL_WRITEBACK", binding),
    rereadInternalWriteback: (binding) => read("REREAD_INTERNAL_WRITEBACK", binding),
    confirmInternalOrder: (binding, controls) => read("CONFIRM_INTERNAL_ORDER", binding, controls),
    rereadInternalFinalState: (binding) => read("REREAD_INTERNAL_FINAL_STATE", binding),
  });
}

function writebackHash({ snapshot, deliveryId, activityId, advertiserId }) {
  return createHash("sha256").update(JSON.stringify({
    advertiserId,
    orderFingerprint: snapshot.fingerprint,
    verifiedTaskId: deliveryId,
    writebackTaskId: activityId,
  })).digest("hex");
}

function activityBindingDigest({ activityId, creatorId, priceMinorUnits }) {
  return createHash("sha256").update(JSON.stringify({
    activityId,
    creatorId,
    priceMinorUnits,
  })).digest("hex");
}

function exactDelivery(value, binding) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "activityId,creatorId,deliveryDeadline,deliveryId,priceMinorUnits" ||
    value.activityId !== binding.activityId ||
    value.creatorId !== binding.creatorId ||
    value.priceMinorUnits !== binding.priceMinorUnits ||
    typeof value.deliveryId !== "string" || value.deliveryId.length === 0 ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value.deliveryDeadline)
  ) throw new Error("persisted recruitment delivery binding is invalid");
  return clone(value);
}

function exactBudget(value, binding) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "activityId,consumedBudgetMinorUnits,totalBudgetMinorUnits" ||
    value.activityId !== binding.activityId ||
    !Number.isSafeInteger(value.totalBudgetMinorUnits) ||
    !Number.isSafeInteger(value.consumedBudgetMinorUnits) ||
    value.totalBudgetMinorUnits < 0 ||
    value.consumedBudgetMinorUnits < 0 ||
    value.consumedBudgetMinorUnits > value.totalBudgetMinorUnits
  ) throw new Error("recruitment budget evidence is invalid");
  return frozen(value);
}

function exactSubmitResult(value, binding) {
  if (value?.kind === "BUDGET_INSUFFICIENT" || value?.kind === "UNKNOWN") {
    if (Object.keys(value).sort().join(",") !== "kind") {
      throw new Error("recruitment submit result shape is invalid");
    }
    return frozen(value);
  }
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "delivery,kind" ||
    value.kind !== "DELIVERY_OBSERVED"
  ) throw new Error("recruitment submit result is invalid");
  return frozen({ kind: value.kind, delivery: exactDelivery(value.delivery, binding) });
}

export class RecruitmentLiveFlow {
  constructor({ rules, uiContract, stores, adapter, clock }) {
    if (
      !new Set(["2026-08-13-r1", "2026-08-17-r1"]).has(rules?.rulesVersion) ||
      typeof stores?.sweeps?.initialize !== "function" ||
      typeof stores?.dateDiscovery?.initialize !== "function" ||
      typeof stores?.batchFor !== "function" ||
      typeof stores?.deliveries?.read !== "function" ||
      typeof stores?.bindings?.read !== "function" ||
      typeof stores?.runStates?.read !== "function" ||
      typeof stores?.orderLocks?.acquire !== "function" ||
      typeof adapter?.verifyBatchFilters !== "function" ||
      typeof adapter?.readMatchingOrders !== "function" ||
      typeof adapter?.readHistoricalOrderStatuses !== "function" ||
      typeof adapter?.lookupExactDeliveries !== "function" ||
      (rules?.rulesVersion === "2026-08-17-r1" && (
        typeof stores?.budgets?.checkAllowed !== "function" ||
        typeof adapter?.ensureInternalBusinessRole !== "function" ||
        typeof adapter?.readRecruitmentSubmitResult !== "function" ||
        typeof adapter?.readRecruitmentBudget !== "function" ||
        typeof adapter?.topUpRecruitmentBudget !== "function" ||
        typeof adapter?.rereadRecruitmentBudget !== "function"
      )) ||
      typeof clock !== "function"
    ) throw new Error("recruitment live flow dependencies are invalid");
    this.rules = rules;
    this.uiContract = uiContract;
    this.filters = expectedFilters(uiContract);
    this.stores = stores;
    this.adapter = adapter;
    this.clock = clock;
  }

  async #query(manifest) {
    const targetScope = normalizeRecruitmentTargetScope(manifest.targetScope);
    const range = normalizeShanghaiCreatedAtRange(manifest.createdAtRange);
    const filters = {
      ...clone(this.filters),
      createdAt: {
        label: this.filters.createdAt,
        start: range.start,
        endExclusive: range.endExclusive,
      },
    };
    if (this.rules.rulesVersion === "2026-08-17-r1") {
      exactObject(await this.adapter.ensureInternalBusinessRole(), {
        role: this.uiContract.actions.ensureInternalBusinessRole.requiredRole,
        verified: true,
      }, "internal business role");
    }
    let discovery = await this.stores.dateDiscovery.initialize(manifest);
    const query = async (mode) => {
      exactObject(
        await this.adapter.verifyBatchFilters(filters, mode),
        filters,
        "effective recruitment filters",
      );
      return validateOrders(
        await this.adapter.readMatchingOrders(filters, targetScope, mode),
        targetScope,
      );
    };
    let orders = await query(discovery.currentMode);
    if (
      discovery.currentMode === "TABLE_FIRST" &&
      targetScope.maxOrders !== null && orders.length < targetScope.maxOrders
    ) {
      discovery = await this.stores.dateDiscovery.fallback(
        manifest.batchRunId,
        "INSUFFICIENT_VISIBLE_MATCHES",
      );
      orders = await query(discovery.currentMode);
    }
    if (orders.length === 0 && discovery.currentMode === "FILTER_FIRST" && this.rules.rulesVersion === "2026-08-17-r1") {
      exactObject(await this.adapter.ensureInternalBusinessRole(), {
        role: this.uiContract.actions.ensureInternalBusinessRole.requiredRole,
        verified: true,
      }, "empty-list business role recheck");
      orders = await query("FILTER_FIRST");
    }
    await this.stores.dateDiscovery.complete(manifest.batchRunId);
    return orders;
  }

  async #queryDirect(manifest) {
    if (typeof this.adapter.readOrdersById !== "function") {
      throw new Error("direct recruitment order lookup is not composed");
    }
    if (this.rules.rulesVersion === "2026-08-17-r1") {
      exactObject(await this.adapter.ensureInternalBusinessRole(), {
        role: this.uiContract.actions.ensureInternalBusinessRole.requiredRole,
        verified: true,
      }, "internal business role");
    }
    const expected = manifest.orderLocators.map(({ value }) => value);
    const value = await this.adapter.readOrdersById(manifest.orderLocators);
    if (!Array.isArray(value) || value.length !== expected.length) {
      throw new Error("direct recruitment order evidence is incomplete");
    }
    return value.map((order, index) => {
      if (
        order === null || typeof order !== "object" || Array.isArray(order) ||
        Object.keys(order).sort().join(",") !== "createdAt,orderId" ||
        order.orderId !== expected[index] ||
        !(order.createdAt === null || (typeof order.createdAt === "string" && Number.isFinite(Date.parse(order.createdAt))))
      ) throw new Error("direct recruitment order evidence is invalid");
      return { orderId: order.orderId, createdAt: order.createdAt };
    });
  }

  async #runDirect(manifest) {
    const batchStore = this.stores.batchFor(manifest);
    let batch = await batchStore.read(manifest.batchRunId);
    if (!batch) {
      const orders = await this.#queryDirect(manifest);
      batch = await batchStore.initialize(manifest, orders);
    } else {
      batch = await batchStore.initialize(manifest, batch.frozenOrders.map(({ orderId, createdAt }) => ({ orderId, createdAt })));
    }
    while (batch.status === "RUNNING") {
      const orderId = batch.currentOrderId;
      const frozenOrder = batch.frozenOrders.find((order) => order.orderId === orderId);
      const result = frozenOrder.createdAt === null
        ? frozen({ kind: "BUSINESS_ERROR", reasonCode: "ORDER_NOT_FOUND" })
        : await this.#processOrder(manifest, orderId);
      if (result.kind === "COMPLETED") {
        batch = await batchStore.recordOutcome(manifest.batchRunId, { orderId, kind: "SUCCESS" });
      } else if (result.kind === "BUSINESS_ERROR") {
        batch = await batchStore.recordOutcome(manifest.batchRunId, {
          orderId, kind: "BUSINESS_ERROR", code: result.reasonCode,
        });
      } else {
        return frozen({ ...result, batchRunId: manifest.batchRunId });
      }
    }
    if (batch.status === "PAUSED") return frozen({
      kind: "BLOCKED",
      batchRunId: manifest.batchRunId,
      reasonCode: batch.pauseReasonCode,
      currentOrderId: batch.currentOrderId,
    });
    return frozen({
      kind: "COMPLETED",
      batchRunId: manifest.batchRunId,
      completedOrderIds: batch.completedOrderIds,
      deltaSweeps: 0,
      ...(batch.takeoverOrderIds.length > 0 ? { skippedOrderIds: batch.takeoverOrderIds } : {}),
    });
  }

  async #queryHistorical(manifest) {
    const targetScope = normalizeRecruitmentTargetScope(manifest.targetScope);
    if (targetScope.creatorId === null) return [];
    const range = normalizeShanghaiCreatedAtRange(manifest.createdAtRange);
    const filters = {
      ...clone(this.filters),
      createdAt: { label: this.filters.createdAt, start: range.start, endExclusive: range.endExclusive },
    };
    const result = await this.adapter.readHistoricalOrderStatuses(filters, targetScope);
    if (!Array.isArray(result)) throw new Error("historical recruitment status evidence is invalid");
    return result.map((entry) => {
      if (
        entry === null || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "creatorId,orderId,status" ||
        entry.creatorId !== targetScope.creatorId || typeof entry.orderId !== "string" ||
        typeof entry.status !== "string"
      ) throw new Error("historical recruitment status evidence is invalid");
      return { orderId: entry.orderId, status: entry.status };
    });
  }

  #controller(command, dispatch) {
    return new RecruitmentOrchestrator({
      rules: this.rules,
      uiContract: this.uiContract,
      stores: {
        escalations: this.stores.escalations,
        mutations: this.stores.mutations,
        confirmations: this.stores.confirmations,
        ...(this.stores.recovery ? { recovery: this.stores.recovery } : {}),
      },
      scriptedAdapter: {
        async nextCommand() { return command; },
        async attempt(_command, controls) { return dispatch(controls); },
      },
      clock: this.clock,
    });
  }

  async #stateful({ manifest, state, operation, dispatch }) {
    const command = {
      operation,
      stage: state.stage,
      actionIntentDigest: state.pendingAction.intentionEvidence.integritySha256,
    };
    return this.#controller(command, dispatch).advance({
      batchRunId: manifest.batchRunId,
      runId: state.runId,
      orderId: state.orderSnapshot.orderId,
    });
  }

  async #persistDelivery(state, binding, delivery, deadline) {
    return this.stores.deliveries.write({
      schemaVersion: 1,
      runId: state.runId,
      orderId: binding.orderId,
      activityId: binding.activityId,
      creatorId: binding.creatorId,
      priceMinorUnits: binding.priceMinorUnits,
      deliveryDeadline: deadline,
      deliveryId: delivery.deliveryId,
    });
  }

  async #requirePersistedDelivery(state, binding) {
    const expected = await this.stores.deliveries.read(state.runId);
    if (
      !expected || expected.orderId !== binding.orderId ||
      expected.activityId !== binding.activityId || expected.creatorId !== binding.creatorId ||
      expected.priceMinorUnits !== binding.priceMinorUnits || expected.deliveryId !== state.verifiedTaskId
    ) throw new Error("persisted recruitment delivery evidence binding is invalid");
    const actual = exactDelivery(await this.adapter.reopenExactDelivery({
      ...binding,
      deliveryDeadline: expected.deliveryDeadline,
    }), binding);
    if (actual.deliveryId !== expected.deliveryId || actual.deliveryDeadline !== expected.deliveryDeadline) {
      return frozen({ kind: "BUSINESS_ERROR", reasonCode: "PERSISTED_DEADLINE_MISMATCH" });
    }
    return frozen({ kind: "VERIFIED" });
  }

  async #verifyPreSubmit(binding, deliveryDeadline) {
    const current = await this.adapter.readOrder({ orderId: binding.orderId });
    if (
      current === null || typeof current !== "object" || Array.isArray(current) ||
      current.activityId !== binding.activityId ||
      current.snapshotInput?.orderId !== binding.orderId ||
      current.snapshotInput?.creatorId !== binding.creatorId ||
      current.snapshotInput?.amount?.minorUnits !== binding.priceMinorUnits ||
      current.snapshotInput?.orderStatus !== "待商务下单"
    ) return frozen({ kind: "BLOCKED", reasonCode: "ORDER_BINDING_AMBIGUOUS" });
    const draft = await this.adapter.rereadRecruitmentDraft({ ...binding, deliveryDeadline });
    exactObject(draft, {
      activityId: binding.activityId,
      creatorId: binding.creatorId,
      priceMinorUnits: binding.priceMinorUnits,
      deliveryDeadline,
      entryScope: "EXACT_CREATOR_ROW",
      globalPublishUsed: false,
    }, "lightweight pre-submit verification");
    return frozen({ kind: "VERIFIED" });
  }

  async #processOrder(manifest, orderId) {
    const runId = deriveRecruitmentRunId(manifest.batchRunId, orderId);
    let state = await this.stores.runStates.read(runId);
    let persistedBinding = await this.stores.bindings.read(runId);
    if (!state || !persistedBinding) {
      const read = await this.adapter.readOrder({ orderId });
      if (
        read === null || typeof read !== "object" || Array.isArray(read) ||
        Object.keys(read).sort().join(",") !== "activityId,snapshotInput" ||
        typeof read.activityId !== "string" || read.activityId.length === 0
      ) throw new Error("recruitment order read is invalid");
      const snapshot = createOrderSnapshot({
        ...read.snapshotInput,
        businessDataDigest: activityBindingDigest({
          activityId: read.activityId,
          creatorId: read.snapshotInput.creatorId,
          priceMinorUnits: read.snapshotInput.amount?.minorUnits,
        }),
      }, this.rules);
      if (snapshot.orderStatus === this.rules.recruitment.completionStatus) {
        return frozen({ kind: "BUSINESS_ERROR", reasonCode: "ORDER_ALREADY_COMPLETED" });
      }
      if (snapshot.orderStatus !== "待商务下单") {
        return frozen({ kind: "BUSINESS_ERROR", reasonCode: "ORDER_STATUS_NOT_ELIGIBLE" });
      }
      await this.stores.orderLocks.acquire({ orderId, fingerprint: snapshot.fingerprint, runId });
      if (!state) state = await this.stores.runStates.write(initialRunState(runId, snapshot));
      if (state.orderSnapshot.fingerprint !== snapshot.fingerprint) throw new Error("recruitment order snapshot changed");
      persistedBinding = await this.stores.bindings.write({
        schemaVersion: 1,
        runId,
        orderId,
        activityId: read.activityId,
        orderFingerprint: snapshot.fingerprint,
      });
    }
    const snapshot = state.orderSnapshot;
    if (
      persistedBinding.orderId !== orderId ||
      persistedBinding.orderFingerprint !== snapshot.fingerprint
    ) throw new Error("persisted recruitment binding mismatch");
    const binding = {
      orderId,
      runId,
      activityId: persistedBinding.activityId,
      creatorId: snapshot.creatorId,
      priceMinorUnits: snapshot.amount.minorUnits,
    };
    let freshlyVerifiedDeliveries = null;

    if (state.stage === "ORDER_LOCKED") {
      const creatorEntry = await this.adapter.openExactActivityCreator(binding);
      if (
        creatorEntry?.eligible === false &&
        creatorEntry.reasonCode === "CREATOR_NOT_ELIGIBLE_IN_ACTIVITY"
      ) {
        return frozen({ kind: "BUSINESS_ERROR", reasonCode: "CREATOR_NOT_ELIGIBLE_IN_ACTIVITY" });
      }
      exactObject(creatorEntry, {
        activityId: binding.activityId,
        creatorId: binding.creatorId,
        priceMinorUnits: binding.priceMinorUnits,
        entryScope: "EXACT_CREATOR_ROW",
        globalPublishUsed: false,
      }, "recruitment activity creator row");
      state = await this.stores.runStates.advance(runId, "DRAFT_READY", { rereadVerified: true });
    }

    if (state.stage === "DRAFT_READY") {
      const operationInstant = this.clock();
      if (typeof operationInstant !== "string" || new Date(operationInstant).toISOString() !== operationInstant) {
        throw new Error("fresh recruitment operation instant is invalid");
      }
      const deliveryDeadline = deriveRecruitmentDeliveryDeadline({ orderedAt: operationInstant, rules: this.rules });
      const pendingAction = createActionIntent({
        type: "PUBLISH_RECRUITMENT_TASK",
        orderType: "RECRUITMENT",
        stage: "PUBLISH_INTENT",
        intentionEvidence: {
          runId,
          orderId,
          activityId: binding.activityId,
          creatorId: binding.creatorId,
          orderFingerprint: snapshot.fingerprint,
          rulesVersion: this.rules.rulesVersion,
          operationInstant,
          deliveryDeadline,
        },
      }, this.rules);
      const existing = await this.adapter.lookupExactDeliveries({
        ...binding,
        deliveryDeadline,
      });
      if (!Array.isArray(existing) || existing.length > 1) {
        return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "ORDER_BINDING_AMBIGUOUS" });
      }
      if (existing.length === 1) {
        const delivery = exactDelivery(existing[0], binding);
        if (delivery.deliveryDeadline !== deliveryDeadline) {
          return frozen({ kind: "BUSINESS_ERROR", reasonCode: "PERSISTED_DEADLINE_MISMATCH" });
        }
        freshlyVerifiedDeliveries = [delivery];
      } else {
        freshlyVerifiedDeliveries = [];
        const draft = await this.adapter.prepareRecruitmentDraft(binding);
        exactObject(draft, { prepared: true }, "recruitment draft");
      }
      state = await this.stores.runStates.advance(runId, "PUBLISH_INTENT", {
        rereadVerified: true,
        freshDuplicateLookupVerified: true,
      }, { pendingAction });
    }

    if (state.stage === "PUBLISH_INTENT") {
      const deadline = state.pendingAction.intentionEvidence.deliveryDeadline;
      const publishAttempts = (await this.stores.escalations.listForRun(runId))
        .filter((record) => record.operation === "SUBMIT_RECRUITMENT_ORDER");
      let existing = freshlyVerifiedDeliveries;
      if (existing === null && publishAttempts.length > 0) {
        existing = await this.adapter.lookupExactDeliveries({ ...binding, deliveryDeadline: deadline });
      } else if (existing === null) {
        const draft = await this.adapter.prepareRecruitmentDraft(binding);
        exactObject(draft, { prepared: true }, "resumed recruitment draft");
        existing = [];
      }
      if (!Array.isArray(existing) || existing.length > 1) {
        return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "ORDER_BINDING_AMBIGUOUS" });
      }
      if (existing.length === 1) {
        const delivery = exactDelivery(existing[0], binding);
        if (delivery.deliveryDeadline !== deadline) {
          return frozen({ kind: "BUSINESS_ERROR", reasonCode: "PERSISTED_DEADLINE_MISMATCH" });
        }
        await this.#persistDelivery(state, binding, delivery, deadline);
        state = await this.stores.runStates.advance(runId, "TASK_VERIFIED", { rereadVerified: true }, {
          verifiedTaskId: delivery.deliveryId,
          pendingAction: null,
        });
      } else if (publishAttempts.length > 0) {
        const submitResult = typeof this.adapter.readRecruitmentSubmitResult === "function"
          ? await this.adapter.readRecruitmentSubmitResult({ ...binding, deliveryDeadline: deadline })
          : { kind: "UNKNOWN" };
        if (submitResult.kind === "BUDGET_INSUFFICIENT") {
          const allowance = await this.stores.budgets.checkAllowed(manifest.batchRunId, binding.activityId);
          if (!allowance.allowed) {
            return frozen({ kind: "BUSINESS_ERROR", reasonCode: "BUDGET_TOPUP_LIMIT_REACHED" });
          }
          const before = exactBudget(await this.adapter.readRecruitmentBudget(binding), binding);
          const publishEvidence = state.pendingAction.intentionEvidence;
          const pendingAction = createActionIntent({
            type: "TOP_UP_RECRUITMENT_BUDGET",
            orderType: "RECRUITMENT",
            stage: "BUDGET_TOPUP_INTENT",
            intentionEvidence: {
              runId,
              orderId,
              batchRunId: manifest.batchRunId,
              activityId: binding.activityId,
              creatorId: binding.creatorId,
              orderFingerprint: snapshot.fingerprint,
              rulesVersion: this.rules.rulesVersion,
              beforeTotalBudgetMinorUnits: before.totalBudgetMinorUnits,
              stepMinorUnits: this.rules.recruitment.budgetTopUp.stepMinorUnits,
              operationInstant: publishEvidence.operationInstant,
              deliveryDeadline: deadline,
            },
          }, this.rules);
          state = await this.stores.runStates.advance(runId, "BUDGET_TOPUP_INTENT", {
            rereadVerified: true,
            explicitBudgetInsufficientVerified: true,
            budgetLimitVerified: true,
          }, { pendingAction });
        } else if (this.stores.recovery === undefined) {
          return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "ACTION_RESULT_UNKNOWN" });
        } else {
          const draft = await this.adapter.prepareRecruitmentDraft(binding);
          exactObject(draft, { prepared: true }, "authorized retry recruitment draft");
        }
      }
    }

    if (state.stage === "PUBLISH_INTENT") {
      const publishEvidence = state.pendingAction.intentionEvidence;
      const deadline = publishEvidence.deliveryDeadline;
      exactObject(await this.adapter.commitDeliveryDeadline({ ...binding, deliveryDeadline: deadline }), { committed: true }, "deadline widget commit");
      const preSubmit = await this.#verifyPreSubmit(binding, deadline);
      if (preSubmit.kind !== "VERIFIED") return preSubmit;
      const submitted = await this.#stateful({
        manifest,
        state,
        operation: "SUBMIT_RECRUITMENT_ORDER",
        dispatch: (controls) => this.adapter.submitRecruitmentOrder({ ...binding, deliveryDeadline: deadline }, controls),
      });
      if (submitted.kind !== "COMPLETED") return submitted;
      if (this.rules.rulesVersion !== "2026-08-17-r1") {
        const delivery = exactDelivery(
          await this.adapter.reopenExactDelivery({ ...binding, deliveryDeadline: deadline }),
          binding,
        );
        if (delivery.deliveryDeadline !== deadline) {
          return frozen({ kind: "BUSINESS_ERROR", reasonCode: "PERSISTED_DEADLINE_MISMATCH" });
        }
        await this.#persistDelivery(state, binding, delivery, deadline);
        state = await this.stores.runStates.advance(runId, "TASK_VERIFIED", { rereadVerified: true }, {
          verifiedTaskId: delivery.deliveryId,
          pendingAction: null,
        });
      } else {
        const submitResult = exactSubmitResult(
          await this.adapter.readRecruitmentSubmitResult({ ...binding, deliveryDeadline: deadline }),
          binding,
        );
        if (submitResult.kind === "DELIVERY_OBSERVED") {
          if (submitResult.delivery.deliveryDeadline !== deadline) {
            return frozen({ kind: "BUSINESS_ERROR", reasonCode: "PERSISTED_DEADLINE_MISMATCH" });
          }
          await this.#persistDelivery(state, binding, submitResult.delivery, deadline);
          state = await this.stores.runStates.advance(runId, "TASK_VERIFIED", { rereadVerified: true }, {
            verifiedTaskId: submitResult.delivery.deliveryId,
            pendingAction: null,
          });
        } else if (submitResult.kind === "BUDGET_INSUFFICIENT") {
          const afterBudgetError = await this.adapter.lookupExactDeliveries({
            ...binding,
            deliveryDeadline: deadline,
          });
          if (!Array.isArray(afterBudgetError) || afterBudgetError.length > 1) {
            return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "ORDER_BINDING_AMBIGUOUS" });
          }
          if (afterBudgetError.length === 1) {
            const delivery = exactDelivery(afterBudgetError[0], binding);
            if (delivery.deliveryDeadline !== deadline) {
              return frozen({ kind: "BUSINESS_ERROR", reasonCode: "PERSISTED_DEADLINE_MISMATCH" });
            }
            await this.#persistDelivery(state, binding, delivery, deadline);
            state = await this.stores.runStates.advance(runId, "TASK_VERIFIED", { rereadVerified: true }, {
              verifiedTaskId: delivery.deliveryId,
              pendingAction: null,
            });
          } else {
            const allowance = await this.stores.budgets.checkAllowed(manifest.batchRunId, binding.activityId);
            if (!allowance.allowed) {
              return frozen({ kind: "BUSINESS_ERROR", reasonCode: "BUDGET_TOPUP_LIMIT_REACHED" });
            }
            const before = exactBudget(await this.adapter.readRecruitmentBudget(binding), binding);
            const pendingAction = createActionIntent({
              type: "TOP_UP_RECRUITMENT_BUDGET",
              orderType: "RECRUITMENT",
              stage: "BUDGET_TOPUP_INTENT",
              intentionEvidence: {
                runId,
                orderId,
                batchRunId: manifest.batchRunId,
                activityId: binding.activityId,
                creatorId: binding.creatorId,
                orderFingerprint: snapshot.fingerprint,
                rulesVersion: this.rules.rulesVersion,
                beforeTotalBudgetMinorUnits: before.totalBudgetMinorUnits,
                stepMinorUnits: this.rules.recruitment.budgetTopUp.stepMinorUnits,
                operationInstant: publishEvidence.operationInstant,
                deliveryDeadline: deadline,
              },
            }, this.rules);
            state = await this.stores.runStates.advance(runId, "BUDGET_TOPUP_INTENT", {
              rereadVerified: true,
              explicitBudgetInsufficientVerified: true,
              budgetLimitVerified: true,
            }, { pendingAction });
          }
        } else {
          return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "TASK_RESULT_PENDING" });
        }
      }
    }

    if (state.stage === "BUDGET_TOPUP_INTENT") {
      const evidence = state.pendingAction.intentionEvidence;
      let after = exactBudget(await this.adapter.rereadRecruitmentBudget(binding), binding);
      if (after.totalBudgetMinorUnits === evidence.beforeTotalBudgetMinorUnits) {
        const toppedUp = await this.#stateful({
          manifest,
          state,
          operation: "TOP_UP_RECRUITMENT_BUDGET",
          dispatch: (controls) => this.adapter.topUpRecruitmentBudget({
            ...binding,
            beforeTotalBudgetMinorUnits: evidence.beforeTotalBudgetMinorUnits,
            stepMinorUnits: evidence.stepMinorUnits,
          }, controls),
        });
        if (toppedUp.kind !== "COMPLETED") return toppedUp;
        after = exactBudget(await this.adapter.rereadRecruitmentBudget(binding), binding);
      }
      if (after.totalBudgetMinorUnits - evidence.beforeTotalBudgetMinorUnits !== evidence.stepMinorUnits) {
        return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "BUDGET_TOPUP_RESULT_UNKNOWN" });
      }
      await this.stores.budgets.recordObserved({
        batchRunId: manifest.batchRunId,
        runId,
        orderId,
        activityId: binding.activityId,
        beforeTotalBudgetMinorUnits: evidence.beforeTotalBudgetMinorUnits,
        afterTotalBudgetMinorUnits: after.totalBudgetMinorUnits,
        operationInstant: evidence.operationInstant,
        deliveryDeadline: evidence.deliveryDeadline,
      });
      state = await this.stores.runStates.advance(runId, "BUDGET_TOPUP_OBSERVED", {
        rereadVerified: true,
        budgetTopUpVerified: true,
      }, { pendingAction: null });
    }

    if (state.stage === "BUDGET_TOPUP_OBSERVED") {
      const budgetState = await this.stores.budgets.read(manifest.batchRunId);
      const observation = budgetState?.observations.find((entry) => entry.runId === runId);
      if (!observation || observation.activityId !== binding.activityId) {
        throw new Error("verified recruitment budget top-up evidence is missing");
      }
      const existing = await this.adapter.lookupExactDeliveries({
        ...binding,
        deliveryDeadline: observation.deliveryDeadline,
      });
      if (!Array.isArray(existing) || existing.length > 1) {
        return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "ORDER_BINDING_AMBIGUOUS" });
      }
      if (existing.length === 1) {
        const delivery = exactDelivery(existing[0], binding);
        if (delivery.deliveryDeadline !== observation.deliveryDeadline) {
          return frozen({ kind: "BUSINESS_ERROR", reasonCode: "PERSISTED_DEADLINE_MISMATCH" });
        }
        await this.#persistDelivery(state, binding, delivery, observation.deliveryDeadline);
        state = await this.stores.runStates.advance(runId, "TASK_VERIFIED", { rereadVerified: true }, {
          verifiedTaskId: delivery.deliveryId,
          pendingAction: null,
        });
      } else {
        const pendingAction = createActionIntent({
          type: "PUBLISH_RECRUITMENT_TASK",
          orderType: "RECRUITMENT",
          stage: "PUBLISH_RETRY_READY",
          intentionEvidence: {
            runId,
            orderId,
            activityId: binding.activityId,
            creatorId: binding.creatorId,
            orderFingerprint: snapshot.fingerprint,
            rulesVersion: this.rules.rulesVersion,
            operationInstant: observation.operationInstant,
            deliveryDeadline: observation.deliveryDeadline,
            budgetTopUpEvidenceDigest: observation.evidenceDigest,
          },
        }, this.rules);
        state = await this.stores.runStates.advance(runId, "PUBLISH_RETRY_READY", {
          rereadVerified: true,
          freshDuplicateLookupVerified: true,
          budgetTopUpVerified: true,
        }, { pendingAction });
      }
    }

    if (state.stage === "PUBLISH_RETRY_READY") {
      const deadline = state.pendingAction.intentionEvidence.deliveryDeadline;
      const existing = await this.adapter.lookupExactDeliveries({ ...binding, deliveryDeadline: deadline });
      if (!Array.isArray(existing) || existing.length > 1) {
        return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "NON_OCCURRENCE_UNPROVEN" });
      }
      if (existing.length === 1) {
        const delivery = exactDelivery(existing[0], binding);
        if (delivery.deliveryDeadline !== deadline) {
          return frozen({ kind: "BUSINESS_ERROR", reasonCode: "PERSISTED_DEADLINE_MISMATCH" });
        }
        await this.#persistDelivery(state, binding, delivery, deadline);
        state = await this.stores.runStates.advance(runId, "TASK_VERIFIED", { rereadVerified: true }, {
          verifiedTaskId: delivery.deliveryId,
          pendingAction: null,
        });
      } else {
        exactObject(await this.adapter.prepareRecruitmentDraft(binding), { prepared: true }, "budget retry recruitment draft");
        exactObject(await this.adapter.commitDeliveryDeadline({ ...binding, deliveryDeadline: deadline }), { committed: true }, "retry deadline widget commit");
        const retryPreSubmit = await this.#verifyPreSubmit(binding, deadline);
        if (retryPreSubmit.kind !== "VERIFIED") return retryPreSubmit;
        const submitted = await this.#stateful({
          manifest,
          state,
          operation: "SUBMIT_RECRUITMENT_ORDER",
          dispatch: (controls) => this.adapter.submitRecruitmentOrder({ ...binding, deliveryDeadline: deadline }, controls),
        });
        if (submitted.kind !== "COMPLETED") return submitted;
        const submitResult = exactSubmitResult(
          await this.adapter.readRecruitmentSubmitResult({ ...binding, deliveryDeadline: deadline }),
          binding,
        );
        if (submitResult.kind === "BUDGET_INSUFFICIENT") {
          return frozen({ kind: "BUSINESS_ERROR", reasonCode: "BUDGET_TOPUP_LIMIT_REACHED" });
        }
        if (submitResult.kind !== "DELIVERY_OBSERVED") {
          return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "TASK_RESULT_PENDING" });
        }
        if (submitResult.delivery.deliveryDeadline !== deadline) {
          return frozen({ kind: "BUSINESS_ERROR", reasonCode: "PERSISTED_DEADLINE_MISMATCH" });
        }
        await this.#persistDelivery(state, binding, submitResult.delivery, deadline);
        state = await this.stores.runStates.advance(runId, "TASK_VERIFIED", { rereadVerified: true }, {
          verifiedTaskId: submitResult.delivery.deliveryId,
          pendingAction: null,
        });
      }
    }

    if (state.stage === "TASK_VERIFIED") {
      const verified = await this.#requirePersistedDelivery(state, binding);
      if (verified.kind !== "VERIFIED") return verified;
      const expected = { taskId: binding.activityId, advertiserId: this.rules.advertiser.fixedId };
      exactObject(await this.adapter.prepareInternalWriteback(binding), expected, "internal writeback");
      const hash = writebackHash({
        snapshot,
        deliveryId: state.verifiedTaskId,
        activityId: binding.activityId,
        advertiserId: this.rules.advertiser.fixedId,
      });
      state = await this.stores.runStates.advance(runId, "WRITEBACK_READY", { rereadVerified: true }, {
        writebackEvidenceHash: hash,
      });
    }

    if (state.stage === "WRITEBACK_READY") {
      const verified = await this.#requirePersistedDelivery(state, binding);
      if (verified.kind !== "VERIFIED") return verified;
      exactObject(await this.adapter.rereadInternalWriteback(binding), {
        taskId: binding.activityId,
        advertiserId: this.rules.advertiser.fixedId,
      }, "internal writeback reread");
      const pendingAction = createActionIntent({
        type: "CONFIRM_INTERNAL_ORDER",
        orderType: "RECRUITMENT",
        stage: "CONFIRM_INTENT",
        freshWritebackVerified: true,
        intentionEvidence: {
          runId,
          orderId,
          orderFingerprint: snapshot.fingerprint,
          rulesVersion: this.rules.rulesVersion,
          verifiedTaskId: state.verifiedTaskId,
          writebackEvidenceHash: state.writebackEvidenceHash,
        },
      }, this.rules);
      state = await this.stores.runStates.advance(runId, "CONFIRM_INTENT", {
        rereadVerified: true,
        freshWritebackVerified: true,
      }, { pendingAction });
    }

    if (state.stage === "CONFIRM_INTENT") {
      const verified = await this.#requirePersistedDelivery(state, binding);
      if (verified.kind !== "VERIFIED") return verified;
      const actionIntentDigest = state.pendingAction.intentionEvidence.integritySha256;
      const priorUnknownDispatch = (await this.stores.escalations.listForRun(runId)).some((record) => (
        record.operation === "CONFIRM_INTERNAL_ORDER" &&
        record.orderId === orderId &&
        record.actionIntentDigest === actionIntentDigest &&
        record.dispatchState === "DISPATCHING"
      ));
      let final;
      if (priorUnknownDispatch) {
        const observed = await this.adapter.rereadInternalFinalState(binding);
        if (
          observed?.orderId !== orderId || observed?.activityId !== binding.activityId ||
          observed?.creatorId !== binding.creatorId
        ) return frozen({ kind: "BLOCKED", reasonCode: "ORDER_BINDING_AMBIGUOUS" });
        if (observed.status !== this.rules.recruitment.completionStatus) {
          return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "ACTION_RESULT_UNKNOWN" });
        }
        final = observed;
      } else {
        const confirmed = await this.#stateful({
          manifest,
          state,
          operation: "CONFIRM_INTERNAL_ORDER",
          dispatch: (controls) => this.adapter.confirmInternalOrder(binding, controls),
        });
        if (confirmed.kind !== "COMPLETED") return confirmed;
        final = await this.adapter.rereadInternalFinalState(binding);
      }
      final = exactObject(final, {
        orderId,
        activityId: binding.activityId,
        creatorId: binding.creatorId,
        status: this.rules.recruitment.completionStatus,
      }, "internal final state");
      const observation = createRecruitmentFinalObservation({
        schemaVersion: 2,
        runId,
        orderType: "RECRUITMENT",
        orderId,
        orderFingerprint: snapshot.fingerprint,
        rulesVersion: this.rules.rulesVersion,
        verifiedTaskId: state.verifiedTaskId,
        writebackEvidenceHash: state.writebackEvidenceHash,
      }, final.status, this.rules);
      state = await this.stores.runStates.advance(runId, "FINAL_OBSERVED", { rereadVerified: true }, {
        pendingAction: null,
        finalObservation: observation,
      });
    }

    if (state.stage === "FINAL_OBSERVED") {
      state = await this.stores.runStates.advance(runId, "DONE", { rereadVerified: true });
    }
    return state.stage === "DONE"
      ? frozen({ kind: "COMPLETED", orderId })
      : frozen({ kind: "BLOCKED", reasonCode: "RECRUITMENT_STAGE_INCOMPLETE" });
  }

  async run(manifest) {
    manifest = parseRecruitmentBatchManifest(manifest, this.rules);
    if (Array.isArray(manifest.orderLocators)) return this.#runDirect(manifest);
    let initialRemainingOrderCount = null;
    let sweep = await this.stores.sweeps.initialize(manifest);
    if (sweep.status === "COMPLETED") return frozen({
      kind: "COMPLETED",
      batchRunId: manifest.batchRunId,
      completedOrderIds: sweep.completedOrderIds,
      deltaSweeps: sweep.deltaSweeps,
      ...(sweep.historicalOrderStatuses.length > 0 ? { historicalOrderStatuses: sweep.historicalOrderStatuses } : {}),
      ...(sweep.targetScope.maxOrders !== null && sweep.remainingOrderCount !== null
        ? { remainingOrderCount: sweep.remainingOrderCount }
        : {}),
    });
    if (sweep.status === "BLOCKED") return frozen({
      kind: "BLOCKED", batchRunId: manifest.batchRunId, reasonCode: "DELTA_SWEEP_LIMIT_REACHED",
    });
    if (sweep.waves.length === 0) {
      const initial = await this.#query(manifest);
      const targetScope = normalizeRecruitmentTargetScope(manifest.targetScope);
      const frozenInitial = targetScope.maxOrders === null
        ? initial
        : initial.slice(0, targetScope.maxOrders);
      if (targetScope.maxOrders !== null) {
        initialRemainingOrderCount = Math.max(0, initial.length - frozenInitial.length);
      }
      const historical = initial.length === 0 ? await this.#queryHistorical(manifest) : [];
      sweep = initial.length === 0
        ? historical.length > 0
          ? await this.stores.sweeps.recordHistoricalComplete(manifest.batchRunId, historical)
          : await this.stores.sweeps.recordZero(manifest.batchRunId)
        : await this.stores.sweeps.addWave(manifest.batchRunId, frozenInitial, { delta: false });
    }

    for (;;) {
      sweep = await this.stores.sweeps.read(manifest.batchRunId);
      for (const wave of sweep.waves) {
        const batchManifest = waveManifest(manifest, wave);
        const batchStore = this.stores.batchFor(batchManifest);
        const queried = wave.orders;
        let batch = await batchStore.initialize(batchManifest, queried);
        while (batch.status === "RUNNING") {
          const orderId = batch.currentOrderId;
          const result = await this.#processOrder(batchManifest, orderId);
          if (result.kind === "COMPLETED") {
            batch = await batchStore.recordOutcome(batchManifest.batchRunId, { orderId, kind: "SUCCESS" });
            await this.stores.sweeps.recordCompleted(manifest.batchRunId, orderId);
          } else if (result.kind === "BUSINESS_ERROR") {
            batch = await batchStore.recordOutcome(batchManifest.batchRunId, {
              orderId, kind: "BUSINESS_ERROR", code: result.reasonCode,
            });
          } else {
            return frozen({ ...result, batchRunId: manifest.batchRunId });
          }
        }
        if (batch.status === "PAUSED") return frozen({
          kind: "BLOCKED",
          batchRunId: manifest.batchRunId,
          reasonCode: batch.pauseReasonCode,
          currentOrderId: batch.currentOrderId,
        });
      }

      sweep = await this.stores.sweeps.read(manifest.batchRunId);
      if (sweep.finalZeroVerified) {
        const skippedOrderIds = [];
        for (const wave of sweep.waves) {
          const batchManifest = waveManifest(manifest, wave);
          const batch = await this.stores.batchFor(batchManifest).read(batchManifest.batchRunId);
          skippedOrderIds.push(...(batch?.takeoverOrderIds ?? []));
        }
        return frozen({
          kind: "COMPLETED",
          batchRunId: manifest.batchRunId,
          completedOrderIds: sweep.completedOrderIds,
          deltaSweeps: sweep.deltaSweeps,
          ...(skippedOrderIds.length > 0 ? { skippedOrderIds } : {}),
          ...(sweep.historicalOrderStatuses.length > 0 ? { historicalOrderStatuses: sweep.historicalOrderStatuses } : {}),
          ...(sweep.targetScope.maxOrders !== null && sweep.remainingOrderCount !== null
            ? { remainingOrderCount: sweep.remainingOrderCount }
            : {}),
        });
      }
      const targetScope = normalizeRecruitmentTargetScope(manifest.targetScope);
      if (targetScope.maxOrders !== null) {
        const frozenOrderIds = new Set(sweep.waves.flatMap(({ orders }) => orders.map(({ orderId }) => orderId)));
        const deficit = targetScope.maxOrders - sweep.completedOrderIds.length;
        if (deficit <= 0) {
          sweep = await this.stores.sweeps.recordLimitedComplete(manifest.batchRunId, initialRemainingOrderCount);
          return frozen({
            kind: "COMPLETED",
            batchRunId: manifest.batchRunId,
            completedOrderIds: sweep.completedOrderIds,
            deltaSweeps: sweep.deltaSweeps,
            ...(sweep.remainingOrderCount !== null ? { remainingOrderCount: sweep.remainingOrderCount } : {}),
          });
        }
        if (frozenOrderIds.size < targetScope.maxOrders) {
          sweep = await this.stores.sweeps.recordLimitedComplete(manifest.batchRunId, 0);
          return frozen({
            kind: "COMPLETED",
            batchRunId: manifest.batchRunId,
            completedOrderIds: sweep.completedOrderIds,
            deltaSweeps: sweep.deltaSweeps,
            remainingOrderCount: 0,
          });
        }
        const replacements = (await this.#query(manifest))
          .filter(({ orderId }) => !frozenOrderIds.has(orderId))
          .slice(0, deficit);
        if (replacements.length === 0) {
          sweep = await this.stores.sweeps.recordLimitedComplete(manifest.batchRunId, 0);
          return frozen({
            kind: "COMPLETED",
            batchRunId: manifest.batchRunId,
            completedOrderIds: sweep.completedOrderIds,
            deltaSweeps: sweep.deltaSweeps,
            remainingOrderCount: 0,
          });
        }
        if (sweep.deltaSweeps >= MAX_DELTA_SWEEPS) {
          await this.stores.sweeps.block(manifest.batchRunId);
          return frozen({ kind: "BLOCKED", batchRunId: manifest.batchRunId, reasonCode: "DELTA_SWEEP_LIMIT_REACHED" });
        }
        sweep = await this.stores.sweeps.addWave(manifest.batchRunId, replacements, { delta: true });
        continue;
      }
      const delta = await this.#query(manifest);
      if (delta.length === 0) {
        sweep = await this.stores.sweeps.recordZero(manifest.batchRunId);
      } else if (sweep.deltaSweeps >= MAX_DELTA_SWEEPS) {
        await this.stores.sweeps.block(manifest.batchRunId);
        return frozen({ kind: "BLOCKED", batchRunId: manifest.batchRunId, reasonCode: "DELTA_SWEEP_LIMIT_REACHED" });
      } else {
        sweep = await this.stores.sweeps.addWave(manifest.batchRunId, delta, { delta: true });
      }
      if (sweep.status === "BLOCKED") return frozen({
        kind: "BLOCKED", batchRunId: manifest.batchRunId, reasonCode: "IDENTICAL_FILTER_NOT_ZERO",
      });
    }
  }
}
