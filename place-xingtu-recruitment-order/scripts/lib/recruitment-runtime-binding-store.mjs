import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  const keys = [
    "schemaVersion", "batchRunId", "candidateVersion", "runtimeFingerprint",
    "integritySha256",
  ];
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    value.schemaVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(value.batchRunId ?? "") ||
    !/^\d+\.\d+\.\d+-rc\.\d+$/u.test(value.candidateVersion ?? "") ||
    !/^[a-f0-9]{64}$/u.test(value.runtimeFingerprint ?? "") ||
    value.integritySha256 !== integrity(value)
  ) throw new Error("recruitment runtime binding cannot be trusted");
  return structuredClone(value);
}

export class RecruitmentRuntimeVersionError extends Error {
  constructor(message = "recruitment runtime version changed during the batch") {
    super(message);
    this.name = "RecruitmentRuntimeVersionError";
    this.reasonCode = "RUNTIME_VERSION_MISMATCH";
  }
}

export class RecruitmentRuntimeBindingStore {
  constructor(applicationDataDirectory) {
    this.directory = join(applicationDataDirectory, "runtime-bindings");
  }

  pathFor(batchRunId) {
    return join(this.directory, `${createHash("sha256").update(batchRunId).digest("hex")}.json`);
  }

  async read(batchRunId) {
    try {
      const record = validate(JSON.parse(await readFile(this.pathFor(batchRunId), "utf8")));
      if (record.batchRunId !== batchRunId) throw new Error("recruitment runtime batch binding mismatch");
      return record;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async ensure({ batchRunId, candidateVersion, runtimeFingerprint, hasStatefulDispatch }) {
    const existing = await this.read(batchRunId);
    if (existing === null && hasStatefulDispatch) {
      throw new RecruitmentRuntimeVersionError("an old stateful batch has no locked runtime binding");
    }
    if (existing !== null) {
      if (
        existing.candidateVersion !== candidateVersion ||
        existing.runtimeFingerprint !== runtimeFingerprint
      ) throw new RecruitmentRuntimeVersionError();
      return existing;
    }
    const record = {
      schemaVersion: 1,
      batchRunId,
      candidateVersion,
      runtimeFingerprint,
      integritySha256: "",
    };
    record.integritySha256 = integrity(record);
    const validated = validate(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(batchRunId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    return validated;
  }
}
