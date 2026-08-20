const LEGACY_EXECUTION_STAGES = Object.freeze([
  "ORDER_LOCKED",
  "DRAFT_READY",
  "WAIT_USER_PUBLISH",
  "TASK_VERIFIED",
  "WRITEBACK_READY",
  "WAIT_USER_CONFIRM",
  "DONE",
]);

export const STAGES_BY_ORDER_TYPE = Object.freeze({
  RECRUITMENT: Object.freeze([
    "ORDER_LOCKED",
    "DRAFT_READY",
    "PUBLISH_INTENT",
    "BUDGET_TOPUP_INTENT",
    "BUDGET_TOPUP_OBSERVED",
    "PUBLISH_RETRY_READY",
    "TASK_VERIFIED",
    "WRITEBACK_READY",
    "CONFIRM_INTENT",
    "FINAL_OBSERVED",
    "DONE",
  ]),
  SUBMISSION: Object.freeze([
    "ORDER_LOCKED",
    "DRAFT_READY",
    "WAIT_USER_PUBLISH",
    "TASK_VERIFIED",
    "WRITEBACK_READY",
    "CONFIRM_INTENT",
    "FINAL_OBSERVED",
    "DONE",
  ]),
});

export const EXECUTION_STAGES = Object.freeze([
  ...new Set([...LEGACY_EXECUTION_STAGES, ...Object.values(STAGES_BY_ORDER_TYPE).flat()]),
]);

const nextStage = new Map(
  LEGACY_EXECUTION_STAGES.slice(0, -1).map((stage, index) => [
    stage,
    LEGACY_EXECUTION_STAGES[index + 1],
  ]),
);

const transitionsByOrderType = Object.freeze({
  RECRUITMENT: Object.freeze({
    ORDER_LOCKED: ["DRAFT_READY"],
    DRAFT_READY: ["PUBLISH_INTENT"],
    PUBLISH_INTENT: ["TASK_VERIFIED", "BUDGET_TOPUP_INTENT"],
    BUDGET_TOPUP_INTENT: ["BUDGET_TOPUP_OBSERVED"],
    BUDGET_TOPUP_OBSERVED: ["PUBLISH_RETRY_READY", "TASK_VERIFIED"],
    PUBLISH_RETRY_READY: ["TASK_VERIFIED"],
    TASK_VERIFIED: ["WRITEBACK_READY"],
    WRITEBACK_READY: ["CONFIRM_INTENT"],
    CONFIRM_INTENT: ["FINAL_OBSERVED"],
    FINAL_OBSERVED: ["DONE"],
  }),
  SUBMISSION: Object.freeze(Object.fromEntries(
    STAGES_BY_ORDER_TYPE.SUBMISSION.slice(0, -1).map((stage, index) => [
      stage,
      [STAGES_BY_ORDER_TYPE.SUBMISSION[index + 1]],
    ]),
  )),
});

export function advanceStage(orderTypeOrCurrent, currentOrProposed, proposedOrEvidence, maybeEvidence) {
  if (maybeEvidence === undefined) {
    const current = orderTypeOrCurrent;
    const proposed = currentOrProposed;
    const evidence = proposedOrEvidence;
    if (!LEGACY_EXECUTION_STAGES.includes(current) || !LEGACY_EXECUTION_STAGES.includes(proposed)) {
      throw new Error("state transition uses an unknown stage");
    }
    if (nextStage.get(current) !== proposed) {
      throw new Error(`illegal state transition from ${current} to ${proposed}`);
    }
    if (evidence?.rereadVerified !== true) {
      throw new Error("stage transition requires verified page re-read evidence");
    }
    return proposed;
  }
  const orderType = orderTypeOrCurrent;
  const current = currentOrProposed;
  const proposed = proposedOrEvidence;
  const evidence = maybeEvidence;
  const stages = STAGES_BY_ORDER_TYPE[orderType];
  if (!stages || !stages.includes(current) || !stages.includes(proposed)) {
    throw new Error("state transition uses an unknown order type or stage");
  }
  if (!transitionsByOrderType[orderType]?.[current]?.includes(proposed)) {
    throw new Error(`illegal state transition from ${current} to ${proposed}`);
  }
  if (evidence?.rereadVerified !== true) {
    throw new Error("stage transition requires verified page re-read evidence");
  }
  if (proposed === "PUBLISH_INTENT" && evidence.freshDuplicateLookupVerified !== true) {
    throw new Error("PUBLISH_INTENT requires fresh duplicate lookup evidence");
  }
  if (
    proposed === "BUDGET_TOPUP_INTENT" &&
    (evidence.explicitBudgetInsufficientVerified !== true || evidence.budgetLimitVerified !== true)
  ) {
    throw new Error("BUDGET_TOPUP_INTENT requires explicit insufficiency and budget-limit evidence");
  }
  if (proposed === "BUDGET_TOPUP_OBSERVED" && evidence.budgetTopUpVerified !== true) {
    throw new Error("BUDGET_TOPUP_OBSERVED requires an exact budget increment reread");
  }
  if (
    proposed === "PUBLISH_RETRY_READY" &&
    (evidence.freshDuplicateLookupVerified !== true || evidence.budgetTopUpVerified !== true)
  ) {
    throw new Error("PUBLISH_RETRY_READY requires a verified top-up and fresh non-occurrence evidence");
  }
  if (proposed === "CONFIRM_INTENT" && evidence.freshWritebackVerified !== true) {
    throw new Error("CONFIRM_INTENT requires fresh writeback evidence");
  }
  return proposed;
}
