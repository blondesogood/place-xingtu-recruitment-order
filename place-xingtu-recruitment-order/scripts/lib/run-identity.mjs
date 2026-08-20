import { createHash } from "node:crypto";

export function deriveRecruitmentRunId(batchRunId, orderId) {
  for (const [label, value] of [["batchRunId", batchRunId], ["orderId", orderId]]) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value !== value.trim() ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(value)
    ) throw new Error(`recruitment ${label} is invalid`);
  }
  return `rb-${createHash("sha256").update(batchRunId).update("\0").update(orderId).digest("hex")}`;
}
