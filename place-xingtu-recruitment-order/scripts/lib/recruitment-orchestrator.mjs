import { createHash, randomUUID } from "node:crypto";

import {
  createEscalationRecord,
  RECRUITMENT_OPERATION_CODES,
  STATEFUL_RECRUITMENT_OPERATIONS,
  TIER_REASON_CODES,
  validateTierAttempt,
} from "./tier-contract.mjs";
import { planRecovery } from "./recovery.mjs";

const humanGateReasons = new Set([
  "LOGIN_REQUIRED",
  "CAPTCHA_REQUIRED",
  "SECURITY_VERIFICATION_REQUIRED",
  "ACCOUNT_MISMATCH",
  "ORDER_BINDING_AMBIGUOUS",
  "ACTION_RESULT_UNKNOWN",
  "NON_OCCURRENCE_UNPROVEN",
  "TIER_BUDGET_EXHAUSTED",
  "VISUAL_COMMIT_REQUIRED",
  "PLUGIN_REQUIRED",
  "ROLE_SWITCH_FAILED",
  "BUDGET_ERROR_UNRECOGNIZED",
  "BUDGET_TOPUP_LIMIT_REACHED",
  "BUDGET_TOPUP_RESULT_UNKNOWN",
  "PUBLISH_RESULT_UNKNOWN",
]);

function frozen(value) {
  return Object.freeze(structuredClone(value));
}

function rulesDigest(rules) {
  if (/^[a-f0-9]{64}$/u.test(rules?.integritySha256 ?? "")) {
    return rules.integritySha256;
  }
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex");
}

function requireBindings(input) {
  if (
    input === null || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "batchRunId,orderId,runId" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(input.batchRunId ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(input.runId ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(input.orderId ?? "")
  ) throw new Error("recruitment orchestrator bindings are invalid");
  return frozen(input);
}

function validateCommand(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "actionIntentDigest,operation,stage" ||
    !RECRUITMENT_OPERATION_CODES.includes(value.operation) ||
    !/^[A-Z][A-Z0-9_]{2,63}$/u.test(value.stage ?? "")
  ) throw new Error("recruitment command is invalid");
  const stateful = STATEFUL_RECRUITMENT_OPERATIONS.includes(value.operation);
  if (stateful !== /^[a-f0-9]{64}$/u.test(value.actionIntentDigest ?? "")) {
    if (!stateful && value.actionIntentDigest === null) return frozen(value);
    throw new Error("recruitment command action intent binding is invalid");
  }
  return frozen(value);
}

function validateAdapterOutcome(value) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "dispatchState,outcome,reasonCode" ||
    !new Set(["COMPLETED", "ESCALATE", "BLOCKED", "HUMAN_REQUIRED"]).has(value.outcome) ||
    !new Set(["NOT_DISPATCHED", "DISPATCHING", "OBSERVED"]).has(value.dispatchState) ||
    (value.outcome === "COMPLETED" ? value.reasonCode !== null : !TIER_REASON_CODES.includes(value.reasonCode))
  ) throw new Error("scripted adapter returned an invalid typed outcome");
  return frozen(value);
}

function withoutIntegrity(record) {
  const value = { ...record };
  delete value.integritySha256;
  return value;
}

function assertAttemptMatches(record, attempt) {
  const expected = {
    escalationId: record.escalationId,
    runId: record.runId,
    orderId: record.orderId,
    operation: record.operation,
    tier: record.toTier,
    stage: record.stage,
    rulesVersion: record.rulesVersion,
    rulesDigest: record.rulesDigest,
    attemptOrdinal: record.attemptOrdinal,
    actionIntentDigest: record.actionIntentDigest,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (attempt[key] !== value) throw new Error(`tier attempt ${key} binding mismatch`);
  }
}

function mutationBinding(record) {
  return frozen({
    runId: record.runId,
    orderId: record.orderId,
    operation: record.operation,
    stage: record.stage,
    actionIntentDigest: record.actionIntentDigest,
  });
}

export class RecruitmentOrchestrator {
  constructor({ rules, uiContract, stores, scriptedAdapter, clock }) {
    const tierOrder = uiContract?.executionBoundary?.tierOrder?.join(",");
    if (
      typeof rules?.rulesVersion !== "string" ||
      !new Set([
        "SCRIPTED_CHROME,GPT_CHROME,COMPUTER_USE,HUMAN",
        "EGO_SEMANTIC,EGO_VISUAL,HUMAN",
      ]).has(tierOrder) ||
      typeof stores?.escalations?.create !== "function" ||
      typeof stores?.escalations?.read !== "function" ||
      typeof stores?.escalations?.replace !== "function" ||
      typeof stores?.escalations?.listForRun !== "function" ||
      typeof stores?.mutations?.runExclusive !== "function" ||
      typeof scriptedAdapter?.nextCommand !== "function" ||
      typeof scriptedAdapter?.attempt !== "function" ||
      typeof clock !== "function"
    ) throw new Error("recruitment orchestrator dependencies are invalid");
    this.rules = rules;
    this.uiContract = uiContract;
    this.stores = stores;
    this.scriptedAdapter = scriptedAdapter;
    this.clock = clock;
    this.rulesDigest = rulesDigest(rules);
    this.egoOnly = tierOrder === "EGO_SEMANTIC,EGO_VISUAL,HUMAN";
    this.baseTier = this.egoOnly ? "EGO_SEMANTIC" : "SCRIPTED_CHROME";
    this.visualTier = this.egoOnly ? "EGO_VISUAL" : "COMPUTER_USE";
    this.intermediateTier = this.egoOnly ? "EGO_VISUAL" : "GPT_CHROME";
  }

  #record({ bindings, command, fromTier, toTier, reasonCode, attemptOrdinal, dispatchState }) {
    return createEscalationRecord({
      schemaVersion: 1,
      escalationId: `esc-${randomUUID()}`,
      runId: bindings.runId,
      orderId: bindings.orderId,
      operation: command.operation,
      fromTier,
      toTier,
      reasonCode,
      stage: command.stage,
      rulesVersion: this.rules.rulesVersion,
      rulesDigest: this.rulesDigest,
      attemptOrdinal,
      actionIntentDigest: command.actionIntentDigest,
      dispatchState,
      disposition: "PENDING",
    });
  }

  async #replace(record, patch) {
    return this.stores.escalations.replace(createEscalationRecord({
      ...withoutIntegrity(record),
      ...patch,
    }));
  }

  async #create(record) {
    if (!STATEFUL_RECRUITMENT_OPERATIONS.includes(record.operation)) {
      return this.stores.escalations.create(record);
    }
    return this.stores.mutations.runExclusive(frozen({
      runId: record.runId,
      orderId: record.orderId,
      operation: record.operation,
      stage: record.stage,
      actionIntentDigest: record.actionIntentDigest,
    }), () => this.stores.escalations.create(record));
  }

  async #consumeConfirmation(bindings, command) {
    if (!STATEFUL_RECRUITMENT_OPERATIONS.includes(command.operation)) return;
    if (typeof this.stores.confirmations?.consume !== "function") {
      throw new Error("stateful recruitment operation requires exact action-time confirmation");
    }
    await this.stores.confirmations.consume(frozen({
      runId: bindings.runId,
      orderId: bindings.orderId,
      operation: command.operation,
      stage: command.stage,
      rulesVersion: this.rules.rulesVersion,
      actionIntentDigest: command.actionIntentDigest,
    }));
  }

  async #statefulAttemptOrdinal(bindings, command) {
    if (!STATEFUL_RECRUITMENT_OPERATIONS.includes(command.operation)) return 1;
    const records = await this.stores.escalations.listForRun(bindings.runId);
    const related = records.filter((record) => (
      record.operation === command.operation &&
      record.orderId === bindings.orderId &&
      record.actionIntentDigest === command.actionIntentDigest
    ));
    const ordinal = related.reduce(
      (maximum, record) => Math.max(maximum, record.attemptOrdinal),
      0,
    ) + 1;
    if (related.some((record) => record.dispatchState === "OBSERVED")) return null;
    const unknownDispatch = related.some((record) => record.dispatchState === "DISPATCHING");
    if (!unknownDispatch) return ordinal;
    if (
      this.stores.recovery?.plan !== planRecovery ||
      typeof this.stores.recovery?.read !== "function"
    ) return null;
    const decision = planRecovery(await this.stores.recovery.read(frozen({
      batchRunId: bindings.batchRunId,
      runId: bindings.runId,
      orderId: bindings.orderId,
      operation: command.operation,
      actionIntentDigest: command.actionIntentDigest,
    })));
    if (command.operation === "TOP_UP_RECRUITMENT_BUDGET") return null;
    const expectedMode = command.operation === "SUBMIT_RECRUITMENT_ORDER"
      ? "RETRY_PUBLISH"
      : "RETRY_CONFIRM";
    return decision?.status === "RESUME" && decision.mode === expectedMode
      ? ordinal
      : null;
  }

  async advance(input) {
    const bindings = requireBindings(input);
    const command = validateCommand(await this.scriptedAdapter.nextCommand(bindings));
    const attemptOrdinal = await this.#statefulAttemptOrdinal(bindings, command);
    if (attemptOrdinal === null) {
      return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "NON_OCCURRENCE_UNPROVEN" });
    }
    if (attemptOrdinal > 3) {
      return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "TIER_BUDGET_EXHAUSTED" });
    }
    let dispatchRecord = null;
    const beforeDispatch = async () => {
      if (dispatchRecord) throw new Error("stateful action dispatch hook may run only once");
      await this.#consumeConfirmation(bindings, command);
      dispatchRecord = this.#record({
        bindings,
        command,
        fromTier: this.baseTier,
        toTier: this.baseTier,
        reasonCode: "VISUAL_COMMIT_REQUIRED",
        attemptOrdinal,
        dispatchState: "DISPATCHING",
      });
      await this.#create(dispatchRecord);
    };

    let outcome;
    try {
      outcome = validateAdapterOutcome(
        await this.scriptedAdapter.attempt(command, { beforeDispatch }),
      );
    } catch (error) {
      if (!dispatchRecord) throw error;
      await this.#replace(dispatchRecord, {
        disposition: "HUMAN_REQUIRED",
        reasonCode: "ACTION_RESULT_UNKNOWN",
      });
      return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "ACTION_RESULT_UNKNOWN" });
    }

    if (dispatchRecord) {
      if (outcome.dispatchState !== "OBSERVED" || outcome.outcome !== "COMPLETED") {
        await this.#replace(dispatchRecord, {
          disposition: "HUMAN_REQUIRED",
          reasonCode: "ACTION_RESULT_UNKNOWN",
        });
        return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "ACTION_RESULT_UNKNOWN" });
      }
      await this.#replace(dispatchRecord, { dispatchState: "OBSERVED", disposition: "RESOLVED" });
      return frozen({ kind: "COMPLETED" });
    }

    if (
      STATEFUL_RECRUITMENT_OPERATIONS.includes(command.operation) &&
      (outcome.outcome === "COMPLETED" || outcome.dispatchState !== "NOT_DISPATCHED")
    ) {
      const unknown = this.#record({
        bindings,
        command,
        fromTier: this.baseTier,
        toTier: this.baseTier,
        reasonCode: "ACTION_RESULT_UNKNOWN",
        attemptOrdinal,
        dispatchState: "DISPATCHING",
      });
      await this.#create(createEscalationRecord({
        ...withoutIntegrity(unknown),
        disposition: "HUMAN_REQUIRED",
      }));
      return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "ACTION_RESULT_UNKNOWN" });
    }

    if (outcome.outcome === "COMPLETED") return frozen({ kind: "COMPLETED" });
    if (outcome.outcome === "BLOCKED") return frozen({ kind: "BLOCKED", reasonCode: outcome.reasonCode });
    if (outcome.outcome === "HUMAN_REQUIRED") {
      if (!humanGateReasons.has(outcome.reasonCode)) {
        return frozen({ kind: "BLOCKED", reasonCode: outcome.reasonCode });
      }
      return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: outcome.reasonCode });
    }

    const stateful = STATEFUL_RECRUITMENT_OPERATIONS.includes(command.operation);
    if (stateful) await this.#consumeConfirmation(bindings, command);
    const toTier = this.egoOnly
      ? "EGO_VISUAL"
      : outcome.reasonCode === "VISUAL_COMMIT_REQUIRED" ? "COMPUTER_USE" : "GPT_CHROME";
    const record = this.#record({
      bindings,
      command,
      fromTier: this.baseTier,
      toTier,
      reasonCode: outcome.reasonCode,
      attemptOrdinal,
      dispatchState: stateful ? "DISPATCHING" : "NOT_DISPATCHED",
    });
    await this.#create(record);
    return frozen({
      kind: "ASSISTANCE_REQUIRED",
      escalationId: record.escalationId,
      operation: record.operation,
      reasonCode: record.reasonCode,
      toTier,
    });
  }

  async resume(input) {
    if (
      input === null || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "attempt,escalationId"
    ) throw new Error("recruitment resume input is invalid");
    const record = await this.stores.escalations.read(input.escalationId);
    if (!record || record.disposition !== "PENDING") {
      throw new Error("recruitment escalation is missing or no longer pending");
    }
    const attempt = validateTierAttempt(input.attempt);
    assertAttemptMatches(record, attempt);

    if (record.dispatchState === "DISPATCHING" && attempt.dispatchState === "DISPATCHING") {
      await this.#replace(record, {
        disposition: "HUMAN_REQUIRED",
        reasonCode: "ACTION_RESULT_UNKNOWN",
      });
      return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "ACTION_RESULT_UNKNOWN" });
    }

    if (attempt.outcome === "ESCALATE") {
      return this.stores.mutations.runExclusive(mutationBinding(record), async () => {
        const claimed = await this.stores.escalations.read(input.escalationId);
        if (!claimed || claimed.disposition !== "PENDING") {
          throw new Error("recruitment escalation was already consumed");
        }
        assertAttemptMatches(claimed, attempt);
        if (claimed.toTier === this.visualTier) {
          await this.#replace(claimed, {
            dispatchState: attempt.dispatchState,
            disposition: "HUMAN_REQUIRED",
            reasonCode: "TIER_BUDGET_EXHAUSTED",
          });
          return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "TIER_BUDGET_EXHAUSTED" });
        }
        if (claimed.toTier !== this.intermediateTier) {
          throw new Error("only the intermediate execution tier may escalate to the visual tier");
        }
        const nextOrdinal = claimed.attemptOrdinal + 1;
        if (nextOrdinal > 3) {
          await this.#replace(claimed, {
            disposition: "HUMAN_REQUIRED",
            reasonCode: "TIER_BUDGET_EXHAUSTED",
          });
          return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode: "TIER_BUDGET_EXHAUSTED" });
        }
        await this.#replace(claimed, {
          dispatchState: attempt.dispatchState,
          disposition: "RESOLVED",
        });
        const command = validateCommand({
          operation: claimed.operation,
          stage: claimed.stage,
          actionIntentDigest: claimed.actionIntentDigest,
        });
        const bindings = { runId: claimed.runId, orderId: claimed.orderId, batchRunId: "resume" };
        const stateful = STATEFUL_RECRUITMENT_OPERATIONS.includes(claimed.operation);
        if (stateful) await this.#consumeConfirmation(bindings, command);
        const next = this.#record({
          bindings,
          command,
          fromTier: this.intermediateTier,
          toTier: this.visualTier,
          reasonCode: attempt.reasonCode,
          attemptOrdinal: nextOrdinal,
          dispatchState: stateful ? "DISPATCHING" : "NOT_DISPATCHED",
        });
        await this.stores.escalations.create(next);
        return frozen({
          kind: "ASSISTANCE_REQUIRED",
          escalationId: next.escalationId,
          operation: next.operation,
          reasonCode: next.reasonCode,
          toTier: this.visualTier,
        });
      });
    }

    if (attempt.outcome !== "COMPLETED") {
      const reasonCode = humanGateReasons.has(attempt.reasonCode)
        ? attempt.reasonCode
        : "TIER_BUDGET_EXHAUSTED";
      await this.#replace(record, { disposition: "HUMAN_REQUIRED", reasonCode });
      return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode });
    }

    await this.#replace(record, {
      dispatchState: attempt.dispatchState,
      disposition: "REVALIDATE",
    });
    if (typeof this.scriptedAdapter.revalidate !== "function") {
      throw new Error("assisted attempt requires scripted revalidation");
    }
    const revalidated = validateAdapterOutcome(await this.scriptedAdapter.revalidate(frozen({
      operation: record.operation,
      stage: record.stage,
      actionIntentDigest: record.actionIntentDigest,
      runId: record.runId,
      orderId: record.orderId,
      rulesVersion: record.rulesVersion,
      rulesDigest: record.rulesDigest,
    })));
    if (revalidated.outcome !== "COMPLETED") {
      const reasonCode = revalidated.reasonCode === "ACTION_RESULT_UNKNOWN"
        ? "ACTION_RESULT_UNKNOWN"
        : "NON_OCCURRENCE_UNPROVEN";
      await this.#replace(record, { disposition: "HUMAN_REQUIRED", reasonCode });
      return frozen({ kind: "HUMAN_GATE_REQUIRED", reasonCode });
    }
    await this.#replace(record, { disposition: "RESOLVED" });
    return frozen({ kind: "COMPLETED" });
  }
}
