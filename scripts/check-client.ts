/**
 * Fails when the client build holds a server module. It reads the bundler's own module list
 * (the metafile), so a server module counts however it got in: an import, a re-export, a barrel.
 */
const [metafile = "dist/client-meta.json"] = Bun.argv.slice(2);

const meta = (await Bun.file(metafile).json()) as {
  inputs: Record<string, { imports?: { path: string; external?: boolean }[] }>;
};

const server = [
  /\.server\.tsx?$/,
  /^cmds\/(server|host|dev|telemetry-worker)\.ts$/,
  /^src\/backend\//,
  /^tinker\/base\/(bun-host|panics\.server|telemetry-worker)\.ts$/,
];

const inputs = Object.keys(meta.inputs);
const leaks = inputs.filter((path) => server.some((rule) => rule.test(path)));

const builtins = Object.entries(meta.inputs).flatMap(([path, input]) =>
  (input.imports ?? [])
    .filter((target) => /^(node:|bun:?)/.test(target.path))
    .map((target) => `${path} -> ${target.path}`),
);

for (const line of [...leaks, ...builtins]) console.error(`server code in client: ${line}`);
if (leaks.length || builtins.length) process.exit(1);
console.log(`client build clean: ${inputs.length} modules, none from the server side`);

export {};
