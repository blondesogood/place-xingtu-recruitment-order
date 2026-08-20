import { parseExecutorAction } from "./action-policy.mjs";
import { validateFinalObservationForRules } from "./run-result.mjs";
import { loadRules } from "./rules.mjs";

const postPublishStages = new Set([
  "TASK_VERIFIED",
  "WRITEBACK_READY",
  "WAIT_USER_CONFIRM",
]);
const earlyDraftStages = new Set([
  "ORDER_LOCKED",
  "DRAFT_READY",
]);
const writebackOperations = Object.freeze([
  "VERIFY_EXISTING_TASK",
  "PREPARE_WRITEBACK",
]);

function blocked(code) {
  return { status: "BLOCKED", code, allowedOperations: [] };
}

export function planRecovery(input) {
  if (input?.orderType !== undefined) return planTypedRecovery(input);
  if (input?.authenticated !== true) {
    return {
      status: "NEEDS_HUMAN",
      code: "LOGIN_EXPIRED",
      allowedOperations: [],
      takeoverSteps: ["RESTORE_DEDICATED_PROFILE_LOGIN"],
    };
  }
  if (!Array.isArray(input.requestFailures) || input.requestFailures.length > 0) {
    return blocked("REQUEST_FAILED");
  }
  if (
    !input.expectedSnapshot ||
    !input.actualSnapshot ||
    input.expectedSnapshot.rulesVersion !== input.actualSnapshot.rulesVersion
  ) {
    return blocked("RULES_VERSION_MISMATCH");
  }
  if (input.expectedSnapshot.fingerprint !== input.actualSnapshot.fingerprint) {
    return blocked("ORDER_FINGERPRINT_MISMATCH");
  }

  if (earlyDraftStages.has(input.stage)) {
    return {
      status: "RESUME",
      mode: "RESUME_DRAFT",
      nextStage: input.stage,
      allowedOperations: ["VERIFY_ORDER", "PREPARE_DRAFT"],
    };
  }
  if (!Array.isArray(input.taskLookup?.candidates)) {
    return blocked("TASK_LOOKUP_UNVERIFIED");
  }

  const verifiedCandidates = input.taskLookup.candidates.filter(
    (candidate) =>
      typeof candidate?.taskId === "string" &&
      candidate.taskId.length > 0 &&
      candidate.detailVerified === true,
  );

  if (input.stage === "WAIT_USER_PUBLISH") {
    if (
      input.taskLookup.candidates.length === 1 &&
      verifiedCandidates.length === 1
    ) {
      return {
        status: "RESUME",
        mode: "TASK_ALREADY_PUBLISHED",
        nextStage: "TASK_VERIFIED",
        verifiedTaskId: verifiedCandidates[0].taskId,
        allowedOperations: [...writebackOperations],
      };
    }
    return {
      status: "NEEDS_HUMAN",
      code: "PUBLISH_STATE_UNPROVEN",
      allowedOperations: ["VERIFY_TASK_LOOKUP"],
      takeoverSteps: ["DETERMINE_PUBLISH_STATE"],
    };
  }

  if (postPublishStages.has(input.stage)) {
    if (
      typeof input.verifiedTaskId !== "string" ||
      input.taskLookup.candidates.length !== 1 ||
      verifiedCandidates.length !== 1 ||
      verifiedCandidates[0].taskId !== input.verifiedTaskId
    ) {
      return blocked("VERIFIED_TASK_AMBIGUOUS");
    }
    return {
      status: "RESUME",
      mode: "WRITEBACK_ONLY",
      verifiedTaskId: input.verifiedTaskId,
      allowedOperations: [...writebackOperations],
    };
  }

  if (input.stage === "DONE") {
    return blocked("MALFORMED_EVIDENCE");
  }
  return blocked("UNKNOWN_RECOVERY_STAGE");
}

function typedBlocked(code) {
  return { status: "BLOCKED", code, allowedOperations: [] };
}

function typedNeedsHuman(code, takeoverStep) {
  return {
    status: "NEEDS_HUMAN",
    code,
    allowedOperations: ["VERIFY_TASK_LOOKUP"],
    takeoverSteps: [takeoverStep],
  };
}

function candidateMatches(candidate, input, intentEvidence) {
  return (
    typeof candidate?.taskId === "string" && candidate.taskId.length > 0 &&
    candidate.detailVerified === true &&
    candidate.runId === input.runId &&
    candidate.orderId === input.expectedSnapshot.orderId &&
    candidate.orderType === input.orderType &&
    candidate.orderFingerprint === input.expectedSnapshot.fingerprint &&
    candidate.rulesVersion === input.expectedSnapshot.rulesVersion &&
    (input.orderType !== "RECRUITMENT" || input.stage !== "PUBLISH_INTENT" || (
      candidate.activityId === intentEvidence?.activityId &&
      candidate.creatorId === intentEvidence?.creatorId
    ))
  );
}

function intentMatchesRun(intent, input) {
  const binding = intent?.intentionEvidence;
  return binding && (
    binding.runId === input.runId &&
    binding.orderId === input.expectedSnapshot.orderId &&
    binding.orderFingerprint === input.expectedSnapshot.fingerprint &&
    binding.rulesVersion === input.expectedSnapshot.rulesVersion &&
    intent.orderType === input.orderType
  );
}

function hasTrustedWritebackEvidence(input) {
  return /^[a-f0-9]{64}$/u.test(input.writebackEvidenceHash ?? "");
}

function hasFreshWritebackVerification(input) {
  const value = input.writebackVerification;
  const keys = [
    "fresh", "runId", "orderId", "orderType", "orderFingerprint",
    "rulesVersion", "verifiedTaskId", "writebackEvidenceHash",
  ];
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    value.fresh === true &&
    value.runId === input.runId &&
    value.orderId === input.expectedSnapshot.orderId &&
    value.orderType === input.orderType &&
    value.orderFingerprint === input.expectedSnapshot.fingerprint &&
    value.rulesVersion === input.expectedSnapshot.rulesVersion &&
    value.verifiedTaskId === input.verifiedTaskId &&
    value.writebackEvidenceHash === input.writebackEvidenceHash
  );
}

function matchingCandidates(input, intentEvidence) {
  if (!Array.isArray(input.taskLookup?.candidates)) return null;
  return input.taskLookup.candidates.filter((candidate) => (
    candidateMatches(candidate, input, intentEvidence)
  ));
}

function exactNonOccurrenceEvidence(value, input, intentEvidence, kind) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = kind === "publish"
    ? ["fresh", "publishOccurred", "runId", "orderId", "orderType", "activityId", "creatorId", "orderFingerprint", "rulesVersion"]
    : ["fresh", "confirmationOccurred", "runId", "orderId", "orderType", "verifiedTaskId", "writebackEvidenceHash", "orderFingerprint", "rulesVersion"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return false;
  const common = (
    value.fresh === true &&
    value.runId === input.runId &&
    value.orderId === input.expectedSnapshot.orderId &&
    value.orderType === input.orderType &&
    value.orderFingerprint === input.expectedSnapshot.fingerprint &&
    value.rulesVersion === input.expectedSnapshot.rulesVersion
  );
  if (!common) return false;
  if (kind === "publish") {
    return (
      value.publishOccurred === false &&
      value.activityId === intentEvidence.activityId &&
      value.creatorId === intentEvidence.creatorId
    );
  }
  return value.confirmationOccurred === false && value.verifiedTaskId === input.verifiedTaskId &&
    value.writebackEvidenceHash === input.writebackEvidenceHash &&
    value.writebackEvidenceHash === intentEvidence.writebackEvidenceHash;
}

function planTypedRecovery(input) {
  if (!new Set(["RECRUITMENT", "SUBMISSION"]).has(input.orderType)) {
    return typedBlocked("UNKNOWN_RECOVERY_STAGE");
  }
  if (input.authenticated !== true) {
    return {
      status: "NEEDS_HUMAN",
      code: "LOGIN_EXPIRED",
      allowedOperations: [],
      takeoverSteps: ["RESTORE_DEDICATED_PROFILE_LOGIN"],
    };
  }
  if (!Array.isArray(input.requestFailures) || input.requestFailures.length > 0) {
    return typedBlocked("REQUEST_FAILED");
  }
  if (
    !input.expectedSnapshot || !input.actualSnapshot ||
    input.expectedSnapshot.rulesVersion !== input.actualSnapshot.rulesVersion
  ) return typedBlocked("RULES_VERSION_MISMATCH");
  if (input.expectedSnapshot.fingerprint !== input.actualSnapshot.fingerprint) {
    return typedBlocked("ORDER_FINGERPRINT_MISMATCH");
  }
  if (
    typeof input.expectedSnapshot.orderId !== "string" ||
    input.expectedSnapshot.orderId.length === 0 ||
    input.expectedSnapshot.orderId !== input.actualSnapshot.orderId
  ) return typedBlocked("ORDER_FINGERPRINT_MISMATCH");
  if (
    input.expectedSnapshot.orderType !== input.orderType ||
    input.actualSnapshot.orderType !== input.orderType
  ) return typedBlocked("ORDER_TYPE_MISMATCH");

  const rules = loadRules(input.expectedSnapshot.rulesVersion);
  if (rules.schemaVersion !== 2) return typedBlocked("RULES_VERSION_MISMATCH");

  if (new Set(["ORDER_LOCKED", "DRAFT_READY"]).has(input.stage)) {
    return {
      status: "RESUME",
      mode: "RESUME_DRAFT",
      nextStage: input.stage,
      allowedOperations: ["VERIFY_ORDER", "PREPARE_DRAFT"],
    };
  }

  let intent = null;
  if (input.pendingAction !== null && input.pendingAction !== undefined) {
    try {
      intent = parseExecutorAction(input.pendingAction, rules);
    } catch {
      return typedBlocked("MALFORMED_EVIDENCE");
    }
  }
  const intentEvidence = intent?.intentionEvidence;
  const candidates = matchingCandidates(input, intentEvidence);

  if (
    new Set(["CONFIRM_INTENT", "FINAL_OBSERVED", "DONE"]).has(input.stage) &&
    !hasTrustedWritebackEvidence(input)
  ) return typedBlocked("MALFORMED_EVIDENCE");
  if (intent && !intentMatchesRun(intent, input)) return typedBlocked("MALFORMED_EVIDENCE");
  if (
    (input.publishNonOccurrenceEvidence !== undefined &&
      !exactNonOccurrenceEvidence(input.publishNonOccurrenceEvidence, input, intentEvidence, "publish")) ||
    (input.confirmationNonOccurrenceEvidence !== undefined &&
      !exactNonOccurrenceEvidence(input.confirmationNonOccurrenceEvidence, input, intentEvidence, "confirm"))
  ) return typedBlocked("MALFORMED_EVIDENCE");

  if (input.orderType === "RECRUITMENT" && input.stage === "PUBLISH_INTENT") {
    if (intent?.type !== "PUBLISH_RECRUITMENT_TASK") return typedBlocked("MALFORMED_EVIDENCE");
    if (candidates === null) return typedBlocked("TASK_LOOKUP_UNVERIFIED");
    if (input.taskLookup.candidates.length === 1 && candidates.length === 1) {
      return {
        status: "RESUME",
        mode: "TASK_ALREADY_PUBLISHED",
        nextStage: "TASK_VERIFIED",
        verifiedTaskId: candidates[0].taskId,
        allowedOperations: [...writebackOperations],
      };
    }
    if (
      input.taskLookup.candidates.length === 0 &&
      exactNonOccurrenceEvidence(
        input.publishNonOccurrenceEvidence,
        input,
        intentEvidence,
        "publish",
      )
    ) {
      return {
        status: "RESUME",
        mode: "RETRY_PUBLISH",
        nextStage: "PUBLISH_INTENT",
        allowedOperations: ["PUBLISH_RECRUITMENT_TASK"],
      };
    }
    return typedNeedsHuman(
      input.taskLookup.candidates.length > 1 ? "PUBLISH_TASK_AMBIGUOUS" : "PUBLISH_RESULT_UNKNOWN",
      "DETERMINE_PUBLISH_STATE",
    );
  }

  if (input.orderType === "SUBMISSION" && input.stage === "WAIT_USER_PUBLISH") {
    if (candidates === null) return typedBlocked("TASK_LOOKUP_UNVERIFIED");
    if (input.taskLookup.candidates.length === 1 && candidates.length === 1) {
      return {
        status: "RESUME",
        mode: "TASK_ALREADY_PUBLISHED",
        nextStage: "TASK_VERIFIED",
        verifiedTaskId: candidates[0].taskId,
        allowedOperations: [...writebackOperations],
      };
    }
    return typedNeedsHuman("PUBLISH_STATE_UNPROVEN", "DETERMINE_PUBLISH_STATE");
  }

  if (new Set(["TASK_VERIFIED", "WRITEBACK_READY"]).has(input.stage)) {
    if (
      candidates === null || input.taskLookup.candidates.length !== 1 ||
      candidates.length !== 1 || candidates[0].taskId !== input.verifiedTaskId
    ) return typedBlocked("VERIFIED_TASK_AMBIGUOUS");
    return {
      status: "RESUME",
      mode: "WRITEBACK_ONLY",
      verifiedTaskId: input.verifiedTaskId,
      allowedOperations: [...writebackOperations],
    };
  }

  if (input.stage === "CONFIRM_INTENT") {
    if (
      intent?.type !== "CONFIRM_INTERNAL_ORDER" ||
      candidates === null || input.taskLookup.candidates.length !== 1 ||
      candidates.length !== 1 || candidates[0].taskId !== input.verifiedTaskId
    ) return typedBlocked("VERIFIED_TASK_AMBIGUOUS");
    if (input.finalObservation !== null && input.finalObservation !== undefined) {
      try {
        const final = validateFinalObservationForRules(input.finalObservation, rules);
        if (
          final.schemaVersion !== 2 || final.runId !== input.runId || final.orderId !== input.expectedSnapshot.orderId || final.orderType !== input.orderType ||
          final.orderFingerprint !== input.expectedSnapshot.fingerprint ||
          final.rulesVersion !== input.expectedSnapshot.rulesVersion ||
          final.verifiedTaskId !== input.verifiedTaskId ||
          final.writebackEvidenceHash !== input.writebackEvidenceHash ||
          final.writebackEvidenceHash !== intentEvidence.writebackEvidenceHash
        ) return typedBlocked("MALFORMED_EVIDENCE");
      } catch {
        return typedBlocked("MALFORMED_EVIDENCE");
      }
      return {
        status: "RESUME",
        mode: "FINAL_STATE_ALREADY_OBSERVED",
        nextStage: "FINAL_OBSERVED",
        verifiedTaskId: input.verifiedTaskId,
        allowedOperations: [],
      };
    }
    if (exactNonOccurrenceEvidence(
      input.confirmationNonOccurrenceEvidence,
      input,
      intentEvidence,
      "confirm",
    )) {
      return {
        status: "RESUME",
        mode: "RETRY_CONFIRM",
        nextStage: "CONFIRM_INTENT",
        verifiedTaskId: input.verifiedTaskId,
        allowedOperations: ["CONFIRM_INTERNAL_ORDER"],
      };
    }
    return typedNeedsHuman("CONFIRM_RESULT_UNKNOWN", "REVIEW_BLOCKED_RUN");
  }

  if (new Set(["FINAL_OBSERVED", "DONE"]).has(input.stage)) {
    if (candidates === null) return typedBlocked("TASK_LOOKUP_UNVERIFIED");
    if (
      input.taskLookup.candidates.length !== 1 ||
      candidates.length !== 1 ||
      candidates[0].taskId !== input.verifiedTaskId
    ) return typedBlocked("VERIFIED_TASK_AMBIGUOUS");
    if (!hasFreshWritebackVerification(input)) return typedBlocked("MALFORMED_EVIDENCE");
    let final;
    try {
      final = validateFinalObservationForRules(input.finalObservation, rules);
      if (
        final.schemaVersion !== 2 || final.runId !== input.runId || final.orderId !== input.expectedSnapshot.orderId ||
        final.orderType !== input.orderType || final.orderFingerprint !== input.expectedSnapshot.fingerprint ||
        final.rulesVersion !== input.expectedSnapshot.rulesVersion || final.verifiedTaskId !== input.verifiedTaskId ||
        final.writebackEvidenceHash !== input.writebackEvidenceHash
      ) return typedBlocked("MALFORMED_EVIDENCE");
    } catch {
      return typedBlocked("MALFORMED_EVIDENCE");
    }
    if (input.orderType === "RECRUITMENT" && rules.recruitment.completionStatus === "UNCONFIRMED") {
      return typedNeedsHuman(
        "RECRUITMENT_STATUS_UNCONFIRMED",
        "CONFIRM_RECRUITMENT_FINAL_STATUS",
      );
    }
    if (input.orderType === "RECRUITMENT") {
      return {
        status: "COMPLETE",
        ...(input.stage === "FINAL_OBSERVED" ? { nextStage: "DONE" } : {}),
        allowedOperations: [],
      };
    }
    try {
      if (final.observationCode !== "SUBMISSION_BUSINESS_ORDERED" && final.statusCode !== rules.submission.completionStatus) {
        return typedNeedsHuman("SUBMISSION_FINAL_STATUS_MISMATCH", "VERIFY_SUBMISSION_FINAL_STATUS");
      }
    } catch {
      return typedBlocked("MALFORMED_EVIDENCE");
    }
    return {
      status: "COMPLETE",
      ...(input.stage === "FINAL_OBSERVED" ? { nextStage: "DONE" } : {}),
      allowedOperations: [],
    };
  }
  return typedBlocked("UNKNOWN_RECOVERY_STAGE");
}
