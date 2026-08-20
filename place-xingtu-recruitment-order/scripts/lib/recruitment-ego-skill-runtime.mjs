import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { EgoRecruitmentAdapter, EgoRecruitmentBoundary } from "./ego-recruitment-adapter.mjs";
import {
  RecruitmentLiveFlow,
  createLocalRecruitmentStores,
  createScriptedRecruitmentFlowAdapter,
} from "./recruitment-live-flow.mjs";
import {
  buildRecruitmentBatchManifest,
  parseRecruitmentNaturalLanguageIntent,
  resolveRecruitmentCreator,
} from "./recruitment-intent.mjs";
import { normalizeShanghaiCreatedAtRange, parseRecruitmentBatchManifest } from "./manifest.mjs";
import { RecruitmentRuntimeVersionError } from "./recruitment-runtime-binding-store.mjs";

const defaultOrigins = Object.freeze({
  placement: "https://placement.aihuishou.com",
  xingtu: "https://www.xingtu.cn",
});

function validateFactoryInput(input) {
  const lifecycle = ["useOrCreateTaskSpace", "takeOverTaskSpace", "handOffTaskSpace", "completeTaskSpace"];
  const browser = [
    "openOrReuseTab", "js", "click", "fillInput", "pressKey", "typeText", "wait",
    "captureScreenshot", "pageInfo",
  ];
  if (
    input === null || typeof input !== "object" || Array.isArray(input) ||
    typeof input.applicationDataDirectory !== "string" || !isAbsolute(input.applicationDataDirectory) ||
    typeof input.consumeConfirmation !== "function" ||
    lifecycle.some((name) => typeof input.ego?.[name] !== "function") ||
    browser.some((name) => typeof input.ego?.[name] !== "function") ||
    (typeof input.ego?.snapshot !== "function" && typeof input.ego?.snapshotText !== "function") ||
    !/^\d+\.\d+\.\d+-rc\.\d+$/u.test(input.candidateVersion ?? "") ||
    !/^[a-f0-9]{64}$/u.test(input.runtimeFingerprint ?? "") ||
    (input.clock !== undefined && typeof input.clock !== "function") ||
    (input.platform ?? process.platform) !== "darwin"
  ) throw new Error("Ego recruitment Skill runtime dependencies are invalid");
}

function taskSpaceName(batchRunId) {
  return `xingtu-recruitment-${batchRunId}`.slice(0, 120);
}

function taskSpaceId(task) {
  const value = task?.id ?? task?.taskId;
  if (!(typeof value === "number" || (typeof value === "string" && value.length > 0))) {
    throw new Error("Ego recruitment task space identity is unavailable");
  }
  return value;
}

function validateResumeInput(input) {
  if (
    input === null || typeof input !== "object" || Array.isArray(input) ||
    input.manifest === null || typeof input.manifest !== "object" || Array.isArray(input.manifest) ||
    !(typeof input.taskSpaceId === "number" || (typeof input.taskSpaceId === "string" && input.taskSpaceId.length > 0))
  ) throw new Error("Ego recruitment resume input is invalid");
  return structuredClone(input);
}

export async function createRecruitmentEgoSkillRuntime(input) {
  validateFactoryInput(input);
  const {
    ego, applicationDataDirectory, rules, uiContract, consumeConfirmation, recovery,
    candidateVersion, runtimeFingerprint,
  } = input;
  const origins = input.origins ?? defaultOrigins;
  const clock = input.clock ?? (() => new Date().toISOString());
  const stores = createLocalRecruitmentStores({
    applicationDataDirectory, rules, consumeConfirmation, recovery,
  });
  let executionContext = Object.freeze({});
  let activeTaskSpaceId = null;
  let lastResult = null;
  const adapter = new EgoRecruitmentAdapter({
    ego, rules, uiContract, origins,
    operationStore: stores.activeOperations,
    contextProvider: () => executionContext,
    clock,
  });
  const flow = new RecruitmentLiveFlow({
    rules,
    uiContract,
    stores,
    adapter: createScriptedRecruitmentFlowAdapter(adapter),
    clock,
  });

  async function resolveDateFallbackManifest(manifest) {
    if (manifest.schemaVersion !== 4 || !Object.hasOwn(manifest, "createdAtRange")) return manifest;
    const targetScope = manifest.targetScope;
    let creatorId = targetScope.creatorId;
    let discovery = await stores.dateDiscovery.initialize(manifest);
    const existingSweep = await stores.sweeps.read(manifest.batchRunId);
    if (existingSweep) creatorId = existingSweep.targetScope.creatorId;
    if (!existingSweep && targetScope.creatorName !== null) {
      const range = normalizeShanghaiCreatedAtRange(manifest.createdAtRange);
      const filters = {
        ...structuredClone(uiContract.pages.internalOrders.effectiveFilters),
        createdAt: {
          label: uiContract.pages.internalOrders.effectiveFilters.createdAt,
          start: range.start,
          endExclusive: range.endExclusive,
        },
      };
      const readCandidates = async (includeHistorical) => {
        const evidence = await adapter.readEvidence("DISCOVER_CREATOR_CANDIDATES", {
          creatorName: targetScope.creatorName,
          filters,
          includeHistorical,
          discoveryMode: discovery.currentMode,
        });
        if (Array.isArray(evidence)) return { candidates: evidence, coverageComplete: true };
        if (
          evidence === null || typeof evidence !== "object" || Array.isArray(evidence) ||
          Object.keys(evidence).sort().join(",") !== "candidates,coverageComplete" ||
          !Array.isArray(evidence.candidates) || typeof evidence.coverageComplete !== "boolean"
        ) throw new Error("Ego creator discovery evidence is invalid");
        return evidence;
      };
      let evidence = await readCandidates(false);
      if (discovery.currentMode === "TABLE_FIRST" && !evidence.coverageComplete) {
        discovery = await stores.dateDiscovery.fallback(manifest.batchRunId, "CREATOR_ID_UNPROVEN");
        evidence = await readCandidates(false);
      }
      let candidates = evidence.candidates;
      let resolution = resolveRecruitmentCreator({ kind: "READY", creatorName: targetScope.creatorName }, candidates);
      if (resolution.reasonCode === "CREATOR_NOT_FOUND") {
        candidates = (await readCandidates(true)).candidates;
        resolution = resolveRecruitmentCreator({ kind: "READY", creatorName: targetScope.creatorName }, candidates);
      }
      if (resolution.kind !== "RESOLVED") return resolution;
      creatorId = resolution.creatorId;
    }
    return Object.freeze({
      schemaVersion: 3,
      batchRunId: manifest.batchRunId,
      rulesVersion: manifest.rulesVersion,
      orderType: "RECRUITMENT",
      createdAtRange: structuredClone(manifest.createdAtRange),
      timeZone: manifest.timeZone,
      targetScope: { creatorId, maxOrders: targetScope.maxOrders },
    });
  }

  async function attachTimings(result, batchRunId) {
    const records = await stores.activeOperations.listForBatch(batchRunId);
    const operations = records.map((record) => ({
      stage: record.stage,
      operation: record.operation,
      tier: record.tier,
      durationMs: record.finishedAt === null ? null : Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)),
      status: record.status,
      reasonCode: record.reasonCode,
    }));
    const observedAt = Date.parse(clock());
    const userWaitMs = records.reduce((sum, record, index) => {
      if (record.status !== "HUMAN_GATE_REQUIRED" || record.finishedAt === null) return sum;
      const nextStart = records[index + 1]?.startedAt;
      const until = nextStart === undefined ? observedAt : Date.parse(nextStart);
      return sum + Math.max(0, until - Date.parse(record.finishedAt));
    }, 0);
    return Object.freeze({
      ...structuredClone(result),
      taskSpaceId: activeTaskSpaceId,
      timings: Object.freeze({
        totalMs: operations.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
        completedMs: operations.filter((entry) => entry.status === "COMPLETED")
          .reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
        blockedMs: operations.filter((entry) => new Set(["BLOCKED", "HUMAN_GATE_REQUIRED"]).has(entry.status))
          .reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
        platformWaitMs: operations.filter((entry) => new Set([
          "READ_RECRUITMENT_SUBMIT_RESULT", "REREAD_RECRUITMENT_TASK",
        ]).has(entry.operation)).reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
        userWaitMs,
        repairMs: 0,
        operations: Object.freeze(operations),
      }),
    });
  }

  async function execute(manifest) {
    manifest = parseRecruitmentBatchManifest(manifest, rules);
    executionContext = Object.freeze({ batchRunId: manifest.batchRunId });
    try {
      const priorOperations = await stores.activeOperations.listForBatch(manifest.batchRunId);
      const hasStatefulDispatch = priorOperations.some((record) => (
        new Set(["SUBMIT_RECRUITMENT_ORDER", "TOP_UP_RECRUITMENT_BUDGET", "CONFIRM_INTERNAL_ORDER"]).has(record.operation) &&
        record.dispatchState !== "NOT_DISPATCHED"
      ));
      await stores.runtimeBindings.ensure({
        batchRunId: manifest.batchRunId,
        candidateVersion,
        runtimeFingerprint,
        hasStatefulDispatch,
      });
      const resolved = await resolveDateFallbackManifest(manifest);
      lastResult = resolved.kind === "NEEDS_HUMAN"
        ? Object.freeze({ kind: "HUMAN_GATE_REQUIRED", reasonCode: resolved.reasonCode })
        : await flow.run(resolved);
    } catch (error) {
      if (error instanceof RecruitmentRuntimeVersionError) {
        lastResult = Object.freeze({ kind: "BLOCKED", reasonCode: error.reasonCode });
      } else {
      if (!(error instanceof EgoRecruitmentBoundary)) throw error;
      lastResult = error.result;
      if (lastResult.kind === "HUMAN_GATE_REQUIRED") {
        const handoff = await ego.handOffTaskSpace(activeTaskSpaceId);
        lastResult = Object.freeze({ ...lastResult, handoff });
      }
      }
    }
    lastResult = await attachTimings(lastResult, manifest.batchRunId);
    return lastResult;
  }

  return Object.freeze({
    async prepare(text, { batchRunId = `batch-${randomUUID()}`, now = clock() } = {}) {
      const intent = parseRecruitmentNaturalLanguageIntent(text, { now });
      if (intent.kind !== "READY") return intent;
      return Object.freeze({
        kind: "READY",
        manifest: buildRecruitmentBatchManifest({ intent, batchRunId, rulesVersion: rules.rulesVersion }),
      });
    },

    async run(manifest) {
      manifest = parseRecruitmentBatchManifest(manifest, rules);
      const task = await ego.useOrCreateTaskSpace(taskSpaceName(manifest.batchRunId));
      activeTaskSpaceId = taskSpaceId(task);
      return execute(manifest);
    },

    async resume(rawInput) {
      const { manifest, taskSpaceId: suppliedTaskSpaceId } = validateResumeInput(rawInput);
      await ego.takeOverTaskSpace(suppliedTaskSpaceId);
      activeTaskSpaceId = suppliedTaskSpaceId;
      return execute(manifest);
    },

    async finalize({ keep = false } = {}) {
      if (activeTaskSpaceId === null) return Object.freeze({ done: false, skipped: "no-task-space" });
      if (typeof keep !== "boolean") throw new Error("Ego recruitment finalize keep must be boolean");
      return ego.completeTaskSpace(activeTaskSpaceId, { keep });
    },
  });
}
