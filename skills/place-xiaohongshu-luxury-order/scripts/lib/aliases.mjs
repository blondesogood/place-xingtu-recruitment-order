const BRAND_CANONICAL = "爱回收奢品回收";
const BRAND_ALIASES = new Set(["爱回收奢品回收", "爱回收奢侈品回收"]);

const INTERNAL_STATUS = Object.freeze({
  待商务下单: "WAITING_EXTERNAL_TASK_ID",
  商务已下单: "WRITEBACK_DONE",
  WAITING_EXTERNAL_TASK_ID: "WAITING_EXTERNAL_TASK_ID",
  WRITEBACK_DONE: "WRITEBACK_DONE",
});

const EXTERNAL_STATUS = Object.freeze({
  待合作人接受: "PENDING",
  价格待协商: "PENDING",
  待支付订单: "WAITING_PAYMENT",
  待合作人提交笔记: "PAID_WAITING_NOTE",
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  WAITING_PAYMENT: "WAITING_PAYMENT",
  PAID_WAITING_NOTE: "PAID_WAITING_NOTE",
  CANCELED: "CANCELED",
  REJECTED: "REJECTED",
  PLATFORM_CLOSED: "PLATFORM_CLOSED",
  PAID: "PAID",
  COMPLETED: "COMPLETED",
  CLOSED: "CLOSED",
  已完成: "COMPLETED",
  已取消: "CLOSED",
  已关闭: "CLOSED",
  合作已关闭: "CLOSED",
});

export const CANONICAL_BRAND = BRAND_CANONICAL;
export const REQUIRED_SPUS = Object.freeze(["爱回收app", "爱回收奢品回收"]);

export function normalizeBrandLabel(value) {
  const text = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!text) return null;
  return BRAND_ALIASES.has(text) ? BRAND_CANONICAL : text;
}

export function brandsEquivalent(left, right) {
  const a = normalizeBrandLabel(left);
  const b = normalizeBrandLabel(right);
  return Boolean(a && a === b);
}

export function canonicalizeInternalStatus(value) {
  const text = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  return INTERNAL_STATUS[text] ?? null;
}

export function canonicalizeExternalStatus(value) {
  const text = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (EXTERNAL_STATUS[text]) return EXTERNAL_STATUS[text];
  if (text.includes("待合作人提交笔记")) return "PAID_WAITING_NOTE";
  if (text.includes("待支付")) return "WAITING_PAYMENT";
  if (text.includes("待合作人接受") || text.includes("价格待协商")) return "PENDING";
  return null;
}

export function canonicalizeCandidateStatus(value) {
  const text = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!text) return null;
  if (text === "PENDING" || text.includes("待合作人接受") || text.includes("价格待协商")) return "PENDING";
  if (text === "WAITING_PAYMENT" || (text.includes("待支付") && !text.includes("待合作人提交笔记"))) {
    return "WAITING_PAYMENT";
  }
  if (text === "PAID_WAITING_NOTE" || text.includes("待合作人提交笔记")) return "PAID_WAITING_NOTE";
  if (text === "OTHER") return "OTHER";
  return "OTHER";
}

export function isNegotiatedPricePending(value) {
  const text = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  return text === "价格待协商";
}

export function spuSetEqualsRequired(labels) {
  if (!Array.isArray(labels)) return false;
  const normalized = labels.map((item) => String(item ?? "").normalize("NFKC").trim()).sort();
  return JSON.stringify(normalized) === JSON.stringify([...REQUIRED_SPUS].sort());
}

// The current Ant control renders the account label followed by its platform ID.
export function parseAdvertiserSelection(value) {
  if(value==='上海悦川')return {label:'上海悦川',externalId:null};
  const match=String(value??'').trim().match(/^上海悦川\s*[（(]([a-f0-9]{24})[)）]$/);
  return match?{label:'上海悦川',externalId:match[1]}:null;
}
