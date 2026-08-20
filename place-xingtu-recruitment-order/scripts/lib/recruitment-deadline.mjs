function requireDeadlineRule(rules) {
  const deadline = rules?.recruitment?.deliveryDeadline;
  if (
    !new Set(["ORDER_CALENDAR_MONTH_END", "CURRENT_OPERATION_CALENDAR_MONTH_END"]).has(deadline?.basis)
    || deadline?.timeZone !== "Asia/Shanghai"
    || deadline?.internalPlannedPublishDatePolicy !== "IGNORE"
  ) {
    throw new Error("trusted recruitment delivery deadline rule is required");
  }
  return deadline;
}

export function deriveRecruitmentDeliveryDeadline({ orderedAt, rules } = {}) {
  const deadline = requireDeadlineRule(rules);
  if (typeof orderedAt !== "string" || orderedAt.length === 0) {
    throw new Error("orderedAt must be an ISO timestamp");
  }
  const instant = new Date(orderedAt);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("orderedAt must be an ISO timestamp");
  }

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: deadline.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${parts.year}-${parts.month}-${String(lastDay).padStart(2, "0")}`;
}
