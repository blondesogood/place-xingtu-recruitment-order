import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeShanghaiCreatedAtRange } from "./manifest.mjs";

export const RECRUITMENT_DATE_DISCOVERY_MODES = Object.freeze([
  "TABLE_FIRST",
  "FILTER_FIRST",
]);

export const RECRUITMENT_DATE_FALLBACK_REASONS = Object.freeze([
  "INSUFFICIENT_VISIBLE_MATCHES",
  "DATE_COVERAGE_UNPROVEN",
  "CREATOR_ID_UNPROVEN",
]);

function clone(value) {
  return structuredClone(value);
}

function canonical(value) {
  return Object.fromEntries(Object.keys(value)
    .filter((key) => key !== "integritySha256")
    .sort()
    .map((key) => [key, value[key]]));
}

function integrity(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function scopeMaxOrders(manifest) {
  const maxOrders = manifest?.targetScope?.maxOrders ?? null;
  if (maxOrders !== null && (!Number.isSafeInteger(maxOrders) || maxOrders < 1)) {
    throw new Error("recruitment date discovery maxOrders is invalid");
  }
  return maxOrders;
}

export function selectRecruitmentDateDiscoveryMode(manifest) {
  const range = normalizeShanghaiCreatedAtRange(manifest?.createdAtRange);
  const maxOrders = scopeMaxOrders(manifest);
  const singleDay = Date.parse(range.endExclusive) - Date.parse(range.start) === 24 * 60 * 60 * 1000;
  return singleDay && maxOrders !== null && maxOrders <= 3
    ? "TABLE_FIRST"
    : "FILTER_FIRST";
}

function binding(manifest) {
  return {
    batchRunId: manifest.batchRunId,
    rulesVersion: manifest.rulesVersion,
    range: normalizeShanghaiCreatedAtRange(manifest.createdAtRange),
    maxOrders: scopeMaxOrders(manifest),
    initialMode: selectRecruitmentDateDiscoveryMode(manifest),
  };
}

function validate(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [
      "schemaVersion", "batchRunId", "rulesVersion", "range", "maxOrders", "initialMode",
      "currentMode", "fallbackReason", "status", "integritySha256",
    ].sort().join(",") ||
    value.schemaVersion !== 1 ||
    typeof value.batchRunId !== "string" || value.batchRunId.length < 3 ||
    typeof value.rulesVersion !== "string" || value.rulesVersion.length < 3 ||
    value.range === null || typeof value.range !== "object" || Array.isArray(value.range) ||
    Object.keys(value.range).sort().join(",") !== "endExclusive,start" ||
    ![value.range.start, value.range.endExclusive].every((entry) => typeof entry === "string") ||
    !(value.maxOrders === null || (Number.isSafeInteger(value.maxOrders) && value.maxOrders > 0)) ||
    !RECRUITMENT_DATE_DISCOVERY_MODES.includes(value.initialMode) ||
    !RECRUITMENT_DATE_DISCOVERY_MODES.includes(value.currentMode) ||
    !(value.fallbackReason === null || RECRUITMENT_DATE_FALLBACK_REASONS.includes(value.fallbackReason)) ||
    !new Set(["READY", "COMPLETED"]).has(value.status) ||
    (value.initialMode === "FILTER_FIRST" && (value.currentMode !== "FILTER_FIRST" || value.fallbackReason !== null)) ||
    (value.currentMode === "TABLE_FIRST" && value.fallbackReason !== null) ||
    (value.fallbackReason !== null && value.currentMode !== "FILTER_FIRST") ||
    value.integritySha256 !== integrity(value)
  ) throw new Error("recruitment date discovery state cannot be trusted");
  return clone(value);
}

export class RecruitmentDateDiscoveryStore {
  constructor(applicationDataDirectory) {
    this.directory = join(applicationDataDirectory, "recruitment-date-discovery");
  }

  pathFor(batchRunId) {
    return join(this.directory, `${createHash("sha256").update(batchRunId).digest("hex")}.json`);
  }

  async read(batchRunId) {
    try {
      const value = validate(JSON.parse(await readFile(this.pathFor(batchRunId), "utf8")));
      if (value.batchRunId !== batchRunId) throw new Error("recruitment date discovery binding mismatch");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value) {
    const record = validate({ ...clone(value), integritySha256: integrity(value) });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(record.batchRunId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    return record;
  }

  async initialize(manifest) {
    const expected = binding(manifest);
    const existing = await this.read(expected.batchRunId);
    if (existing) {
      for (const key of ["rulesVersion", "range", "maxOrders", "initialMode"]) {
        if (JSON.stringify(existing[key]) !== JSON.stringify(expected[key])) {
          throw new Error("recruitment date discovery manifest binding mismatch");
        }
      }
      return existing;
    }
    return this.write({
      schemaVersion: 1,
      ...expected,
      currentMode: expected.initialMode,
      fallbackReason: null,
      status: "READY",
    });
  }

  async fallback(batchRunId, reason) {
    if (!RECRUITMENT_DATE_FALLBACK_REASONS.includes(reason)) {
      throw new Error("recruitment date discovery fallback reason is invalid");
    }
    const state = await this.read(batchRunId);
    if (!state) throw new Error("recruitment date discovery state is missing");
    if (state.currentMode === "FILTER_FIRST") return state;
    state.currentMode = "FILTER_FIRST";
    state.fallbackReason = reason;
    state.status = "READY";
    return this.write(state);
  }

  async complete(batchRunId) {
    const state = await this.read(batchRunId);
    if (!state) throw new Error("recruitment date discovery state is missing");
    state.status = "COMPLETED";
    return this.write(state);
  }
}
