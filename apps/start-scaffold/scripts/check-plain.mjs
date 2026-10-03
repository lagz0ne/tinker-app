import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import ts from "typescript-api";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? app);
const entries = new Set(["src/server.ts", "src/router.tsx", "src/scaffold/frontend/router.tsx"]);
const failures = [];
const files = [];
async function scan(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.(gen|generated|d)\.tsx?$/.test(entry.name))
      files.push(path);
  }
}
await scan(join(root, "src"));
const config = ts.readConfigFile(join(root, "tsconfig.json"), (path) => ts.sys.readFile(path));
assert.equal(config.error, undefined, "tsconfig must be readable");
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(files, parsed.options);
const checker = program.getTypeChecker();
const sources = files.sort((a, b) => a.localeCompare(b)).map((file) => program.getSourceFile(file));
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
function nameOf(node) {
  return node?.getText() ?? "";
}
function symbolOf(node) {
  let symbol = ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node);
  symbol = bindingSymbol(node, symbol);
  const alias = variableAlias(symbol);
  if (alias) return symbolOf(alias);

  return symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}
function bindingSymbol(node, symbol) {
  if (symbol?.valueDeclaration && ts.isBindingElement(symbol.valueDeclaration))
    return checker.getTypeAtLocation(node).symbol ?? symbol;
  return symbol;
}
function variableAlias(symbol) {
  const decl = symbol?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  return ts.isIdentifier(decl.initializer) ? decl.initializer : undefined;
}
function coreSymbol(node, name) {
  const symbol = symbolOf(node);
  return (
    symbol?.name === name &&
    symbol.declarations?.some((decl) =>
      /(?:@tinker\/core|packages\/core)\//.test(decl.getSourceFile().fileName),
    )
  );
}
function at(node) {
  const file = node.getSourceFile();
  return `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}
function fail(node, rule) {
  failures.push(`${at(node)}: ${rule}`);
}
function functionName(node) {
  return node.name ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined);
}
function isFunction(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}
function isEntry(node) {
  const path = relative(root, node.getSourceFile().fileName);
  const name = nameOf(functionName(node));
  return (
    (path === "src/server.ts" && ["start", "close", "fetch"].includes(name)) ||
    (["src/router.tsx", "src/scaffold/frontend/router.tsx"].includes(path) && name === "getRouter")
  );
}
function isComponent(node) {
  if (
    !node.getSourceFile().fileName.endsWith(".tsx") ||
    !/^[A-Z]/.test(nameOf(functionName(node))) ||
    node.parameters.length > 1
  )
    return false;
  let jsx = false;
  walk(node.body, (child) => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child))
      jsx = true;
  });
  return jsx;
}
function ownedMethod(node) {
  if (!ts.isMethodDeclaration(node) && !ts.isPropertyAssignment(node.parent)) return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      ["resource", "extension", "operation"].some((name) => coreSymbol(parent.expression, name))
    )
      return true;
  }
  return false;
}
function nativeCallback(node) {
  let parentNode = node.parent;
  while (ts.isParenthesizedExpression(parentNode)) parentNode = parentNode.parent;
  if (!functionName(node))
    return (
      ts.isCallExpression(parentNode) ||
      ts.isPropertyAssignment(node.parent) ||
      ts.isJsxExpression(node.parent) ||
      ts.isBinaryExpression(node.parent)
    );
  const symbol = symbolOf(functionName(node));
  let callback = false;
  walk(node.getSourceFile(), (use) => {
    if (!sameUse(use, functionName(node), symbol)) return;
    if (callbackUse(use, node)) callback = true;
  });
  return callback;
}

function sameUse(use, name, symbol) {
  return ts.isIdentifier(use) && use !== name && symbolOf(use) === symbol;
}
function callbackUse(use, node) {
  const parent = use.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(use)) {
    return /\.(?:addEventListener|removeEventListener|defer|dispose|listen|hold)$/.test(
      nameOf(parent.expression),
    );
  }
  return (
    (ts.isShorthandPropertyAssignment(parent) || ts.isReturnStatement(parent)) && graphOwner(node)
  );
}
function localProperty(prop, visit) {
  const decl = prop.valueDeclaration ?? prop.declarations?.at(0);
  if (!decl || /node_modules/.test(decl.getSourceFile().fileName)) return false;
  return visit(checker.getTypeOfSymbolAtLocation(prop, decl));
}
function awaitedHandle(type, seen) {
  const awaited = checker.getAwaitedType(type);
  return awaited !== type && containsHandle(awaited, seen);
}
function scopeType(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  const text = checker.typeToString(type);
  if (/\b(?:RootHandle|SessionHandle|DataController|OperationController)\b/.test(text)) return true;
  if (type.isUnionOrIntersection()) return type.types.some((part) => scopeType(part, seen));
  const props = checker.getPropertiesOfType(type);
  return (
    props.some((prop) => prop.name === "resolve") &&
    props.some((prop) => ["createSession", "settle"].includes(prop.name))
  );
}
function coreHandle(type) {
  const symbol = type?.aliasSymbol ?? type?.symbol;
  return (
    /Handle|Controller|Ctx/.test(symbol?.name ?? "") &&
    symbol.declarations?.some((decl) =>
      /(?:@tinker\/core|packages\/core)\//.test(decl.getSourceFile().fileName),
    )
  );
}
function containsHandle(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (scopeType(type) || coreHandle(type)) return true;
  if (type.isUnionOrIntersection()) return type.types.some((part) => containsHandle(part, seen));
  if (awaitedHandle(type, seen)) return true;
  return checker
    .getPropertiesOfType(type)
    .some((prop) => localProperty(prop, (child) => containsHandle(child, seen)));
}

function callable(type) {
  return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
}
function forbidden(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  const text = checker.typeToString(type);
  if (
    scopeType(type) ||
    /\b(?:AbortSignal|AbortController|Clock|Ctx|Controller|Context|ProcessEnv|IncomingMessage|ServerResponse|Socket|Server|Client|Pool|ReadStream|WriteStream|ReadableStream|WritableStream|Response|Request|Headers)\b/.test(
      text,
    )
  )
    return true;
  if ([coreHandle, callable].some((rule) => rule(type))) return true;
  if (type.isUnionOrIntersection()) return type.types.some((part) => forbidden(part, seen));
  return checker
    .getPropertiesOfType(type)
    .some((prop) => localProperty(prop, (child) => forbidden(child, seen)));
}

function graphOwner(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      ["resource", "extension", "operation"].some((name) => coreSymbol(parent.expression, name))
    )
      return true;
  }
  return false;
}
function serviceAllocation(node) {
  if (ts.isNewExpression(node))
    return /(?:^|\.)(?:Map|Set|AbortController|EventSource|WebSocket|Worker|Pool|Client|Server|ReadableStream|WritableStream)$/.test(
      nameOf(node.expression),
    );
  if (ts.isCallExpression(node))
    return /(?:^|\.)(?:createServer|connect|watch|setTimeout|setInterval|pino|betterAuth)$/.test(
      nameOf(node.expression),
    );
  return false;
}
function checkService(node) {
  if (!serviceAllocation(node) || graphOwner(node)) return;
  if (
    entries.has(relative(root, node.getSourceFile().fileName)) &&
    ts.isNewExpression(node) &&
    nameOf(node.expression) === "AbortController"
  )
    return;
  fail(node, "service-owner");
}
function exportedFunction(node) {
  const source = node.getSourceFile();
  const module = checker.getSymbolAtLocation(source);
  const name = functionName(node);
  if (!module || !name) return false;
  const symbol = symbolOf(name);
  return checker.getExportsOfModule(module).some((entry) => {
    const value = entry.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(entry) : entry;
    return value === symbol;
  });
}
const plain = [];
function checkRoots(node) {
  if (
    ts.isCallExpression(node) &&
    coreSymbol(node.expression, "createScope") &&
    !entries.has(relative(root, node.getSourceFile().fileName))
  )
    fail(node, "scope-entry-only");
  if (!ts.isVariableDeclaration(node)) return;
  if (node.parent.parent.parent !== node.getSourceFile()) return;
  if (node.parent.flags & ts.NodeFlags.Const) return;
  if (containsHandle(checker.getTypeAtLocation(node.name))) fail(node, "module-handle");
}
function callUse(use) {
  if (ts.isPropertyAccessExpression(use.parent) && use.parent.name === use)
    return callUse(use.parent);
  const parent = use.parent;
  if (ts.isCallExpression(parent))
    return parent.expression === use || parent.arguments.includes(use);
  return ts.isPropertyAssignment(parent) && parent.initializer === use;
}
function callSites(name) {
  const symbol = symbolOf(name);
  const calls = [];
  for (const caller of sources)
    walk(caller, (use) => {
      if (sameUse(use, name, symbol) && callUse(use)) calls.push(relative(root, caller.fileName));
    });
  return calls;
}
function paramRow(param) {
  const doc = ts
    .getJSDocParameterTags(param)
    .map((tag) => (typeof tag.comment === "string" ? tag.comment.replace(/^-\s*/, "") : ""))
    .join(" ");
  if (!/\bFrom\b.+;\s*(?:why|for)\b.+/i.test(doc)) fail(param, "param-doc");
  if (
    /^(?:ctx|context|clock|signal|scope|controller)$/i.test(nameOf(param.name)) ||
    forbidden(checker.getTypeAtLocation(param))
  )
    fail(param, "plain-param");
  return `  - \`${nameOf(param.name)}\`: \`${param.type?.getText() ?? checker.typeToString(checker.getTypeAtLocation(param))}\`. ${doc}`;
}
function checkEffect(node) {
  if (ts.isAwaitExpression(node) || serviceAllocation(node)) fail(node, "plain-effect");
  if (
    ts.isCallExpression(node) &&
    /^(?:fetch|setTimeout|setInterval|Date\.now|Math\.random)$/.test(nameOf(node.expression))
  )
    fail(node, "plain-effect");
}
function listPlain(node) {
  const name = functionName(node);
  if (!name) {
    fail(node, "unnamed-plain");
    return;
  }
  const calls = callSites(name);
  const params = node.parameters.map(paramRow);
  if (node.parameters.length > 3) fail(node, "three-params");
  if (calls.length < 2) fail(node, "two-sites");
  walk(node.body, checkEffect);
  const sites = [...new Set(calls)]
    .sort((a, b) => a.localeCompare(b))
    .map((call) => `    - \`${call}\`: ${calls.filter((site) => site === call).length} site(s).`);
  plain.push(
    `- **${relative(root, node.getSourceFile().fileName)}#${nameOf(name)}**\n${params.join("\n")}\n  - Sites:\n${sites.join("\n")}`,
  );
}
function checkFunction(node) {
  if (!isFunction(node) || !node.body) return;
  if (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) return;
  const signature = checker.getSignatureFromDeclaration(node);
  if (exportedFunction(node) && containsHandle(checker.getReturnTypeOfSignature(signature)))
    fail(node, "exported-scope");
  if ([isEntry, isComponent, ownedMethod, nativeCallback].some((rule) => rule(node))) return;
  listPlain(node);
}
for (const source of sources) {
  for (const error of program.getSyntacticDiagnostics(source))
    fail(source, ts.flattenDiagnosticMessageText(error.messageText, " "));
  walk(source, (node) => {
    checkService(node);
    checkRoots(node);
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) fail(node, "no-class");
    checkFunction(node);
  });
}

const list = `# Plain functions\n\nThis list is checked against src.\nSites include direct calls and callbacks passed to their owner.\nTests and generated files do not count.\n\n${plain.join("\n\n")}\n`;
if (process.argv.includes("--list")) {
  process.stdout.write(list);
} else {
  if ((await readFile(join(root, "PLAIN.md"), "utf8")) !== list)
    failures.push("PLAIN.md: plain-list disagrees with code; inspect check:plain --list");
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`Plain check passed: ${sources.length} files, ${plain.length} plain functions.`);
}

if (process.argv.includes("--prove")) {
  const planted = await mkdtemp(join(tmpdir(), "start-plain-red-"));
  const cases = [
    ["class", "no-class", "class Probe {}"],
    [
      "clock",
      "plain-param",
      'import type { Clock } from "@tinker/core"; function probe(value: Clock.Handle) { return value; } probe(null!); probe(null!);',
    ],
    [
      "signal",
      "plain-param",
      "type Stop = AbortSignal; function probe(value: Stop) { return value; } probe(null!); probe(null!);",
    ],
    [
      "handle",
      "plain-param",
      'import type { Scope } from "@tinker/core"; function probe(value: Scope.Handle) { return value; } probe(null!); probe(null!);',
    ],
    ["ctx", "plain-param", "function probe(ctx: unknown) { return ctx; } probe(1); probe(2);"],
    [
      "io",
      "plain-param",
      'import type { IncomingMessage } from "node:http"; function probe(value: IncomingMessage) { return value; } probe(null!); probe(null!);',
    ],
    [
      "four-params",
      "three-params",
      "function probe(a: number, b: number, c: number, d: number) { return a+b+c+d; } probe(1,2,3,4); probe(2,3,4,5);",
    ],
    ["one-site", "two-sites", "function probe(a: number) { return a; } probe(1);"],
    ["no-doc", "param-doc", "function probe(a: number) { return a; } probe(1); probe(2);"],
    [
      "scope-factory",
      "scope-entry-only",
      'import { createScope as open } from "@tinker/core"; open();',
    ],
    [
      "module-handle",
      "module-handle",
      'import type { Scope } from "@tinker/core"; let root: Scope.Handle | undefined;',
    ],
    [
      "scope-getter",
      "exported-scope",
      'import type { Scope } from "@tinker/core"; export function probe(value: Scope.Handle) { return value; }',
    ],
    ["service-module", "service-owner", "const cache = new Map();"],
    ["service-plain", "service-owner", "function probe() { return new Map(); } probe(); probe();"],
    [
      "scope-arrow",
      "exported-scope",
      'import type { Scope } from "@tinker/core"; export const probe = (value: Scope.Handle) => value;',
    ],
    [
      "module-clock",
      "module-handle",
      'import type { Clock } from "@tinker/core"; let clock: Clock.Handle | undefined;',
    ],
    [
      "module-nested-root",
      "module-handle",
      'import type { Scope } from "@tinker/core"; let owner: Promise<{scope: Scope.Handle}> | undefined;',
    ],
    [
      "scope-reexport",
      "exported-scope",
      'import type { Scope } from "@tinker/core"; const probe = (value: Scope.Handle) => value; export { probe };',
    ],
    [
      "plain-callback",
      "plain-param",
      "function probe(value: () => void) { return value; } probe(() => {}); probe(() => {});",
    ],
    [
      "clock-bag",
      "plain-param",
      'import type { Clock } from "@tinker/core"; type Bag = { clock: Clock.Handle }; function probe(value: Bag) { return value; } probe(null!); probe(null!);',
    ],
    [
      "scope-local-alias",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; const open = createScope; open();',
    ],
    [
      "scope-namespace",
      "scope-entry-only",
      'import * as Core from "@tinker/core"; Core.createScope();',
    ],
    [
      "plain-await",
      "plain-effect",
      "async function probe(value: number) { return await Promise.resolve(value); } probe(1); probe(2);",
    ],
    ["zero-site", "two-sites", "function probe(value: number) { return value; }"],
    ["class-expression", "no-class", "const probe = class {};"],
    ["list", "plain-list", "export const probe = 1;"],
  ];
  try {
    await cp(join(root, "src"), join(planted, "src"), { recursive: true });
    for (const file of ["tsconfig.json", "PLAIN.md"])
      await cp(join(root, file), join(planted, file));
    await symlink(join(root, "node_modules"), join(planted, "node_modules"), "dir");
    for (const [name, rule, source] of cases) {
      await writeFile(join(planted, "src/plain-probe.ts"), source + "\n");
      if (name === "list") await writeFile(join(planted, "PLAIN.md"), "wrong list\n");
      const red = spawnSync(process.execPath, [fileURLToPath(import.meta.url), planted], {
        encoding: "utf8",
      });
      const log = join(tmpdir(), `start-plain-proof-${name}.log`);
      await writeFile(log, red.stdout + red.stderr + `\nEXIT ${red.status}\n`);
      assert.equal(red.status, 1, name);
      assert.ok(red.stderr.includes(rule), `${name}: must fail by ${rule}`);
      console.log(`PASS: ${name} ${rule} EXIT 1; ${log}`);
    }
  } finally {
    await rm(planted, { recursive: true, force: true });
  }
}
