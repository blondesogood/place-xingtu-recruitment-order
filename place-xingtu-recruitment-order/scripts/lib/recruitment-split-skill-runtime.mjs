import { createRecruitmentEgoSkillRuntime } from "./recruitment-ego-skill-runtime.mjs";
import { parseRecruitmentBatchManifestSplit } from "./split-manifest.mjs";
import { validateSplitRuntimeBinding } from "./split-runtime-binding.mjs";

export async function createRecruitmentSkillRuntime(input) {
  const binding = validateSplitRuntimeBinding("RECRUITMENT", input);
  const trustedInput = {
    ...input,
    rules: binding.rules,
    uiContract: binding.uiContract,
    candidateVersion: binding.candidateVersion,
    runtimeFingerprint: binding.runtimeFingerprint,
  };
  const runtime = await createRecruitmentEgoSkillRuntime(trustedInput);
  return Object.freeze({
    async prepare(textOrManifest, options = undefined) {
      if (textOrManifest !== null && typeof textOrManifest === "object" && !Array.isArray(textOrManifest)) {
        const manifest = parseRecruitmentBatchManifestSplit(textOrManifest, binding.rules);
        return Object.freeze({ kind: "READY", manifest });
      }
      return runtime.prepare(textOrManifest, options);
    },
    run: (manifest) => runtime.run(parseRecruitmentBatchManifestSplit(manifest, binding.rules)),
    resume: (resumeInput) => runtime.resume({
      ...structuredClone(resumeInput),
      manifest: parseRecruitmentBatchManifestSplit(resumeInput.manifest, binding.rules),
    }),
    finalize: (options) => runtime.finalize(options),
  });
}
