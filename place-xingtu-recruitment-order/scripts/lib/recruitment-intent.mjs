function freeze(value) {
  return Object.freeze(structuredClone(value));
}

function shanghaiDateParts(now) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error("recruitment intent now must be an ISO timestamp");
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
}

function calendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) throw new Error("recruitment intent contains an invalid calendar date");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractRange(text, currentYear) {
  const range = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:到|至|~|—|-)\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/u.exec(text);
  if (range) {
    const start = calendarDate(Number(range[1] ?? currentYear), Number(range[2]), Number(range[3]));
    const end = calendarDate(Number(range[4] ?? range[1] ?? currentYear), Number(range[5]), Number(range[6]));
    if (start > end) throw new Error("recruitment intent date range is reversed");
    return { match: range[0], createdAtRange: { startDate: start, endDate: end } };
  }
  const single = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/u.exec(text);
  if (!single) return null;
  const value = calendarDate(Number(single[1] ?? currentYear), Number(single[2]), Number(single[3]));
  return { match: single[0], createdAtRange: { startDate: value, endDate: value } };
}

function extractCreatorName(text, dateText) {
  let remainder = text.normalize("NFC");
  if (dateText) remainder = remainder.replace(dateText, " ");
  remainder = remainder
    .replace(/今天/gu, " ")
    .replace(/(?:麻烦|请|帮我|给我|把|将)/gu, " ")
    .replace(/(?:抖音|星图|定向招募|批量招募|活动内达人下单|招募)/gu, " ")
    .replace(/(?:Ego\s*Lite|egolite|ego-browser|使用|执行|完成|内部确认|结果|耗时|卡点|汇报)/giu, " ")
    .replace(/达人\s*[:：]?/gu, " ")
    .replace(/的(?=(?:全部)?订单|(?:只)?(?:一个|一张|一单|两张|两单|两个订单|[0-9]+\s*(?:张|单|个订单)))/gu, " ")
    .replace(/(?:的)?(?:全部)?订单/gu, " ")
    .replace(/(?:给)?下(?:了|单)?/gu, " ")
    .replace(/(?:跑|处理|操作|看看|试试)/gu, " ")
    .replace(/(?:只|一个|一张|一单|两张|两单|两个订单|[0-9]+\s*(?:张|单|个订单))/gu, " ")
    .replace(/[，。！？、,.!?]/gu, " ")
    .replace(/(^|\s)的(?=\s|$)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return remainder.length === 0 ? null : remainder;
}

function extractQuantity(text) {
  const quantityMatch = /([1-9][0-9]*)\s*(?:张|单|个订单)/u.exec(text);
  const chineseQuantity = /(?:两个订单|两张|两单)/u.test(text) ? 2
    : /(?:一个订单|一个|一张|一单|跑一单|只跑这一单)/u.test(text) ? 1
      : null;
  const maxOrders = quantityMatch ? Number(quantityMatch[1]) : chineseQuantity;
  if (maxOrders !== null && !Number.isSafeInteger(maxOrders)) {
    throw new Error("recruitment intent order quantity is invalid");
  }
  return maxOrders;
}

function explicitAll(text) {
  return /(?:全部(?:订单|招募订单)?|所有(?:订单|招募订单)?)/u.test(text);
}

function clarification(reasonCode, recognized, question) {
  const missingFields = reasonCode === "DATE_AND_QUANTITY_REQUIRED"
    ? ["DATE", "QUANTITY"]
    : reasonCode === "QUANTITY_REQUIRED"
      ? ["QUANTITY"]
      : reasonCode === "ORDER_COUNT_CONFLICT"
        ? ["ORDER_SCOPE"]
        : ["DATE"];
  return freeze({
    kind: "NEEDS_CLARIFICATION",
    reasonCode,
    recognized,
    missingFields,
    question,
  });
}

function extractOrderLocators(text) {
  const match = /订单(?:编号|号)\s*[:：]?\s*([A-Za-z0-9_-]+(?:\s*[、,，;；]\s*[A-Za-z0-9_-]+)*)/u.exec(text);
  const values = match
    ? match[1].split(/[、,，;；]/u).map((value) => value.trim()).filter(Boolean)
    : [...text.matchAll(/\bORD[A-Za-z0-9_-]+\b/giu)].map(([value]) => value);
  if (values.length === 0) return null;
  const seen = new Set();
  return values.flatMap((value) => {
    if (seen.has(value)) return [];
    seen.add(value);
    return [{ kind: "ORDER_ID", value }];
  });
}

export function parseRecruitmentNaturalLanguageIntent(text, { now = new Date().toISOString() } = {}) {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 300) {
    throw new Error("recruitment intent text is invalid");
  }
  const normalized = text.normalize("NFC").trim();
  const orderLocators = extractOrderLocators(normalized);
  const maxOrders = extractQuantity(normalized);
  if (orderLocators) {
    if (maxOrders !== null && maxOrders !== orderLocators.length) {
      return clarification(
        "ORDER_COUNT_CONFLICT",
        { orderLocators, maxOrders },
        `你提供了 ${orderLocators.length} 个订单号，但数量写的是 ${maxOrders} 单。请确认只跑哪些订单号。`,
      );
    }
    return freeze({ kind: "READY", orderLocators });
  }
  const parts = shanghaiDateParts(now);
  const explicit = extractRange(normalized, Number(parts.year));
  const today = /今天/u.test(normalized);
  if (explicit && today) throw new Error("recruitment intent contains conflicting date scopes");
  const createdAtRange = explicit?.createdAtRange ?? (today ? {
    startDate: `${parts.year}-${parts.month}-${parts.day}`,
    endDate: `${parts.year}-${parts.month}-${parts.day}`,
  } : null);
  const creatorName = extractCreatorName(normalized, explicit?.match);
  if (!createdAtRange) {
    const hasQuantity = maxOrders !== null || explicitAll(normalized);
    return clarification(
      hasQuantity ? "DATE_REQUIRED" : "DATE_AND_QUANTITY_REQUIRED",
      { creatorName, maxOrders, all: explicitAll(normalized) },
      hasQuantity
        ? "请提供要处理的日期或日期范围。"
        : "如果没有订单号，请提供日期，并说明处理全部还是指定数量。",
    );
  }
  const all = explicitAll(normalized);
  if (maxOrders === null && !all) {
    return clarification(
      "QUANTITY_REQUIRED",
      { createdAtRange, creatorName },
      "请说明本次处理全部订单，还是指定处理几单。",
    );
  }
  return freeze({ kind: "READY", createdAtRange, creatorName, maxOrders });
}

export function resolveRecruitmentCreator(intent, candidates) {
  if (intent?.kind !== "READY" || typeof intent.creatorName !== "string") {
    throw new Error("a ready named-creator intent is required");
  }
  if (!Array.isArray(candidates)) throw new Error("creator candidates must be an array");
  const ids = new Set();
  for (const candidate of candidates) {
    if (
      candidate === null || typeof candidate !== "object" || Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !== "creatorId,creatorName" ||
      typeof candidate.creatorName !== "string" || typeof candidate.creatorId !== "string"
    ) throw new Error("creator candidate is invalid");
    if (candidate.creatorName.normalize("NFC").trim() === intent.creatorName) ids.add(candidate.creatorId);
  }
  if (ids.size === 0) return freeze({ kind: "NEEDS_HUMAN", reasonCode: "CREATOR_NOT_FOUND" });
  if (ids.size > 1) return freeze({ kind: "NEEDS_HUMAN", reasonCode: "CREATOR_ID_AMBIGUOUS" });
  return freeze({ kind: "RESOLVED", creatorId: [...ids][0] });
}

export function buildRecruitmentBatchManifest({
  intent,
  batchRunId,
  rulesVersion,
  creatorResolution = null,
  schemaVersion = 4,
}) {
  if (intent?.kind !== "READY") throw new Error("a ready recruitment intent is required");
  if (typeof batchRunId !== "string" || typeof rulesVersion !== "string") {
    throw new Error("recruitment manifest bindings are invalid");
  }
  if (Array.isArray(intent.orderLocators)) {
    if (schemaVersion !== 4) throw new Error("order ID recruitment intent requires schemaVersion 4");
    return freeze({
      schemaVersion,
      batchRunId,
      rulesVersion,
      orderType: "RECRUITMENT",
      orderLocators: intent.orderLocators,
      timeZone: "Asia/Shanghai",
    });
  }
  let creatorId = null;
  if (intent.creatorName !== null && schemaVersion < 4) {
    if (creatorResolution?.kind !== "RESOLVED" || typeof creatorResolution.creatorId !== "string") {
      throw new Error("named creator intent requires a resolved creator ID");
    }
    creatorId = creatorResolution.creatorId;
  } else if (creatorResolution?.kind === "RESOLVED") {
    creatorId = creatorResolution.creatorId;
  }
  return freeze({
    schemaVersion,
    batchRunId,
    rulesVersion,
    orderType: "RECRUITMENT",
    createdAtRange: intent.createdAtRange,
    timeZone: "Asia/Shanghai",
    targetScope: schemaVersion === 4
      ? { creatorId, creatorName: intent.creatorName, maxOrders: intent.maxOrders }
      : { creatorId, maxOrders: intent.maxOrders },
  });
}
