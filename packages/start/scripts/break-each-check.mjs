import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/**
 * Break each check, glue function, and doctor message in a scratch copy of the base, one at a
 * time, and run the unit tests: every break must make a test fail. A hand-written mutation run.
 * Usage: node packages/start/scripts/break-each-check.mjs
 * `BREAKS="a,b"` runs the control and only the breaks whose names hold `a` or `b`;
 * a part that names no break stops the run. Unset, it runs every break.
 */
const base = resolve(import.meta.dirname, "..");
const scratch = "/tmp/tinker-break/start";
const passOk = 'return { status: "ok", lines: ["broken"] };';

/** Logic breaks: file, the text to find, what replaces it. */
const breaks = [
  {
    name: "TypeScript import endings are missed",
    file: "lib/checks/imports.mjs",
    find: "...extensionImports(root)",
    replace: "...[]",
  },
  {
    name: "example missing parts are missed",
    file: "lib/checks/examples.mjs",
    find: "!on.includes(part)",
    replace: "false",
  },
  {
    name: "example missing seam exports are missed",
    file: "lib/checks/examples.mjs",
    find: "!existsSync(path) || !mayExport(path, name)",
    replace: "false",
  },
  {
    name: "example startup extension is missed",
    file: "lib/checks/examples.mjs",
    find: "needed.include && !hasSetup(path, needed)",
    replace: "false",
  },
  {
    name: "example requirements are not checked by doctor",
    file: "lib/checks/named.mjs",
    find: '...(installed.status === "fail" ? installed.lines : [])',
    replace: "...[]",
  },
  {
    name: "seam module declarations are missed",
    file: "lib/source.mjs",
    find: "node.id.value",
    replace: "undefined",
  },
  {
    name: "seam import equals is missed",
    file: "lib/source.mjs",
    find: "node.expression.value",
    replace: "undefined",
  },
  {
    name: "seam absolute base paths are missed",
    file: "lib/checks/imports.mjs",
    find: " || isAbsolute(name)",
    replace: "",
  },
  ...[
    "version",
    "bytes",
    "generated",
    "glue",
    "named",
    "imports",
    "routes",
    "style",
    "env",
    "boundary",
  ].map((name) => ({
    name: `check ${name} always passes`,
    file: `lib/checks/${name}.mjs`,
    find: `export function ${name}(root) {`,
    replace: `export function ${name}(root) {\n  ${passOk}`,
  })),
  {
    name: "bytes --fix restores nothing",
    file: "lib/checks/bytes.mjs",
    find: "else writeFileSync(",
    replace: "else if (false) writeFileSync(",
  },
  {
    name: "generated --fix adds no ignore line",
    file: "lib/checks/generated.mjs",
    find: "if (entries.length === 0) return;",
    replace: "return;",
  },
  {
    name: "glue --fix writes no extends",
    file: "lib/checks/glue.mjs",
    find: 'prependExtends(join(root, "tsconfig.json"), read.tsconfig, tinkerConfig);',
    replace: "",
  },
  {
    name: "build start stops nothing",
    file: "lib/doctor.mjs",
    find: "errors: lines.filter(({ stops }) => stops).map(({ text }) => text),",
    replace: "errors: [],",
  },
  {
    name: "build start warns about nothing",
    file: "lib/doctor.mjs",
    find: "warnings: lines.filter(({ stops }) => !stops).map(({ text }) => text),",
    replace: "warnings: [],",
  },
  {
    name: "a fix that fails reads as fixed",
    file: "lib/doctor.mjs",
    find: 'again.status === "ok" ?',
    replace: "true ?",
  },
  { name: "aliases drop ?url", file: "lib/glue.mjs", find: "(\\\\?.*)?$`", replace: "$`" },
  {
    name: "the shell never replaces the base's",
    file: "lib/glue.mjs",
    find: "existsSync(join(root, shellFile))",
    replace: "false",
  },
  {
    name: "an unknown tinker() option is dropped",
    file: "lib/glue.mjs",
    find: "if (unknown.length > 0)",
    replace: "if (false)",
  },
  {
    name: "a named file is never picked",
    file: "lib/named.mjs",
    find: "return existsSync(own) ? own :",
    replace: "return false ? own :",
  },
  {
    name: "src/router.tsx is not listed",
    file: "lib/named.mjs",
    find: '[".ts", ".tsx", ".js", ".jsx"]',
    replace: '[".ts", ".js", ".jsx"]',
  },
  {
    name: "tsconfig @/* goes back to ../src/*",
    file: "lib/prepare.mjs",
    find: '"@/*": [`${join(root, "src")}/*`]',
    replace: '"@/*": ["../src/*"]',
  },
  {
    name: "route groups count as a segment",
    file: "lib/route-path.mjs",
    find: "!/^\\(.+\\)$/.test(part) && ",
    replace: "",
  },
  {
    name: "nesting under a base route is missed",
    file: "lib/route-path.mjs",
    find: ".startsWith(`${path}/`)",
    replace: ".endsWith(`${path}/`)",
  },
  {
    name: "a - folder counts as a route",
    file: "lib/route-path.mjs",
    find: '!parts.some((part) => part.startsWith("-")) && ',
    replace: "",
  },
  {
    name: "tsc errors read as none",
    file: "lib/typecheck.mjs",
    find: ".filter(Boolean)",
    replace: ".filter(() => false)",
  },
  {
    name: "a second tinker() only warns",
    file: "lib/doctor.mjs",
    find: "stops: stopping.has(label) || breaksBuild(line),",
    replace: "stops: stopping.has(label),",
  },
  {
    name: "check 3 sends a clash to tinker prepare",
    file: "lib/checks/generated.mjs",
    find: "(file) => !routeClash(file, owned)",
    replace: "() => true",
  },
  {
    name: "tinker prepare hides a stale tree",
    file: "lib/checks/generated.mjs",
    find: "if (lines.length === 0) return [];",
    replace: "return [];",
  },
  {
    name: "shadcn needs Tailwind before any UI file",
    file: "lib/checks/style.mjs",
    find: "if (!ui || listFiles(ui).length === 0) return [];",
    replace: "if (!ui) return [];",
  },
  {
    name: "vite.config.ts is not type-checked",
    file: "lib/prepare.mjs",
    find: '"../vite.config.ts",',
    replace: "",
  },
  {
    name: "a tsconfig that does not parse reads as empty",
    file: "lib/jsonc.mjs",
    find: "if (!text || errors.length === 0) return { value: value ?? {} };",
    replace: "return { value: value ?? {} };",
  },
  {
    name: "--fix drops the comments of tsconfig.json",
    file: "lib/jsonc.mjs",
    find: "writeBack(path, read, applyEdits(text, edits));",
    replace:
      'writeBack(path, read, JSON.stringify(parse(applyEdits(text, edits)), null, 2) + "\\n");',
  },
  {
    name: "--fix writes a tsconfig that does not parse",
    file: "lib/checks/glue.mjs",
    find: 'if (tsconfig.error) return [parseProblem("tsconfig.json", tsconfig.error)];',
    replace:
      'if (tsconfig.error) return [parseProblem("tsconfig.json", tsconfig.error), say.extends];',
  },
  {
    name: "a renamed tinker import counts no call",
    file: "lib/checks/glue.mjs",
    find: "callsOf(source, glue.local)",
    replace: 'callsOf(source, "tinker")',
  },
  {
    name: "a config with no tinker() call stops the build",
    file: "lib/checks/glue.mjs",
    find: "calls.length > 1 && say.calls(",
    replace: "calls.length !== 1 && say.calls(",
  },
  {
    name: "tinker prepare runs the generator while check 7 fails",
    file: "lib/checks/generated.mjs",
    find: 'return checked.status === "fail" ? [say.notRun, ...checked.lines] : [];',
    replace: "return [];",
  },
  {
    name: ".gitignore gets no newline before the append",
    file: "lib/checks/generated.mjs",
    find: 'const lead = text && !text.endsWith("\\n") ? "\\n" : "";',
    replace: 'const lead = "";',
  },
  {
    name: "export * is never followed",
    file: "lib/source.mjs",
    find: "const target = localModule(from, node.source.value);",
    replace: "const target = null;",
  },
  {
    name: "an export * from a package fails the check",
    file: "lib/source.mjs",
    find: "if (!target) return { names: new Map(), open: true };",
    replace: "if (!target) return { names: new Map(), open: false };",
  },
  {
    name: "the shell link is a text match again",
    file: "lib/checks/style.mjs",
    find: "!linksStyle(root)",
    replace: "!/style\\.css\\?url/.test(readText(join(root, shellFile)))",
  },
  {
    name: "a bad components.json throws",
    file: "lib/checks/style.mjs",
    find: "if (components.error) return [say.parse(components.error)];",
    replace: "",
  },
  {
    name: "a wrong createFileRoute path is not named",
    file: "lib/checks/routes.mjs",
    find: "call.value !== id",
    replace: "false",
  },
  {
    name: "a stale pin is not named",
    file: "lib/checks/version.mjs",
    find: ".filter(([, spec]) => exact.test(spec))",
    replace: ".filter(() => false)",
  },
  {
    name: "tinker prepare wipes the boundary record",
    file: "lib/prepare.mjs",
    find: "  return Object.keys(files);\n}",
    replace:
      '  writeFileSync(join(dir, "violations.json"), "[]\\n");\n  return Object.keys(files);\n}',
  },
  {
    name: "dev restarts on any file",
    file: "lib/hooks.mjs",
    find: "picked.includes(path) ?",
    replace: "true ?",
  },
  {
    name: "a production error page shows the text",
    file: "src/entry/error-detail.ts",
    find: "if (!dev) return undefined;",
    replace: "",
  },
  {
    name: "components.json is read leniently",
    file: "lib/checks/style.mjs",
    find: 'readJsonc(join(root, "components.json"), { strict: true })',
    replace: 'readJsonc(join(root, "components.json"))',
  },
  {
    name: "package.json is read leniently",
    file: "lib/checks/glue.mjs",
    find: 'readJsonc(join(root, "package.json"), { strict: true })',
    replace: 'readJsonc(join(root, "package.json"))',
  },
  {
    name: "a postinstall prepare blocks the install",
    file: "lib/prepare.mjs",
    find: 'lifecycle !== "postinstall"',
    replace: "true",
  },
  {
    name: "check 3 says run tinker prepare while check 7 fails",
    file: "lib/checks/generated.mjs",
    find: 'routes(root).status === "fail" ? say.check7Next : say.prepareNext',
    replace: "say.prepareNext",
  },
  {
    name: "any value named Outlet counts as the outlet",
    file: "lib/checks/routes.mjs",
    find: "(outlet && usesOf(source, outlet.local).length > 0)",
    replace: 'usesOf(source, "Outlet").length > 0',
  },
  {
    name: "a byte order mark breaks the parse",
    file: "lib/jsonc.mjs",
    find: "const marked = raw.startsWith(bom);",
    replace: "const marked = false;",
  },
  {
    name: "--fix drops the byte order mark",
    file: "lib/jsonc.mjs",
    find: '${read.marked ? bom : ""}',
    replace: "",
  },
  {
    name: "--fix always indents with two spaces",
    file: "lib/jsonc.mjs",
    find: "insertSpaces: !tabs,",
    replace: "insertSpaces: true,",
  },
  {
    name: "an extends array never counts",
    file: "lib/checks/glue.mjs",
    find: "![parent].flat().includes(tinkerConfig)",
    replace: "parent !== tinkerConfig",
  },
  {
    name: "a file extended after .tinker is never read",
    file: "lib/checks/glue.mjs",
    find: "list.slice(list.indexOf(join(root, tinkerConfig)) + 1).reverse()",
    replace: "[]",
  },
  {
    name: "a file extended before .tinker counts too",
    file: "lib/checks/glue.mjs",
    find: "list.slice(list.indexOf(join(root, tinkerConfig)) + 1).reverse()",
    replace: "list.reverse()",
  },
  {
    name: "the first extended file wins, not the last",
    file: "lib/checks/glue.mjs",
    find: "list.slice(list.indexOf(join(root, tinkerConfig)) + 1).reverse()",
    replace: "list.slice(list.indexOf(join(root, tinkerConfig)) + 1)",
  },
  {
    name: "an extends name with no .json is not found",
    file: "lib/checks/glue.mjs",
    find: "    ? path\n    : `${path}.json`;",
    replace: "    ? path\n    : path;",
  },
  {
    name: "an extended file's own extends is not followed",
    file: "lib/checks/glue.mjs",
    find: "...extendedChain(root, file, parent, seen)",
    replace: "...[]",
  },
  {
    name: "a byte order mark passes strict JSON",
    file: "lib/jsonc.mjs",
    find: "if (strict && marked) return",
    replace: "if (false) return",
  },
  {
    name: "a byte order mark in package.json reads as a parse code",
    file: "lib/checks/glue.mjs",
    find: "error.code === byteOrderMark ? say.mark(file) : ",
    replace: "",
  },
  {
    name: "--fix replaces the extends key",
    file: "lib/jsonc.mjs",
    find: '  if (!node) return writeKey(path, read, ["extends"], entry);',
    replace: '  return writeKey(path, read, ["extends"], entry);',
  },
  {
    name: "lazy routes read as missed",
    file: "lib/checks/generated.mjs",
    find: "(?:from |import\\()'",
    replace: "from '",
  },
  {
    name: "an extends array breaks shadcn's alias read",
    file: "lib/checks/style.mjs",
    find: "[own.value.extends ?? []]\n    .flat()",
    replace: "[own.value.extends ?? []]",
  },
  {
    name: "the type check never runs",
    file: "lib/typecheck.mjs",
    find: "export function checkTypes(root) {",
    replace: "export function checkTypes(root) {\n  return [];",
  },
  {
    name: ".env beats the shell",
    file: "lib/env.mjs",
    find: "if (key in process.env && !fromEnvFile.has(key)) continue;",
    replace: "",
  },
  {
    name: "an edited .env keeps its old value",
    file: "lib/env.mjs",
    find: "process.env[key] = value;",
    replace: "process.env[key] ??= value;",
  },
  {
    name: "serve hands out dot paths",
    file: "lib/serve.mjs",
    find: 'if (path.split("/").some((part) => part.startsWith("."))) return null;',
    replace: "",
  },
  {
    name: "serve skips public/ files",
    file: "lib/serve.mjs",
    find: "const found = await readStatic(file, immutable);",
    replace: "const found = immutable ? await readStatic(file, immutable) : null;",
  },
  {
    name: "upgrade breaks a tarball peer",
    file: "lib/upgrade.mjs",
    find: "if (installed(name) === version) continue;",
    replace: "",
  },
  {
    name: "readResult hides a failure",
    file: "src/backend/result.server.ts",
    find: 'if (result.status === "failed") throw result.error;',
    replace: "",
  },
  {
    name: "the dev error page never shows",
    file: "src/entry/dev-error.ts",
    find: "if (response.status !== 500 || !page || !json) return response;",
    replace: "return response;",
  },
  {
    name: "the default server entry skips the base",
    file: "src/defaults/server.ts",
    find: "next(request)",
    replace: 'new Response("x")',
  },
  {
    name: "a read body ends the request as cancelled",
    file: "src/backend/body.server.ts",
    find: "await finish(!owned.cancelled);",
    replace: "await finish(false);",
  },
  {
    name: "an off part's route still mounts",
    file: "lib/glue.mjs",
    find: "...on.map((name) => parts[name].routes)",
    replace: "...Object.keys(parts).map((name) => parts[name].routes)",
  },
  {
    name: "the parts files have no alias",
    file: "lib/glue.mjs",
    find: '{ find: /^#tinker\\/parts$/, replacement: join(root, ".tinker/parts.ts") },',
    replace: "",
  },
  {
    name: "a part switch is ignored",
    file: "lib/parts.mjs",
    find: "const value = options[name] ?? part.on;",
    replace: "const value = part.on;",
  },
  {
    name: "a part switch that is not a boolean passes",
    file: "lib/parts.mjs",
    find: 'if (typeof value !== "boolean")',
    replace: "if (false)",
  },
  {
    name: "the recorded parts are ignored",
    file: "lib/parts.mjs",
    find: 'readJson(join(root, ".tinker/base.json")).parts ?? partsOn({});',
    replace: "partsOn({});",
  },
  {
    name: "a recorded part this base lacks is kept",
    file: "lib/parts.mjs",
    find: "return recorded.filter((name) => name in parts);",
    replace: "return recorded;",
  },
  {
    name: "a parts file always imports the on module",
    file: "lib/prepare.mjs",
    find: 'on.includes(name) ? part.entries[entry] : "off.ts"',
    replace: "part.entries[entry]",
  },
  {
    name: "base.json records no parts",
    file: "lib/prepare.mjs",
    find: "json({ base: basePackage.version, parts: on })",
    replace: "json({ base: basePackage.version })",
  },
  {
    name: "check 7 ignores the on parts' routes",
    file: "lib/checks/routes.mjs",
    find: "...recordedParts(root)",
    replace: "...[]",
  },
  {
    name: "check 7 names no part switch",
    file: "lib/checks/routes.mjs",
    find: "part ? say.partClash(at, clash, part) : say.clash(at, clash)",
    replace: "say.clash(at, clash)",
  },
  {
    name: "check 9 checks no part key",
    file: "lib/checks/env.mjs",
    find: "...partProblems(root, local, keys)",
    replace: "",
  },
  {
    name: "check 9 blames .env for a shell value",
    file: "lib/checks/env.mjs",
    find: 'process.env[key]\n        ? "the shell"',
    replace: 'false\n        ? "the shell"',
  },
  {
    name: "check 9 lets .env beat the shell",
    file: "lib/checks/env.mjs",
    find: "{ ...local, ...process.env }",
    replace: "{ ...process.env, ...local }",
  },
  {
    name: "an empty part key reads as set",
    file: "lib/part-env.mjs",
    find: "values[key] = env[key] || fallback;",
    replace: "values[key] = env[key] ?? fallback;",
  },
  {
    name: "a part rule accepts any value",
    file: "lib/part-env.mjs",
    find: "(rule && !rules[rule].accepts(values[key]))",
    replace: "false",
  },
  {
    name: "an ftp URL passes as http",
    file: "lib/part-env.mjs",
    find: "/^https?:$/",
    replace: "/^[a-z]+:$/",
  },
  {
    name: "the telemetry part starts with a refused key",
    file: "src/parts/telemetry/settings.ts",
    find: 'if (refused.length > 0) raise("BadSettings", { part: "telemetry", keys: refused });',
    replace: "",
  },
  {
    name: "a tab gets the storage URLs",
    file: "src/parts/telemetry/settings.ts",
    find: 'if (side === "browser") return { side, service };',
    replace: "",
  },
  {
    name: "a tab's batch keeps the tab's service",
    file: "src/parts/telemetry/ingest.server.ts",
    find: "service: settings.service",
    replace: "service: record.service",
  },
  {
    name: "the ingest route takes any origin",
    file: "src/parts/telemetry/ingest.server.ts",
    find: 'request.headers.get("origin") !== expected',
    replace: "false",
  },
  {
    name: "the parts' seam names are not checked",
    file: "lib/checks/named.mjs",
    find: "...partProblems(root), ",
    replace: "",
  },
  {
    name: "a missing seam file reads as a missing name",
    file: "lib/checks/named.mjs",
    find: "if (!existsSync(join(root, file))) return [say.noSeam(file, part, names)];",
    replace: "",
  },
  {
    name: "a route under a base splat is free",
    file: "lib/route-path.mjs",
    find: 'path.endsWith("/$") && routePath(file)',
    replace: "false && routePath(file)",
  },
  {
    name: "an unset part key is not named",
    file: "lib/checks/env.mjs",
    find: "return listed.includes(key) ? [] : [say.unset(key, name)];",
    replace: "return [];",
  },
  {
    name: "an unset part key that .env.example lists is named twice",
    file: "lib/checks/env.mjs",
    find: "return listed.includes(key) ? [] : [say.unset(key, name)];",
    replace: "return [say.unset(key, name)];",
  },
  {
    name: "listed keys come in parseEnv's sorted order",
    file: "lib/checks/env.mjs",
    find: ".sort((a, b) => a.line - b.line)",
    replace: "",
  },
  {
    name: "a short secret passes",
    file: "lib/part-env.mjs",
    find: "value.length >= 32",
    replace: "value.length >= 0",
  },
  {
    name: "a parts file exports every part, read or not",
    file: "lib/prepare.mjs",
    find: ".filter(([, part]) => entry in part.entries)",
    replace: "",
  },
  {
    name: "the auth part takes a refused key",
    file: "src/parts/auth/settings.ts",
    find: 'if (refused.length > 0) raise("BadSettings", { part: "auth", keys: refused });',
    replace: "",
  },
  {
    name: "the app root starts without reading the auth keys",
    file: "src/parts/auth/settings.ts",
    find: "resolve(authSettings);",
    replace: "",
  },
  {
    name: "handleAuth hands the library another request",
    file: "src/parts/auth/handle.server.ts",
    find: "auth.handler(input)",
    replace: 'auth.handler(new Request("http://app/"))',
  },
  {
    name: "a part's needs are not turned on",
    file: "lib/parts.mjs",
    find: "chosen.includes(name) || needed.includes(name)",
    replace: "chosen.includes(name)",
  },
  {
    name: "sync with auth: false passes",
    file: "lib/parts.mjs",
    find: "if (options[need] === false)",
    replace: "if (false)",
  },
  {
    name: "the record does not say sync turned auth on",
    file: "lib/prepare.mjs",
    find: "const notes = partNotes(on)",
    replace: "const notes = []",
  },
  {
    name: "another account's private cursor opens",
    file: "src/parts/sync/stream.server.ts",
    find: "if (initial.private && initial.private.accountId !== initialAccount)",
    replace: "if (false)",
  },
  {
    name: "an account change sends no frame",
    file: "src/parts/sync/stream.server.ts",
    find: "output?.enqueue(encoder.encode(accountChange));",
    replace: "",
  },
  {
    name: "one frame carries any number of events",
    file: "src/parts/sync/stream.server.ts",
    find: ".limit(100)",
    replace: ".limit(1000)",
  },
  {
    name: "the stream never greets",
    file: "src/parts/sync/stream.server.ts",
    find: 'controller.enqueue(encoder.encode(": connected\\n\\n"));',
    replace: 'controller.enqueue(encoder.encode(": hello\\n\\n"));',
  },
  {
    name: "a bad cursor fails the reply",
    file: "src/parts/sync/endpoint.server.ts",
    find: "if (!(error instanceof SyntaxError) && !(error instanceof ZodError)) throw error;",
    replace: "throw error;",
  },
  {
    name: "another account's cursor is not a 403",
    file: "src/parts/sync/endpoint.server.ts",
    find: 'Object(result.error).kind === "StreamDenied"',
    replace: "false",
  },
  {
    name: "?cursor= beats Last-Event-ID",
    file: "src/parts/sync/endpoint.server.ts",
    find: 'lastEventId || new URLSearchParams(search).get("cursor")',
    replace: 'new URLSearchParams(search).get("cursor") || lastEventId',
  },
  {
    name: "the event history appends at the wrong revision",
    file: "src/parts/sync/history.server.ts",
    find: "row.revision - payloads.length + offset + 1",
    replace: "row.revision + offset",
  },
  {
    name: "a broken listener leaves its subscribers waiting",
    file: "src/parts/sync/notifications.server.ts",
    find: "if (broken || subscriber.opened !== connection) subscriber.disconnected?.();",
    replace: "",
  },
  {
    name: "a seam with no Register bodies passes",
    file: "lib/checks/named.mjs",
    find: "if (needed.length === 0) return [];",
    replace: "return [];",
  },
  {
    name: "an augmentation is never found",
    file: "lib/source.mjs",
    find: "found.push({ module: node.id.value, name: item.id.name });",
    replace: ";",
  },
  {
    name: "the client entry is not a base entry",
    file: "lib/checks/imports.mjs",
    find: '  "@tinker/start/client",\n',
    replace: "",
  },
  {
    name: "a stale snapshot applies",
    file: "src/parts/sync/client/sync.ts",
    find: "bootstrap(snapshot: Sync.Snapshot, version: number) {\n        if (version !== owner.capture().version) return;",
    replace: "bootstrap(snapshot: Sync.Snapshot, version: number) {",
  },
  {
    name: "an event past a gap applies",
    file: "src/parts/sync/client/sync.ts",
    find: "if (event.revision !== previous + 1) break;",
    replace: "",
  },
  {
    name: "a rejected write succeeds",
    file: "src/parts/sync/client/sync.ts",
    find: 'if (reply.kind === "rejected") raise("WriteRejected", { message: reply.message });',
    replace: "",
  },
  {
    name: "an account exit keeps the old account's signal",
    file: "src/parts/sync/client/owner.ts",
    find: "stop.abort();\n          stop = new AbortController();",
    replace: "stop = new AbortController();",
  },
  {
    name: "the tab stop leaves account work running",
    file: "src/parts/sync/client/owner.ts",
    find: 'signal.addEventListener("abort", cancel, { once: true });',
    replace: "",
  },
  {
    name: "a back-forward cache hide closes the tab",
    file: "src/parts/sync/client/owner.ts",
    find: 'if (!("persisted" in event) || !event.persisted) return close?.();',
    replace: "return close?.();",
  },
  {
    name: "a tab queues any number of unread frames",
    file: "src/parts/sync/client/events.ts",
    find: "if (queue.length >= 8) {",
    replace: "if (false) {",
  },
  {
    name: "a connection starts the public stream over",
    file: "src/parts/sync/client/events.ts",
    find: "public: Math.max(0, cursors.publicRevision),",
    replace: "public: 0,",
  },
  {
    name: "an account frame keeps the account",
    file: "src/parts/sync/client/events.ts",
    find: "    sync.leave();\n    return true;",
    replace: "    return true;",
  },
  {
    name: "a refresh keeps a changed account",
    file: "src/parts/sync/client/events.ts",
    find: "      sync.leave();\n      await load.run();",
    replace: "",
  },
  {
    name: "reconnects wait less than 500 ms",
    file: "src/parts/sync/client/events.ts",
    find: "await clock.sleep(500, signal);",
    replace: "await clock.sleep(400, signal);",
  },
  {
    name: "a hydrated tab does not stream",
    file: "src/parts/sync/client/router.ts",
    find: "        streaming.start();\n",
    replace: "",
  },
  {
    name: "the telemetry queue has no count bound",
    file: "src/parts/telemetry/queue.ts",
    find: "records.length >= 512,",
    replace: "false,",
  },
];

/** Message breaks: one per entry of each check's `say` table, by adding a mark to its text. */
function messageBreaks() {
  return readdirSync(join(base, "lib/checks"))
    .filter((file) => file !== "result.mjs")
    .concat(["../typecheck.mjs"])
    .flatMap((file) => {
      const path = `lib/checks/${file}`.replace("checks/../", "");
      const text = readFileSync(join(base, path), "utf8");
      const table = text.slice(
        text.indexOf("export const say = {"),
        text.indexOf("\n};", text.indexOf("export const say = {")),
      );
      return [...table.matchAll(/^ {2}(\w+):[^"'`]*?(["'`])/gm)].map((match) => {
        const at = text.indexOf(table) + match.index + match[0].length;
        return { name: `message ${path.split("/").at(-1)} say.${match[1]}`, file: path, at };
      });
    });
}

/** @param {{ file: string, find?: string, replace?: string, at?: number }} change - From the lists above; why: the one edit to make. */
function applyBreak(change) {
  const path = join(scratch, change.file);
  const text = readFileSync(path, "utf8");
  if (change.at !== undefined)
    return writeFileSync(path, `${text.slice(0, change.at)}~${text.slice(change.at)}`);
  if (!text.includes(change.find))
    throw new Error(`break "${change.name}": text not found in ${change.file}`);
  writeFileSync(
    path,
    text.replace(change.find, () => change.replace),
  );
}

/** Copy the base to scratch, sharing its installed packages. */
function freshScratch() {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  cpSync(base, scratch, {
    recursive: true,
    filter: (path) => !path.includes("node_modules") && !path.includes("/packs"),
  });
  symlinkSync(join(base, "node_modules"), join(scratch, "node_modules"), "dir");
}

/**
 * Run the tests in scratch and read the JSON report: vitest exits 1 when a test fails, so the
 * exit code is ignored. A suite that fails to load counts apart: it proves no test.
 */
function failedTests() {
  rmSync("/tmp/tinker-break/out.json", { force: true });
  try {
    execFileSync("vp", ["test", "--reporter=json", "--outputFile=/tmp/tinker-break/out.json"], {
      cwd: scratch,
      stdio: "ignore",
    });
  } catch {}
  const report = JSON.parse(readFileSync("/tmp/tinker-break/out.json", "utf8"));
  const broken = report.testResults.filter((file) => file.assertionResults.length === 0).length;
  return { failed: report.numFailedTests, broken };
}

const only = (process.env.BREAKS ?? "").split(",").filter(Boolean);
const unknown = only.filter((part) =>
  [...breaks, ...messageBreaks()].every(({ name }) => !name.includes(part)),
);
if (unknown.length > 0) throw new Error(`BREAKS names no break: ${unknown.join(", ")}`);
const chosen = (change) => only.length === 0 || only.some((part) => change.name.includes(part));
const logic = breaks.filter(chosen);
const all = [...logic, ...messageBreaks().filter(chosen)];
freshScratch();
const control = failedTests();
console.log(
  `control (no break): ${control.failed} failed test(s), ${control.broken} broken file(s)`,
);
let caught = 0;
for (const change of all) {
  freshScratch();
  applyBreak(change);
  const { failed, broken } = failedTests();
  const ok = failed > 0 && broken === 0;
  if (ok) caught += 1;
  console.log(`${ok ? "caught" : "MISSED"}  ${String(failed).padStart(3)} failed  ${change.name}`);
}
console.log(
  `\n${caught} of ${all.length} breaks caught (${logic.length} logic, ${all.length - logic.length} message)${only.length > 0 ? `; BREAKS=${only.join(",")}` : ""}`,
);
process.exitCode = caught === all.length && control.failed === 0 ? 0 : 1;
