import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";

const app = createRequire(resolve("package.json"));
const stryker = createRequire(app.resolve("@stryker-mutator/core"));

const { declareFactoryPlugin, PluginKind, commonTokens, tokens } = stryker(
  "@stryker-mutator/api/plugin",
);

/** Change only public mutable plan entries; leave the readonly event array intact. */
export function capPlans(plans, mutate, root = process.cwd()) {
  const ranges = mutate.map((pattern) => {
    const [, file, start, end] = /^(.*):(\d+)-(\d+)$/.exec(pattern) ?? [];

    if (!file) throw new Error(`Diff line cap needs explicit line ranges: ${pattern}`);

    return { file, start: Number(start), end: Number(end) };
  });

  const groups = new Map();

  for (const plan of plans.filter((plan) => plan.mutant.status !== "Ignored")) {
    const mutant = plan.mutant;
    const file = relative(root, mutant.fileName).replaceAll("\\", "/");
    // Native plan positions are zero-based; Git ranges are one-based.
    const start = mutant.location.start.line + 1;
    const end = mutant.location.end.line + Number(mutant.location.end.column > 0);
    const range = ranges.find(
      (range) => range.file === file && range.start <= end && range.end >= start,
    );

    if (!range) {
      throw new Error(`Mutant outside diff ranges: ${file}:${start}`);
    }

    // Multiline nodes belong to their first changed line, never an unchanged line.
    const line = Math.max(range.start, start);
    const key = `${file}:${line}`;
    const candidate = JSON.stringify([
      mutant.location.start.line,
      mutant.location.start.column,
      mutant.location.end.line,
      mutant.location.end.column,
      mutant.mutatorName,
      mutant.replacement,
    ]);
    const rank = createHash("sha256").update(`${key}\n${candidate}`).digest("hex") + candidate;

    if (!groups.has(key)) groups.set(key, []);

    groups.get(key).push({ plan, rank });
  }

  const selected = [];

  for (const [line, candidates] of groups) {
    candidates.sort((a, b) => (a.rank < b.rank ? -1 : Number(a.rank > b.rank)));
    selected.push({ line, id: candidates[0].plan.mutant.id });

    for (const { plan } of candidates.slice(1)) {
      plan.plan = "EarlyResult";
      plan.mutant.status = "Ignored";
      plan.mutant.statusReason = "diff: one deterministic mutant per changed line";
    }
  }

  return selected;
}

function createLineCap(options) {
  return {
    onMutationTestingPlanReady({ mutantPlans }) {
      try {
        const selected = capPlans(mutantPlans, options.mutate);

        writeFileSync(
          "reports/mutation/diff-line-cap.json",
          JSON.stringify(selected, null, 2) + "\n",
        );
        console.log(`Diff line cap: ${selected.length} selected lines`);
      } catch (error) {
        // Stryker logs reporter errors and continues. Prevent an uncapped run;
        // the calling script rejects the error artifact or missing selection.
        for (const plan of mutantPlans) {
          plan.plan = "EarlyResult";
          plan.mutant.status = "Ignored";
          plan.mutant.statusReason = "diff: line cap failed";
        }

        writeFileSync(
          "reports/mutation/diff-line-cap-error.json",
          JSON.stringify(String(error)) + "\n",
        );
        throw error;
      }
    },
  };
}

createLineCap.inject = tokens(commonTokens.options);

export const strykerPlugins = [
  declareFactoryPlugin(PluginKind.Reporter, "diff-line-cap", createLineCap),
];
