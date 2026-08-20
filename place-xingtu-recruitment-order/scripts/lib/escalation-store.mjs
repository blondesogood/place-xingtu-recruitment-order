import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createEscalationRecord,
  RECRUITMENT_OPERATION_CODES,
  validateEscalationRecord,
} from "./tier-contract.mjs";

export class EscalationStore {
  constructor(applicationDataDirectory, {
    maximumRecordsPerRun = RECRUITMENT_OPERATION_CODES.length * 3,
  } = {}) {
    if (!Number.isSafeInteger(maximumRecordsPerRun) || maximumRecordsPerRun < 1) {
      throw new Error("escalation record budget is invalid");
    }
    this.directory = join(applicationDataDirectory, "escalations");
    this.maximumRecordsPerRun = maximumRecordsPerRun;
  }

  pathFor(escalationId) {
    return join(
      this.directory,
      `${createHash("sha256").update(escalationId).digest("hex")}.json`,
    );
  }

  async read(escalationId) {
    try {
      const record = validateEscalationRecord(
        JSON.parse(await readFile(this.pathFor(escalationId), "utf8")),
      );
      if (record.escalationId !== escalationId) {
        throw new Error("escalation record binding mismatch");
      }
      return record;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error(`escalation record cannot be trusted: ${error.message}`);
    }
  }

  async listForRun(runId) {
    let names;
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      const record = validateEscalationRecord(
        JSON.parse(await readFile(join(this.directory, name), "utf8")),
      );
      if (record.runId === runId) records.push(record);
    }
    return records.sort((left, right) => left.attemptOrdinal - right.attemptOrdinal);
  }

  async #write(record, { exclusive }) {
    const validated = validateEscalationRecord(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(validated.escalationId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    if (exclusive) {
      try {
        await link(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        if (error.code === "EEXIST") throw new Error("escalation record already exists");
        throw error;
      }
      await unlink(temporary);
      return validated;
    }
    await rename(temporary, destination);
    return validated;
  }

  async create(record) {
    const validated = validateEscalationRecord(record);
    if ((await this.listForRun(validated.runId)).length >= this.maximumRecordsPerRun) {
      throw new Error("escalation record budget exhausted");
    }
    return this.#write(validated, { exclusive: true });
  }

  async replace(record) {
    const validated = validateEscalationRecord(record);
    const current = await this.read(validated.escalationId);
    if (!current) throw new Error("escalation record does not exist");
    for (const key of [
      "runId", "orderId", "operation", "fromTier", "toTier", "stage",
      "rulesVersion", "rulesDigest", "attemptOrdinal", "actionIntentDigest",
    ]) {
      if (current[key] !== validated[key]) {
        throw new Error("escalation record immutable binding changed");
      }
    }
    return this.#write(validated, { exclusive: false });
  }

  async transition(escalationId, patch) {
    const current = await this.read(escalationId);
    if (!current) throw new Error("escalation record does not exist");
    const allowed = new Set(["dispatchState", "disposition", "reasonCode"]);
    if (
      patch === null || typeof patch !== "object" || Array.isArray(patch) ||
      Object.keys(patch).some((key) => !allowed.has(key))
    ) throw new Error("escalation transition patch is invalid");
    const input = { ...current };
    delete input.integritySha256;
    return this.replace(createEscalationRecord({
      ...input,
      ...structuredClone(patch),
    }));
  }
}
