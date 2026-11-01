/**
 * The plain-function check (Duke 2026-10-31, tinker-app #44). App code has no plain helper
 * functions: every named function is an operation, so every call is a span and its dependencies
 * come through the graph. It reads src/, cmds/ and tinker/ (the syntax tree only, no types) and
 * prints one line per plain function.
 *
 * A function passes when it is one of these:
 * - inline: no name of its own, written where it is used (an argument, a JSX attribute, a
 *   returned value); an IIFE is not inline;
 * - a graph body: a direct option of a Core `operation`, `resource`, `tag` or `data`, or a hook
 *   of a capsule (in `capsule({ hooks })`, or in an object typed `Capsule.Hooks`);
 * - a native option: inside the options of a library call (`Bun.serve`, `createRoute`, ...);
 * - owned: named inside a passing function that returns it or hands it to a call;
 * - a listener: a top-level function handed to an event registration (`addEventListener`, ...);
 * - a React component: a capitalized function in a .tsx file that returns JSX;
 * - exempt by name (`cn`, `defineMain`), or one of the `entries` below.
 *
 * Usage: bun scripts/check-plain.ts [root]
 */
import { join, resolve } from "node:path";

import ts from "typescript-api";

/** The hooks Core 0.10.0's `capsule()` accepts (`Capsule.Hooks`). */
const hookNames = new Set(["start", "resolve", "run", "write", "close", "session"]);

/** Core calls whose direct options are graph bodies. */
const unitNames = new Set(["operation", "resource", "tag", "data"]);

/** Exempt by name: shadcn's `cn` (its registry imports it) and the type-only `defineMain`. */
const exemptNames = new Set(["cn", "defineMain"]);

/** Calls that register a listener: the event source calls it, never app code by name. */
const listenNames = new Set([
  "addEventListener",
  "removeEventListener",
  "on",
  "once",
  "off",
  "defer",
  "dispose",
]);

/**
 * Entry contracts that run outside any scope, keyed by file. Each needs a one-line reason.
 * Keep it small: anything else becomes an operation.
 */
const entries: Record<string, readonly string[]> = {
  // The Bun host: it runs before any scope exists, and owns OS signals and the exit code.
  "tinker/base/bun-host.ts": ["serveMain"],
  // The process panic hook: it must report even when the root's own close fails.
  "tinker/base/panics.server.ts": ["observeServerPanics"],
  "tinker/base/telemetry-worker.ts": [
    // The worker thread's inputs: read from `workerData` before its root exists.
    "telemetryWorkerInput",
    // The worker's native loop beside its root (ring, port, close). It traces nothing: a span
    // here would feed the telemetry it drains. `ringLines` and `takeLines` are its two steps.
    "serveTelemetryWorker",
    "ringLines",
    "takeLines",
  ],
};

type Fn =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.AccessorDeclaration;

/** What one file knows: its path, its Core imports, its library imports, its hooks objects. */
type File = {
  path: string;
  source: ts.SourceFile;
  core: Map<string, string>;
  library: Set<string>;
  hooks: Set<string>;
};

const root = resolve(Bun.argv[2] ?? join(import.meta.dir, ".."));
const verdicts = new Map<ts.Node, boolean>();

function isFn(node: ts.Node): node is Fn {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Walk a body without entering the functions inside it. */
function ownWalk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => {
    if (!isFn(child)) ownWalk(child, visit);
  });
}

function enclosingFn(node: ts.Node): Fn | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isFn(parent)) return parent;
  }
}

/** Wrappers that keep the value: parens, casts, and the branches of `a || b` or `c ? a : b`. */
function wraps(parent: ts.Node, node: ts.Node) {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isTypeAssertionExpression(parent)
  ) {
    return true;
  }
  if (ts.isConditionalExpression(parent)) return parent.condition !== node;
  return ts.isBinaryExpression(parent) && logical.has(parent.operatorToken.kind);
}

const logical = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

/** The outermost node that still holds this value. */
function outer(node: ts.Node) {
  while (node.parent && wraps(node.parent, node)) node = node.parent;
  return node;
}

function textOf(name: ts.Node | undefined) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return name.getText();
}

/** The name a function is bound to: its declaration, variable, property, or assignment. */
function nameOf(fn: Fn) {
  if (!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) return textOf(fn.name);
  return holderName(outer(fn).parent);
}

function holderName(holder: ts.Node) {
  if (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) {
    return textOf(holder.name);
  }
  if (ts.isPropertyDeclaration(holder)) return textOf(holder.name);

  if (ts.isBinaryExpression(holder) && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return holder.left.getText();
  }
  return ts.isExportAssignment(holder) ? "default" : undefined;
}

/** The object literal a named function is a member of, if any. */
function memberOf(fn: Fn) {
  const member = ts.isFunctionExpression(fn) || ts.isArrowFunction(fn) ? outer(fn).parent : fn;
  const isMember =
    ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member) || ts.isAccessor(member);
  return isMember && ts.isObjectLiteralExpression(member.parent) ? member.parent : undefined;
}

/** The identifier a call's callee starts from: `Bun` in `Bun.serve`, `f` in `f<T>()(...)`. */
function calleeRoot(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) {
    return calleeRoot(expression.expression);
  }
}

/** The call this node is a direct argument of. */
function argumentOf(node: ts.Node) {
  const call = outer(node).parent;
  if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return undefined;
  return call.arguments?.includes(outer(node) as ts.Expression) ? call : undefined;
}

/** The Core name a call's callee is imported as: `operation`, `capsule`, ... */
function coreCall(file: File, node: ts.Node) {
  const call = argumentOf(node);
  return call && ts.isIdentifier(call.expression) ? file.core.get(call.expression.text) : undefined;
}

/** A capsule's hooks: `capsule({ hooks: {...} })`, or an object typed or passed as hooks. */
function isHooks(file: File, object: ts.ObjectLiteralExpression) {
  const holder = outer(object).parent;
  if (ts.isPropertyAssignment(holder) && textOf(holder.name) === "hooks") {
    return coreCall(file, holder.parent) === "capsule";
  }
  if (!ts.isVariableDeclaration(holder) || !ts.isIdentifier(holder.name)) return false;
  return file.hooks.has(holder.name.text) || hooksType(file, holder.type);
}

function hooksType(file: File, type: ts.TypeNode | undefined) {
  if (!type || !ts.isTypeReferenceNode(type) || !ts.isQualifiedName(type.typeName)) return false;
  const { left, right } = type.typeName;
  return ts.isIdentifier(left) && file.core.get(left.text) === "Capsule" && right.text === "Hooks";
}

/** A direct option of a Core unit, or a hook of a capsule. */
function graphOption(file: File, fn: Fn) {
  const object = memberOf(fn);
  if (!object) return false;
  if (unitNames.has(coreCall(file, object) ?? "")) return true;
  return hookNames.has(nameOf(fn) ?? "") && isHooks(file, object);
}

/** Inside the options of a library call, at any depth. Core calls are graph options instead. */
function nativeOption(file: File, fn: Fn) {
  let node: ts.Node | undefined = memberOf(fn);
  while (node && ts.isObjectLiteralExpression(node)) {
    const holder = outer(node).parent;
    if (!ts.isPropertyAssignment(holder)) break;
    node = holder.parent;
  }

  const call = node && argumentOf(node);
  const name = call && calleeRoot(call.expression);
  return name === "Bun" || (!!name && file.library.has(name));
}

/** A use of a name as a value: not a callee, not a property's receiver or key. */
function valueUse(node: ts.Node, name: string) {
  if (!ts.isIdentifier(node) || node.text !== name) return false;
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return false;
  if (ts.isPropertyAccessExpression(parent)) return false;
  return !(ts.isPropertyAssignment(parent) && parent.name === node);
}

/** The values a function returns: each `return` of its own, or its expression body. */
function returnsOf(owner: Fn) {
  const found: ts.Node[] = [];
  if (owner.body && !ts.isBlock(owner.body)) found.push(owner.body);
  if (owner.body) {
    ownWalk(owner.body, (node) => {
      if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    });
  }
  return found;
}

function returnsName(owner: Fn, name: string) {
  let found = false;
  for (const value of returnsOf(owner)) {
    walk(value, (node) => {
      found ||= valueUse(node, name);
    });
  }
  return found;
}

/** The owner returns this object: directly, inside a returned object, or through a local name. */
function returned(owner: Fn, object: ts.Node) {
  let node = outer(object);
  while (ts.isPropertyAssignment(node.parent) && ts.isObjectLiteralExpression(node.parent.parent)) {
    node = outer(node.parent.parent);
  }
  if (returnsOf(owner).includes(node)) return true;

  const holder = node.parent;
  return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)
    ? returnsName(owner, holder.name.text)
    : false;
}

/** Handed to a call: an argument, a property of an argument, or a JSX attribute. */
function handed(node: ts.Node) {
  const parent = outer(node).parent;
  if (argumentOf(node) || ts.isJsxExpression(parent)) return true;
  if (!ts.isShorthandPropertyAssignment(parent) && !ts.isPropertyAssignment(parent)) return false;
  return ts.isObjectLiteralExpression(parent.parent) && !!argumentOf(parent.parent);
}

function handsName(owner: Fn, name: string) {
  let found = false;
  walk(owner.body!, (node) => {
    found ||= valueUse(node, name) && handed(node);
  });
  return found;
}

/** Named inside a passing function, which returns it or hands it to a call. */
function owned(file: File, fn: Fn, name: string) {
  const object = memberOf(fn);
  const owner = enclosingFn(object ?? fn);
  if (!owner || !passes(file, owner)) return false;
  if (object) return returned(owner, object);
  return returnsName(owner, name) || handsName(owner, name);
}

/** A top-level function handed to an event registration: `import.meta.hot.dispose(close)`. */
function listener(file: File, fn: Fn, name: string) {
  if (enclosingFn(fn) || memberOf(fn)) return false;
  let found = false;
  walk(file.source, (node) => {
    const call = valueUse(node, name) ? argumentOf(node) : undefined;
    if (call && ts.isPropertyAccessExpression(call.expression)) {
      found ||= listenNames.has(call.expression.name.text);
    }
  });
  return found;
}

function hasJsx(node: ts.Node) {
  let found = false;
  ownWalk(node, (child) => {
    found ||=
      ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child);
  });
  return found;
}

/** A React component: capitalized, at most one parameter (its props), and it returns JSX. */
function component(file: File, fn: Fn, name: string) {
  const own = ts.isFunctionExpression(fn) ? (textOf(fn.name) ?? name) : name;
  if (!file.path.endsWith(".tsx") || !/^[A-Z]/.test(own)) return false;
  return fn.parameters.length <= 1 && !!fn.body && hasJsx(fn.body);
}

/** Written where it is used: an argument, a JSX attribute, a returned value, an array item. */
function inline(fn: Fn) {
  const node = outer(fn);
  const parent = node.parent;
  if (argumentOf(fn) || ts.isJsxExpression(parent) || ts.isReturnStatement(parent)) return true;
  return (
    ts.isArrayLiteralExpression(parent) || (ts.isArrowFunction(parent) && parent.body === node)
  );
}

function exempt(file: File, name: string) {
  return exemptNames.has(name) || !!entries[file.path]?.includes(name);
}

function judge(file: File, fn: Fn) {
  const name = nameOf(fn);
  if (name === undefined) return inline(fn);
  if (exempt(file, name)) return true;

  return (
    component(file, fn, name) ||
    graphOption(file, fn) ||
    nativeOption(file, fn) ||
    owned(file, fn, name) ||
    listener(file, fn, name)
  );
}

function passes(file: File, fn: Fn): boolean {
  if (!verdicts.has(fn)) verdicts.set(fn, judge(file, fn));
  return verdicts.get(fn)!;
}

/** A bare package import is a library; `~/`, `@/` and relative paths are app code. */
function library(specifier: string) {
  return !/^(\.|~\/|@\/)/.test(specifier) && specifier !== "@tinker/core";
}

/** Each local name an import binds, with the name it has in its module. */
function importNames(clause: ts.ImportClause): [string, string][] {
  const names: [string, string][] = clause.name ? [[clause.name.text, "default"]] : [];
  const bindings = clause.namedBindings;
  if (!bindings) return names;
  if (ts.isNamespaceImport(bindings)) return [...names, [bindings.name.text, "*"]];

  for (const item of bindings.elements) {
    names.push([item.name.text, (item.propertyName ?? item.name).text]);
  }
  return names;
}

function readImport(file: File, node: ts.ImportDeclaration) {
  const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
  if (!node.importClause) return;

  for (const [local, imported] of importNames(node.importClause)) {
    if (specifier === "@tinker/core") file.core.set(local, imported);
    else if (library(specifier)) file.library.add(local);
  }
}

/** Hooks objects passed by name: `capsule({ hooks: queueSink })`. */
function readHooks(file: File, node: ts.Node) {
  if (!ts.isPropertyAssignment(node) || textOf(node.name) !== "hooks") return;
  if (ts.isIdentifier(node.initializer) && coreCall(file, node.parent) === "capsule") {
    file.hooks.add(node.initializer.text);
  }
}

function readFile(path: string, text: string): File {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const file: File = { path, source, core: new Map(), library: new Set(), hooks: new Set() };

  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) readImport(file, node);
  }
  walk(source, (node) => readHooks(file, node));
  return file;
}

function check(file: File) {
  const hits: string[] = [];
  walk(file.source, (node) => {
    if (!isFn(node) || !node.body || passes(file, node)) return;
    const line = file.source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    hits.push(`${file.path}:${line}: plain-function: make it an operation`);
  });
  return hits;
}

const paths = [...new Bun.Glob("{src,cmds,tinker}/**/*.{ts,tsx}").scanSync({ cwd: root })]
  .filter((path) => !path.endsWith(".d.ts"))
  .sort();

const hits: string[] = [];

for (const path of paths) {
  hits.push(...check(readFile(path, await Bun.file(join(root, path)).text())));
}

for (const hit of hits) console.error(hit);
if (hits.length) process.exit(1);
console.log(`plain functions: none in ${paths.length} files`);
