import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { requireTrustedRules } from "./rules.mjs";

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

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function exactKeys(value, keys, label) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  ) throw new Error(`${label} shape cannot be trusted`);
}

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} is invalid`);
  }
}

function validateObservation(value, rules) {
  exactKeys(value, [
    "runId", "orderId", "activityId", "beforeTotalBudgetMinorUnits",
    "afterTotalBudgetMinorUnits", "stepMinorUnits", "operationInstant",
    "deliveryDeadline", "evidenceDigest",
  ], "recruitment budget observation");
  for (const key of ["runId", "orderId", "activityId"]) identifier(value[key], `recruitment budget ${key}`);
  if (
    !Number.isSafeInteger(value.beforeTotalBudgetMinorUnits) ||
    !Number.isSafeInteger(value.afterTotalBudgetMinorUnits) ||
    value.beforeTotalBudgetMinorUnits < 0 ||
    value.afterTotalBudgetMinorUnits - value.beforeTotalBudgetMinorUnits !== rules.recruitment.budgetTopUp.stepMinorUnits ||
    value.stepMinorUnits !== rules.recruitment.budgetTopUp.stepMinorUnits ||
    typeof value.operationInstant !== "string" ||
    new Date(value.operationInstant).toISOString() !== value.operationInstant ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value.deliveryDeadline) ||
    !/^[a-f0-9]{64}$/u.test(value.evidenceDigest) ||
    value.evidenceDigest !== digest({
      runId: value.runId,
      orderId: value.orderId,
      activityId: value.activityId,
      beforeTotalBudgetMinorUnits: value.beforeTotalBudgetMinorUnits,
      afterTotalBudgetMinorUnits: value.afterTotalBudgetMinorUnits,
      stepMinorUnits: value.stepMinorUnits,
      operationInstant: value.operationInstant,
      deliveryDeadline: value.deliveryDeadline,
    })
  ) throw new Error("recruitment budget observation cannot be trusted");
  return structuredClone(value);
}

function validateState(value, rules) {
  exactKeys(value, [
    "schemaVersion", "batchRunId", "rulesVersion", "totalTopUps",
    "activityCounts", "observations", "integritySha256",
  ], "recruitment budget state");
  identifier(value.batchRunId, "recruitment budget batchRunId");
  if (
    value.schemaVersion !== 1 ||
    value.rulesVersion !== rules.rulesVersion ||
    !Number.isSafeInteger(value.totalTopUps) ||
    value.totalTopUps < 0 ||
    value.totalTopUps > rules.recruitment.budgetTopUp.maxPerBatch ||
    !Array.isArray(value.activityCounts) ||
    !Array.isArray(value.observations) ||
    value.integritySha256 !== digest(value)
  ) throw new Error("recruitment budget state cannot be trusted");
  const activities = new Set();
  let countTotal = 0;
  for (const entry of value.activityCounts) {
    exactKeys(entry, ["activityId", "count"], "recruitment budget activity count");
    identifier(entry.activityId, "recruitment budget activityId");
    if (
      activities.has(entry.activityId) ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 1 ||
      entry.count > rules.recruitment.budgetTopUp.maxPerActivityPerBatch
    ) throw new Error("recruitment budget activity count cannot be trusted");
    activities.add(entry.activityId);
    countTotal += entry.count;
  }
  const observations = value.observations.map((entry) => validateObservation(entry, rules));
  if (
    countTotal !== value.totalTopUps ||
    observations.length !== value.totalTopUps ||
    new Set(observations.map(({ runId }) => runId)).size !== observations.length
  ) throw new Error("recruitment budget state counts cannot be trusted");
  return structuredClone({ ...value, observations });
}

export class RecruitmentBudgetStore {
  constructor(applicationDataDirectory, rules) {
    this.rules = requireTrustedRules(rules);
    if (!this.rules.recruitment?.budgetTopUp) {
      throw new Error("recruitment budget store requires the issued top-up policy");
    }
    this.directory = join(applicationDataDirectory, "recruitment-budget-topups");
  }

  pathFor(batchRunId) {
    return join(this.directory, `${createHash("sha256").update(batchRunId).digest("hex")}.json`);
  }

  async read(batchRunId) {
    try {
      const value = validateState(JSON.parse(await readFile(this.pathFor(batchRunId), "utf8")), this.rules);
      if (value.batchRunId !== batchRunId) throw new Error("recruitment budget batch binding mismatch");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async #write(value) {
    const state = validateState({ ...structuredClone(value), integritySha256: digest(value) }, this.rules);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(state.batchRunId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    return state;
  }

  async checkAllowed(batchRunId, activityId) {
    identifier(batchRunId, "recruitment budget batchRunId");
    identifier(activityId, "recruitment budget activityId");
    const state = await this.read(batchRunId);
    const activityCount = state?.activityCounts.find((entry) => entry.activityId === activityId)?.count ?? 0;
    return Object.freeze({
      allowed:
        activityCount < this.rules.recruitment.budgetTopUp.maxPerActivityPerBatch &&
        (state?.totalTopUps ?? 0) < this.rules.recruitment.budgetTopUp.maxPerBatch,
      activityCount,
      totalTopUps: state?.totalTopUps ?? 0,
    });
  }

  async recordObserved(input) {
    exactKeys(input, [
      "batchRunId", "runId", "orderId", "activityId",
      "beforeTotalBudgetMinorUnits", "afterTotalBudgetMinorUnits",
      "operationInstant", "deliveryDeadline",
    ], "recruitment budget observed input");
    const prior = await this.read(input.batchRunId);
    const existing = prior?.observations.find(({ runId }) => runId === input.runId);
    if (existing) return Object.freeze(structuredClone(existing));
    const allowance = await this.checkAllowed(input.batchRunId, input.activityId);
    if (!allowance.allowed) throw new Error("recruitment budget top-up limit reached");
    const observation = validateObservation({
      runId: input.runId,
      orderId: input.orderId,
      activityId: input.activityId,
      beforeTotalBudgetMinorUnits: input.beforeTotalBudgetMinorUnits,
      afterTotalBudgetMinorUnits: input.afterTotalBudgetMinorUnits,
      stepMinorUnits: this.rules.recruitment.budgetTopUp.stepMinorUnits,
      operationInstant: input.operationInstant,
      deliveryDeadline: input.deliveryDeadline,
      evidenceDigest: digest({
        runId: input.runId,
        orderId: input.orderId,
        activityId: input.activityId,
        beforeTotalBudgetMinorUnits: input.beforeTotalBudgetMinorUnits,
        afterTotalBudgetMinorUnits: input.afterTotalBudgetMinorUnits,
        stepMinorUnits: this.rules.recruitment.budgetTopUp.stepMinorUnits,
        operationInstant: input.operationInstant,
        deliveryDeadline: input.deliveryDeadline,
      }),
    }, this.rules);
    const state = prior ?? {
      schemaVersion: 1,
      batchRunId: input.batchRunId,
      rulesVersion: this.rules.rulesVersion,
      totalTopUps: 0,
      activityCounts: [],
      observations: [],
    };
    const activity = state.activityCounts.find((entry) => entry.activityId === input.activityId);
    if (activity) activity.count += 1;
    else state.activityCounts.push({ activityId: input.activityId, count: 1 });
    state.activityCounts.sort((left, right) => left.activityId.localeCompare(right.activityId));
    state.totalTopUps += 1;
    state.observations.push(observation);
    await this.#write(state);
    return Object.freeze(structuredClone(observation));
  }
}
