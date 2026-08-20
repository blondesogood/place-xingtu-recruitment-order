import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const fallbackCapabilityMetadata = new WeakMap();

export function readAuthorizedFallback(capability) {
  const metadata = capability && fallbackCapabilityMetadata.get(capability);
  if (!metadata) {
    throw new Error("fallback confirmation capability was not minted by token consumption");
  }
  return structuredClone(metadata);
}

function landingMode(projectType) {
  if (projectType === "DIRECTED_IN_STREAM") return "directedInStream";
  if (projectType === "DIRECTED_CUSTOM") return "directedCustom";
  throw new Error(`unsupported directed project type ${String(projectType)}`);
}

export function planLandingPage({ projectType, defaultAvailability, rules }) {
  const mode = landingMode(projectType);
  if (rules.landingPage.modeApplicability[mode] === false) {
    return { status: "READY", selection: "NO_COMPONENT" };
  }
  if (rules.landingPage.modeApplicability[mode] !== true) {
    return { status: "BLOCKED", code: "LANDING_POLICY_UNDEFINED" };
  }
  if (defaultAvailability === "AVAILABLE") {
    return {
      status: "READY",
      selection: "DEFAULT",
      candidateId: rules.landingPage.defaultId,
    };
  }
  if (defaultAvailability === "UNAVAILABLE") {
    return {
      status: "NEEDS_HUMAN",
      code: "LANDING_DEFAULT_UNAVAILABLE",
      current: {
        candidateId: rules.landingPage.defaultId,
        availability: "UNAVAILABLE",
      },
      candidates: rules.landingPage.fallbackOrder.slice(0, 1),
      impact: "A confirmed fallback changes the landing-page component for this order.",
    };
  }
  return { status: "BLOCKED", code: "LANDING_AVAILABILITY_UNVERIFIED" };
}

function digestToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function progressKey(bindings) {
  return createHash("sha256")
    .update(`${bindings.runId}:${bindings.orderFingerprint}:${bindings.rulesVersion}:${bindings.candidateId}`)
    .digest("hex");
}

function progressIntegrity(record) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(record)))
    .digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== "integritySha256")
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function signRecord(record, token) {
  return createHmac("sha256", token)
    .update(JSON.stringify(canonicalize(record)))
    .digest("hex");
}

function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} cannot be trusted: not an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    const unknown = actual.find((key) => !expected.includes(key));
    throw new Error(`${label} ${unknown ?? "shape"} is not allowed`);
  }
}

function validateBindings(bindings, rules) {
  if (bindings?.rulesVersion !== rules.rulesVersion) {
    throw new Error("fallback confirmation rules version mismatch");
  }
  if (typeof bindings.runId !== "string" || bindings.runId.length === 0) {
    throw new Error("fallback confirmation runId is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(bindings.orderFingerprint ?? "")) {
    throw new Error("fallback confirmation orderFingerprint is invalid");
  }
  if (!rules.landingPage.fallbackOrder.includes(bindings.candidateId)) {
    throw new Error("fallback candidate is not authorized by the current rules");
  }
  const expectedKeys = [...rules.landingPage.fallbackConfirmationGate.tokenBindings].sort();
  if (!isDeepStrictEqual(Object.keys(bindings).sort(), expectedKeys)) {
    throw new Error("fallback confirmation bindings are incomplete");
  }
}

function validateHumanConfirmation(confirmation) {
  if (
    confirmation?.decision !== "CONFIRM_FALLBACK" ||
    !/^[A-Za-z0-9._-]{3,128}$/u.test(confirmation.actorId ?? "") ||
    typeof confirmation.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(confirmation.recordedAt)) ||
    new Date(confirmation.recordedAt).toISOString() !== confirmation.recordedAt
  ) {
    throw new Error("fallback token requires explicit human confirmation with an opaque actorId");
  }
  if (Object.keys(confirmation).some((key) => !["decision", "actorId", "recordedAt"].includes(key))) {
    throw new Error("fallback human confirmation contains an unknown field");
  }
}

function validateDurableRecord(record, token, rules) {
  requireExactKeys(record, [
    "schemaVersion", "bindings", "confirmation", "attemptLimit", "integritySha256",
  ], "fallback confirmation record");
  if (record.schemaVersion !== 1) throw new Error("fallback confirmation record schemaVersion cannot be trusted");
  validateBindings(record.bindings, rules);
  validateHumanConfirmation(record.confirmation);
  if (record.attemptLimit !== 1) throw new Error("fallback confirmation record attemptLimit is invalid");
  if (record.integritySha256 !== signRecord(record, token)) {
    throw new Error("fallback confirmation record integrity check failed");
  }
}

function validateConsumedMarker(marker, token, record) {
  requireExactKeys(marker, [
    "schemaVersion", "consumed", "recordIntegritySha256", "integritySha256",
  ], "consumed marker");
  if (
    marker.schemaVersion !== 1 ||
    marker.consumed !== true ||
    marker.recordIntegritySha256 !== record.integritySha256 ||
    marker.integritySha256 !== signRecord(marker, token)
  ) throw new Error("consumed marker cannot be trusted: integrity mismatch");
}

function validateUnavailableMarker(marker, bindings, rules) {
  requireExactKeys(marker, [
    "schemaVersion", "bindings", "availability", "integritySha256",
  ], "fallback unavailable marker");
  validateBindings(marker.bindings, rules);
  if (
    marker.schemaVersion !== 1 ||
    marker.availability !== "UNAVAILABLE" ||
    !isDeepStrictEqual(marker.bindings, bindings) ||
    marker.integritySha256 !== progressIntegrity(marker)
  ) throw new Error("fallback unavailable marker cannot be trusted");
}

async function writeExclusive(path, value) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class FallbackConfirmationStore {
  constructor(applicationDataDirectory, rules) {
    this.directory = join(applicationDataDirectory, "confirmations", "landing-fallback");
    this.progressDirectory = join(this.directory, "unavailable-attempts");
    this.rules = structuredClone(rules);
  }

  progressPath(bindings) {
    return join(this.progressDirectory, `${progressKey(bindings)}.json`);
  }

  async readUnavailableSequence(bindings) {
    const unavailable = [];
    for (const candidateId of this.rules.landingPage.fallbackOrder) {
      const candidateBindings = { ...bindings, candidateId };
      let marker;
      try {
        marker = JSON.parse(await readFile(this.progressPath(candidateBindings), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") break;
        throw new Error(`fallback unavailable marker cannot be trusted: ${error.message}`);
      }
      validateUnavailableMarker(marker, candidateBindings, this.rules);
      unavailable.push(candidateId);
    }
    return unavailable;
  }

  async issue(bindings, confirmation) {
    validateBindings(bindings, this.rules);
    validateHumanConfirmation(confirmation);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("base64url");
    const digest = digestToken(token);
    const record = {
      schemaVersion: 1,
      bindings: structuredClone(bindings),
      confirmation: structuredClone(confirmation),
      attemptLimit: 1,
    };
    record.integritySha256 = signRecord(record, token);
    await writeExclusive(join(this.directory, `${digest}.json`), record);
    return token;
  }

  async consume(token, bindings) {
    if (typeof token !== "string" || token.length < 32) {
      throw new Error("fallback confirmation token is invalid");
    }
    validateBindings(bindings, this.rules);
    const digest = digestToken(token);
    const recordPath = join(this.directory, `${digest}.json`);
    let record;
    try {
      record = JSON.parse(await readFile(recordPath, "utf8"));
    } catch (error) {
      throw new Error(`fallback confirmation record cannot be trusted: ${error.message}`);
    }
    validateDurableRecord(record, token, this.rules);
    if (!isDeepStrictEqual(record.bindings, bindings)) {
      throw new Error("fallback confirmation token binding mismatch");
    }
    const priorUnavailableCandidates = await this.readUnavailableSequence(bindings);
    const nextCandidate = this.rules.landingPage.fallbackOrder[priorUnavailableCandidates.length];
    if (bindings.candidateId !== nextCandidate) {
      throw new Error(`fallback order requires next fallback ${String(nextCandidate)}`);
    }
    const consumedPath = join(this.directory, `${digest}.consumed`);
    try {
      const marker = JSON.parse(await readFile(consumedPath, "utf8"));
      validateConsumedMarker(marker, token, record);
      throw new Error("fallback confirmation token was already consumed");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const marker = {
      schemaVersion: 1,
      consumed: true,
      recordIntegritySha256: record.integritySha256,
    };
    marker.integritySha256 = signRecord(marker, token);
    try {
      await writeExclusive(consumedPath, marker);
    } catch (error) {
      if (error.code === "EEXIST") {
        let existing;
        try {
          existing = JSON.parse(await readFile(consumedPath, "utf8"));
        } catch (readError) {
          throw new Error(`consumed marker cannot be trusted: ${readError.message}`);
        }
        validateConsumedMarker(existing, token, record);
        throw new Error("fallback confirmation token was already consumed");
      }
      throw error;
    }
    const capability = Object.freeze({
      authorized: true,
      candidateId: bindings.candidateId,
      attemptLimit: 1,
    });
    fallbackCapabilityMetadata.set(capability, {
      bindings: structuredClone(bindings),
      priorUnavailableCandidates,
    });
    return capability;
  }

  async recordUnavailable(capability) {
    const metadata = capability && fallbackCapabilityMetadata.get(capability);
    if (!metadata) throw new Error("fallback unavailable attempt requires a consumed capability");
    const { bindings, priorUnavailableCandidates } = metadata;
    const nextCandidate = this.rules.landingPage.fallbackOrder[priorUnavailableCandidates.length];
    if (bindings.candidateId !== nextCandidate) {
      throw new Error("fallback unavailable attempt is not the next fallback");
    }
    await mkdir(this.progressDirectory, { recursive: true, mode: 0o700 });
    const marker = {
      schemaVersion: 1,
      bindings: structuredClone(bindings),
      availability: "UNAVAILABLE",
    };
    marker.integritySha256 = progressIntegrity(marker);
    try {
      await writeExclusive(this.progressPath(bindings), marker);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(this.progressPath(bindings), "utf8"));
      validateUnavailableMarker(existing, bindings, this.rules);
    }
    return { recorded: true, candidateId: bindings.candidateId };
  }
}
