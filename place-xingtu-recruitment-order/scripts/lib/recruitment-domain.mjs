import { normalizeShanghaiCreatedAtRange, parseRecruitmentBatchManifest } from "./manifest.mjs";

const stateKeys = new Set([
  "frozenOrderIds",
  "completedOrderIds",
  "currentStatus",
  "consecutiveBusinessError",
]);

function fail(message) {
  throw new Error(`RecruitmentBatch: ${message}`);
}

function parseRangeBoundary(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T00:00:00\+08:00$/u.exec(value);
  if (!match) fail("normalized createdAt range is invalid");
  const [, year, month, day] = match.map(Number);
  return Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000;
}

function parseCreatedAt(value) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value)
    : null;
  if (!match) {
    fail("createdAt must be an offset-qualified ISO timestamp");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondsText, zone, offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour
    || calendar.getUTCMinutes() !== minute
    || calendar.getUTCSeconds() !== second
    || (millisecondsText !== undefined && Number(millisecondsText.padEnd(3, "0")) > 999)
    || (zone !== "Z" && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))
  ) {
    fail("createdAt must be a real timestamp with a real calendar date");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("createdAt must be a real timestamp");
  return milliseconds;
}

function parseMinimalOrder(order) {
  if (order === null || typeof order !== "object" || Array.isArray(order)) {
    fail("order must be an object");
  }
  if (Object.keys(order).some((key) => !["orderId", "createdAt"].includes(key))) {
    fail("order contains an unknown field");
  }
  if (!Object.hasOwn(order, "orderId") || !Object.hasOwn(order, "createdAt")) {
    fail("orderId and createdAt are required");
  }
  if (typeof order.orderId !== "string" || order.orderId.length === 0 || order.orderId !== order.orderId.trim()) {
    fail("orderId must be a non-empty trimmed string");
  }
  if (/\r|\n|[,;]/u.test(order.orderId)) fail("orderId must identify one order");
  return { orderId: order.orderId, createdAt: order.createdAt, milliseconds: parseCreatedAt(order.createdAt) };
}

function initialState(frozenOrderIds, currentStatus) {
  return {
    frozenOrderIds,
    completedOrderIds: [],
    currentStatus,
    consecutiveBusinessError: { code: null, count: 0 },
  };
}

export function freezeRecruitmentBatch(manifest, queriedOrders, rules = undefined) {
  const parsedManifest = parseRecruitmentBatchManifest(manifest, rules);
  if (!Array.isArray(queriedOrders)) fail("queried orders must be an array");
  const direct = Array.isArray(parsedManifest.orderLocators);
  const orders = direct
    ? queriedOrders.map((order) => {
      if (
        order === null || typeof order !== "object" || Array.isArray(order) ||
        Object.keys(order).sort().join(",") !== "createdAt,orderId" ||
        typeof order.orderId !== "string" || order.orderId.length === 0 ||
        !(order.createdAt === null || (typeof order.createdAt === "string" && Number.isFinite(Date.parse(order.createdAt))))
      ) fail("direct order evidence is invalid");
      return { orderId: order.orderId, createdAt: order.createdAt };
    })
    : queriedOrders.map(parseMinimalOrder);
  const seenOrderIds = new Set();
  for (const order of orders) {
    if (seenOrderIds.has(order.orderId)) fail("duplicate orderId is not allowed");
    seenOrderIds.add(order.orderId);
  }
  if (direct) {
    const requested = parsedManifest.orderLocators.map(({ value }) => value);
    if (orders.length !== requested.length || orders.some((order, index) => order.orderId !== requested[index])) {
      fail("queried orders do not exactly match the ordered orderLocators");
    }
    return initialState(requested, requested.length === 0 ? "NEEDS_HUMAN" : "FROZEN");
  }
  const range = normalizeShanghaiCreatedAtRange(parsedManifest.createdAtRange);
  const start = parseRangeBoundary(range.start);
  const endExclusive = parseRangeBoundary(range.endExclusive);
  for (const order of orders) {
    if (order.milliseconds < start || order.milliseconds >= endExclusive) {
      fail("order createdAt is outside the frozen range");
    }
  }
  orders.sort((left, right) => (
    left.milliseconds - right.milliseconds || left.orderId.localeCompare(right.orderId, "en-US")
  ));
  if (orders.length === 0) return initialState([], "NEEDS_HUMAN");
  return initialState(orders.map((order) => order.orderId), "FROZEN");
}

function parseBatchState(batch) {
  if (batch === null || typeof batch !== "object" || Array.isArray(batch)) fail("state must be an object");
  if (Object.keys(batch).some((key) => !stateKeys.has(key)) || Object.keys(batch).length !== stateKeys.size) {
    fail("state has an unknown or missing field");
  }
  if (!Array.isArray(batch.frozenOrderIds) || !Array.isArray(batch.completedOrderIds)) {
    fail("state order lists must be arrays");
  }
  if (batch.frozenOrderIds.some((id) => typeof id !== "string") || new Set(batch.frozenOrderIds).size !== batch.frozenOrderIds.length) {
    fail("state frozen order list is invalid");
  }
  if (batch.completedOrderIds.some((id) => typeof id !== "string") || new Set(batch.completedOrderIds).size !== batch.completedOrderIds.length) {
    fail("state completed order list is invalid");
  }
  if (batch.completedOrderIds.some((id) => !batch.frozenOrderIds.includes(id))) {
    fail("state completed order must be frozen");
  }
  if (!new Set(["FROZEN", "NEEDS_HUMAN", "PAUSED", "COMPLETED"]).has(batch.currentStatus)) {
    fail("state currentStatus is invalid");
  }
  const error = batch.consecutiveBusinessError;
  if (
    error === null || typeof error !== "object" || Array.isArray(error)
    || Object.keys(error).sort().join(",") !== "code,count"
    || (!((error.code === null && error.count === 0) || (typeof error.code === "string" && error.code.length > 0 && Number.isInteger(error.count) && error.count > 0)))
  ) {
    fail("state consecutive business error is invalid");
  }
  return structuredClone(batch);
}

function parseOutcome(outcome) {
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) fail("outcome must be an object");
  if (outcome.kind === "SUCCESS") {
    if (Object.keys(outcome).sort().join(",") !== "kind,orderId" || typeof outcome.orderId !== "string" || outcome.orderId.length === 0) {
      fail("successful outcome requires exactly one orderId");
    }
    return outcome;
  }
  if (outcome.kind === "BUSINESS_ERROR") {
    if (Object.keys(outcome).sort().join(",") !== "code,kind" || !/^[A-Z][A-Z0-9_]{2,127}$/u.test(outcome.code ?? "")) {
      fail("business error outcome requires a typed code");
    }
    return outcome;
  }
  fail("outcome kind is invalid");
}

export function advanceRecruitmentBatch(batch, outcome, rules) {
  const parsedBatch = parseBatchState(batch);
  const parsedOutcome = parseOutcome(outcome);
  const threshold = rules?.recruitment?.sameBusinessErrorThreshold;
  if (!Number.isInteger(threshold) || threshold < 1) fail("v2 rules require a business error threshold");
  if (parsedBatch.currentStatus !== "FROZEN") fail("only a frozen batch may advance");

  if (parsedOutcome.kind === "SUCCESS") {
    if (!parsedBatch.frozenOrderIds.includes(parsedOutcome.orderId) || parsedBatch.completedOrderIds.includes(parsedOutcome.orderId)) {
      fail("successful order must be a remaining frozen order");
    }
    parsedBatch.completedOrderIds.push(parsedOutcome.orderId);
    parsedBatch.consecutiveBusinessError = { code: null, count: 0 };
    if (parsedBatch.completedOrderIds.length === parsedBatch.frozenOrderIds.length) {
      parsedBatch.currentStatus = "COMPLETED";
    }
    return parsedBatch;
  }

  const previous = parsedBatch.consecutiveBusinessError;
  const count = previous.code === parsedOutcome.code ? previous.count + 1 : 1;
  parsedBatch.consecutiveBusinessError = { code: parsedOutcome.code, count };
  if (count >= threshold) parsedBatch.currentStatus = "PAUSED";
  return parsedBatch;
}
