/**
 * Fails when a prod build holds test code: `@tinker/core/testing` (test capsules, test clock,
 * presets) or a `*.testing.ts` file (a capsule's test capsule, ADR 0127 in tinkered). A prod
 * file never imports them, so the bundler leaves them out; this check catches the mistake.
 */
const metafiles = Bun.argv.slice(2);

const test = [/@tinker\/core\/dist\/testing\./, /\.testing\.tsx?$/];
let leaks = 0;

for (const metafile of metafiles) {
  const meta = (await Bun.file(metafile).json()) as { inputs: Record<string, unknown> };
  for (const path of Object.keys(meta.inputs)) {
    if (!test.some((rule) => rule.test(path))) continue;
    console.error(`test code in ${metafile}: ${path}`);
    leaks++;
  }
}

if (leaks) process.exit(1);
console.log(`prod builds clean: no test code in ${metafiles.join(", ")}`);

export {};
