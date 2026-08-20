import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RECRUITMENT_OPERATION_CODES, TIER_REASON_CODES } from "./tier-contract.mjs";

const statuses = new Set([
  "RUNNING", "WAITING_ASSISTANCE", "WAITING_REREAD", "COMPLETED", "BLOCKED", "HUMAN_GATE_REQUIRED",
]);
const tiers = new Set([
  "EGO_SEMANTIC", "EGO_VISUAL", "HUMAN",
  // Read-only compatibility for rc.7/rc.8 records. New writes use Ego tiers only.
  "SCRIPTED_CHROME", "GPT_CHROME", "COMPUTER_USE",
]);
const dispatchStates = new Set(["NOT_DISPATCHED", "DISPATCHING", "OBSERVED"]);
const keys = [
  "schemaVersion", "escalationId", "batchRunId", "runId", "orderId", "stage",
  "operation", "tabRole", "inputDigest", "tier", "attemptCount", "externalWriteProduced",
  "dispatchState", "status", "reasonCode", "startedAt", "finishedAt", "integritySha256",
];

function canonical(value) {
  return Object.fromEntries(Object.keys(value)
    .filter((key) => key !== "integritySha256")
    .sort()
    .map((key) => [key, value[key]]));
}

function integrity(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function validate(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",") ||
    value.schemaVersion !== 1 ||
    typeof value.escalationId !== "string" || value.escalationId.length < 3 ||
    typeof value.batchRunId !== "string" || value.batchRunId.length < 3 ||
    !(value.runId === null || typeof value.runId === "string") ||
    !(value.orderId === null || typeof value.orderId === "string") ||
    typeof value.stage !== "string" || value.stage.length < 3 ||
    !RECRUITMENT_OPERATION_CODES.includes(value.operation) ||
    !new Set(["PLACEMENT", "XINGTU"]).has(value.tabRole) ||
    !/^[a-f0-9]{64}$/u.test(value.inputDigest ?? "") ||
    !tiers.has(value.tier) ||
    !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 0 || value.attemptCount > 3 ||
    typeof value.externalWriteProduced !== "boolean" ||
    !dispatchStates.has(value.dispatchState) ||
    !statuses.has(value.status) ||
    !(value.reasonCode === null || TIER_REASON_CODES.includes(value.reasonCode)) ||
    typeof value.startedAt !== "string" || new Date(value.startedAt).toISOString() !== value.startedAt ||
    !(value.finishedAt === null || (typeof value.finishedAt === "string" && new Date(value.finishedAt).toISOString() === value.finishedAt)) ||
    value.integritySha256 !== integrity(value)
  ) throw new Error("active recruitment operation cannot be trusted");
  return structuredClone(value);
}

export class ActiveOperationStore {
  constructor(applicationDataDirectory) {
    this.directory = join(applicationDataDirectory, "active-operations");
  }

  pathFor(escalationId) {
    return join(this.directory, `${createHash("sha256").update(escalationId).digest("hex")}.json`);
  }

  async read(escalationId) {
    try {
      const value = validate(JSON.parse(await readFile(this.pathFor(escalationId), "utf8")));
      if (value.escalationId !== escalationId) throw new Error("active operation binding mismatch");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value) {
    const record = validate({ ...structuredClone(value), integritySha256: integrity(value) });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(record.escalationId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    return record;
  }

  async update(escalationId, patch) {
    const current = await this.read(escalationId);
    if (!current) throw new Error("active recruitment operation is missing");
    return this.write({ ...current, ...structuredClone(patch), escalationId });
  }

  async listForBatch(batchRunId) {
    let names;
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const name of names.filter((value) => value.endsWith(".json"))) {
      const value = validate(JSON.parse(await readFile(join(this.directory, name), "utf8")));
      if (value.batchRunId === batchRunId) records.push(value);
    }
    return records.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }
}
