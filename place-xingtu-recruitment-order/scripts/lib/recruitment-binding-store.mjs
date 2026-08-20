import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

function integrity(value) {
  const canonical = Object.fromEntries(Object.keys(value)
    .filter((key) => key !== "integritySha256")
    .sort()
    .map((key) => [key, value[key]]));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function validate(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "activityId,integritySha256,orderFingerprint,orderId,runId,schemaVersion" ||
    value.schemaVersion !== 1 ||
    !["runId", "orderId", "activityId"].every((key) => typeof value[key] === "string" && value[key].length > 0) ||
    !/^[a-f0-9]{64}$/u.test(value.orderFingerprint ?? "") ||
    value.integritySha256 !== integrity(value)
  ) throw new Error("recruitment binding cannot be trusted");
  return structuredClone(value);
}

export class RecruitmentBindingStore {
  constructor(applicationDataDirectory) {
    this.directory = join(applicationDataDirectory, "recruitment-bindings");
  }

  pathFor(runId) {
    return join(this.directory, `${createHash("sha256").update(runId).digest("hex")}.json`);
  }

  async read(runId) {
    try {
      const value = validate(JSON.parse(await readFile(this.pathFor(runId), "utf8")));
      if (value.runId !== runId) throw new Error("recruitment binding run mismatch");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(value) {
    const record = validate({ ...structuredClone(value), integritySha256: integrity(value) });
    const existing = await this.read(record.runId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("recruitment binding is immutable");
      return existing;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(record.runId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    return record;
  }
}
