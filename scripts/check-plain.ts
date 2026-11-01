/**
 * The plain-function check (Duke 2026-10-31, tinker-app #44). App code has no plain helper
 * functions: every named function is an operation, so every call is a span and its dependencies
 * come through the graph. It reads `.ts`, `.tsx`, `.mts` and `.cts` files in src/, cmds/ and
 * tinker/ (the syntax tree only, no types) and prints one line per plain function.
 *
 * A function passes when it is one of these:
 * - inline: no name of its own, written where it is used: a JSX attribute, a returned value, or
 *   an argument of a call inside a function, a Core call, `defineMain`, a library call, or an
 *   event registration. An IIFE, `Object.freeze(() => 1)` at the top level, or a function in an
 *   array bound to a name is not inline;
 * - a graph body: a direct option of a Core `operation`, `resource`, `tag` or `data`, or a hook
 *   of a capsule (in `capsule({ hooks })`, or in an object typed `Capsule.Hooks`);
 * - a native option: inside the options of a library call (`Bun.serve`, `createRoute`, ...).
 *   A library may come through a module resource (a Core `resource` whose factory returns
 *   `import("<package>")`): `depends: { x: thatResource }`, then `x.f({...})`,
 *   `const { f } = x; f({...})` or `new x.C({...})`;
 * - owned: named inside a passing function that returns it or hands it to a call;
 * - a listener: a top-level function handed to an event registration (`addEventListener`, ...);
 * - a React component: a capitalized function in a .tsx file that returns JSX;
 * - exempt by name (`cn` anywhere, `defineMain` in tinker/base/main.ts), or an `entries` item.
 *
 * Usage: bun scripts/check-plain.ts [root]
 */
import { dirname, join, resolve } from "node:path";

import ts from "typescript-api";

/** The hooks Core 0.10.0's `capsule()` accepts (`Capsule.Hooks`). */
const hookNames = new Set(["start", "resolve", "run", "write", "close", "session"]);

/** Core calls whose direct options are graph bodies. */
const unitNames = new Set(["operation", "resource", "tag", "data"]);

/**
 * Exempt by name, each tied to the file that defines it. shadcn's `cn` (its registry imports it)
 * has no file yet, so it passes in any file; the type-only `defineMain` only in its own file.
 */
const exemptNames: Record<string, string | undefined> = {
  cn: undefined,
  defineMain: "tinker/base/main.ts",
};

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

/**
 * What one file knows: its path, its Core imports, its library imports, its app imports (by the
 * file they come from), the `defineMain` it imports, its hooks objects, and its top-level consts.
 */
type File = {
  path: string;
  source: ts.SourceFile;
  core: Map<string, string>;
  library: Set<string>;
  app: Map<string, { from: string; name: string }>;
  mains: Set<string>;
  hooks: Set<string>;
  consts: Map<string, ts.Expression>;
};

const root = resolve(Bun.argv[2] ?? join(import.meta.dir, ".."));
const verdicts = new Map<ts.Node, boolean>();

/** Every scanned file, by its path without the extension. */
const files = new Map<string, File>();

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

/**
 * The identifier a value is built from: `Bun` in `Bun.serve` or `new Bun.Glob("*").scanSync()`,
 * `f` in `f<T>()(...)`, the shared root of an array's spreads in `[...xs].map`.
 */
function calleeRoot(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isArrayLiteralExpression(expression)) return spreadRoot(expression);
  const next = builtOn(expression);
  return next && calleeRoot(next);
}

/** What an expression builds on: a receiver, a called or constructed value, a cast's value. */
function builtOn(expression: ts.Expression) {
  const steps =
    ts.isPropertyAccessExpression(expression) ||
    ts.isCallExpression(expression) ||
    ts.isNewExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression);
  return steps ? expression.expression : undefined;
}

/** `[...xs, ...ys]`: the root every spread shares, when each item is a spread. */
function spreadRoot(array: ts.ArrayLiteralExpression) {
  const roots = array.elements.map((item) =>
    ts.isSpreadElement(item) ? calleeRoot(item.expression) : undefined,
  );
  const first = roots[0];
  return first && roots.every((root) => root === first) ? first : undefined;
}

/** The file an app import names, by its path without the extension. */
function appFile(file: File, specifier: string) {
  const path = specifier.startsWith("~/")
    ? `tinker/${specifier.slice(2)}`
    : specifier.startsWith("@/")
      ? `src/${specifier.slice(2)}`
      : join(dirname(file.path), specifier);
  return stem(path);
}

function stem(path: string) {
  return path.replace(/\.[mc]?tsx?$/, "");
}

/**
 * Platform classes whose options the platform calls. Only the direct callee counts:
 * `new ReadableStream({...})` is a library call, but a const built on one is not a library
 * value (a Proxy returns its app target). Only the ones the app uses; add one with its reason.
 */
const platformNames = new Set([
  // A stream source: the stream calls `start`, `pull` and `cancel`.
  "ReadableStream",
  // A proxy handler: the proxy calls its traps (`get`, `set`, ...).
  "Proxy",
]);

/** `new X({...})` with X on the platform list, as the direct callee. */
function platformCall(call: ts.CallExpression | ts.NewExpression) {
  return (
    ts.isNewExpression(call) &&
    ts.isIdentifier(call.expression) &&
    platformNames.has(call.expression.text)
  );
}

/**
 * A name whose value comes from a library: imported from a package, the `Bun` global, or a
 * top-level const built on one, here or in the app file it is imported from (no barrels).
 */
function libraryValue(file: File, name: string, depth = 0): boolean {
  if (name === "Bun" || file.library.has(name)) return true;
  if (depth > 8) return false;

  const value = file.consts.get(name);
  const root = value && calleeRoot(value);
  return root ? libraryValue(file, root, depth + 1) : importedValue(file, name, depth);
}

function importedValue(file: File, name: string, depth: number) {
  const from = file.app.get(name);
  const target = from && (files.get(from.from) ?? files.get(`${from.from}/index`));
  return !!target && libraryValue(target, from.name, depth + 1);
}

/**
 * A library value where `at` stands: a library value of the file, or a local of a function
 * around it that comes from a module resource, as `x` in `depends: { x: betterAuthModule }`,
 * `betterAuth` in `const { betterAuth } = x`, or `db` in `const db = new x.Kysely({...})`.
 */
function libraryAt(file: File, name: string, at: ts.Node, depth = 0): boolean {
  if (libraryValue(file, name)) return true;
  if (depth > 8) return false;

  for (let fn = enclosingFn(at); fn; fn = enclosingFn(fn)) {
    const bound = bindingIn(file, fn, name);
    if (bound === undefined) continue;
    if (typeof bound === "boolean") return bound;
    const root = calleeRoot(bound.value);
    return !!root && libraryAt(file, root, bound.at, depth + 1);
  }
  return false;
}

/**
 * How a function binds a name: a module-resource dependency (true), another parameter (false),
 * a local built on a value (that value), or not at all (undefined).
 */
function bindingIn(file: File, fn: Fn, name: string) {
  for (const [index, parameter] of fn.parameters.entries()) {
    const item = bindsName(parameter.name, name);
    if (!item) continue;
    return index === 0 && ts.isBindingElement(item) && moduleDependency(file, fn, item);
  }

  const found: ts.VariableDeclaration[] = [];
  if (fn.body) {
    ownWalk(fn.body, (node) => {
      if (ts.isVariableDeclaration(node) && bindsName(node.name, name)) found.push(node);
    });
  }
  const [local] = found;
  return local && (local.initializer ? { value: local.initializer, at: local } : false);
}

/** The binding of a name in `name` or in `{ name }`, if it binds it. */
function bindsName(binding: ts.BindingName, name: string) {
  if (ts.isIdentifier(binding)) return binding.text === name ? binding : undefined;
  if (!ts.isObjectBindingPattern(binding)) return undefined;
  return binding.elements.find((item) => ts.isIdentifier(item.name) && item.name.text === name);
}

/** A dependency of a Core unit's option, taken from its first parameter: a module resource. */
function moduleDependency(file: File, fn: Fn, item: ts.BindingElement) {
  const object = memberOf(fn);
  if (!object || !unitNames.has(coreCall(file, object) ?? "")) return false;

  const key = textOf(item.propertyName ?? item.name);
  const value = property(property(object, "depends"), key);
  return !!value && ts.isIdentifier(value) && moduleResource(file, value.text);
}

/** The value of a property of an object literal: `{ name: value }` or `{ name }`. */
function property(object: ts.Node | undefined, name: string | undefined) {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  for (const item of object.properties) {
    if (textOf(item.name) !== name) continue;
    if (ts.isPropertyAssignment(item)) return item.initializer;
    if (ts.isShorthandPropertyAssignment(item)) return item.name;
    if (ts.isMethodDeclaration(item)) return item;
  }
}

/**
 * A Core `resource` whose factory returns `import("<package>")`, here or in the app file it is
 * imported from. An app path (`~/x`, `./x`) is app code, not a library.
 */
function moduleResource(file: File, name: string, depth = 0): boolean {
  if (depth > 8) return false;
  const value = file.consts.get(name);
  if (value) return libraryResource(file, value);

  const from = file.app.get(name);
  const target = from && (files.get(from.from) ?? files.get(`${from.from}/index`));
  return !!target && moduleResource(target, from.name, depth + 1);
}

/** A `resource({ factory })` call whose factory returns `import("<package>")` on every return. */
function libraryResource(file: File, value: ts.Node) {
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) return false;
  if (file.core.get(value.expression.text) !== "resource") return false;

  // Every return must load a package: one branch of app code makes the whole value app code.
  const factory = property(value.arguments[0], "factory");
  const returns = factory && isFn(factory) ? returnsOf(factory) : [];
  return returns.length > 0 && returns.every(importsLibrary);
}

/** `import("<package>")` of a bare package specifier. */
function importsLibrary(node: ts.Node) {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
    return false;
  }
  const [specifier] = node.arguments;
  return !!specifier && ts.isStringLiteral(specifier) && library(specifier.text);
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
  if (!call) return false;
  const name = calleeRoot(call.expression);
  return platformCall(call) || (!!name && libraryAt(file, name, call));
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

/**
 * Written where it is used: a JSX attribute, a returned value, or an argument of a call that
 * takes callbacks. An array item stands where its array stands, so `const [f] = [() => 1]` is
 * named, as is `const f = Object.freeze(() => 1)`.
 */
function inline(file: File, node: ts.Node): boolean {
  node = outer(node);
  const parent = node.parent;
  if (ts.isArrayLiteralExpression(parent)) return inline(file, parent);
  if (ts.isJsxExpression(parent) || ts.isReturnStatement(parent)) return true;
  if (ts.isArrowFunction(parent) && parent.body === node) return true;

  const call = argumentOf(node);
  return !!call && callbackCall(file, call);
}

/**
 * A call that may take an unnamed function: one inside a function (that function is judged
 * itself), a Core call, `defineMain`, a library call, or an event registration.
 */
function callbackCall(file: File, call: ts.CallExpression | ts.NewExpression) {
  if (enclosingFn(call) || platformCall(call)) return true;
  const name = calleeRoot(call.expression);
  if (name && (file.core.has(name) || file.mains.has(name) || libraryValue(file, name))) {
    return true;
  }
  return (
    ts.isPropertyAccessExpression(call.expression) && listenNames.has(call.expression.name.text)
  );
}

function exempt(file: File, name: string) {
  const home = name in exemptNames ? exemptNames[name] : null;
  return home === undefined || home === file.path || !!entries[file.path]?.includes(name);
}

function judge(file: File, fn: Fn) {
  const name = nameOf(fn);
  if (name === undefined) return inline(file, fn);
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

  for (const [local, name] of importNames(node.importClause)) {
    if (specifier === "@tinker/core") file.core.set(local, name);
    else if (library(specifier)) file.library.add(local);
    else readAppImport(file, local, { from: appFile(file, specifier), name });
  }
}

/** An app import; the `defineMain` of tinker/base/main.ts may take the command's main. */
function readAppImport(file: File, local: string, from: { from: string; name: string }) {
  file.app.set(local, from);
  if (from.name === "defineMain" && from.from === "tinker/base/main") file.mains.add(local);
}

/** Top-level consts and what they hold: `const batch = z.object({...})`. */
function readConsts(file: File, node: ts.Statement) {
  if (!ts.isVariableStatement(node)) return;
  for (const item of node.declarationList.declarations) {
    if (ts.isIdentifier(item.name) && item.initializer) {
      file.consts.set(item.name.text, item.initializer);
    }
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
  const file: File = {
    path,
    source,
    core: new Map(),
    library: new Set(),
    app: new Map(),
    mains: new Set(),
    hooks: new Set(),
    consts: new Map(),
  };

  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) readImport(file, node);
    readConsts(file, node);
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

const paths = [...new Bun.Glob("{src,cmds,tinker}/**/*.{ts,tsx,mts,cts}").scanSync({ cwd: root })]
  .filter((path) => !/\.d\.[mc]?ts$/.test(path))
  .sort();

for (const path of paths) {
  files.set(stem(path), readFile(path, await Bun.file(join(root, path)).text()));
}

const hits = [...files.values()].flatMap(check);

for (const hit of hits) console.error(hit);
if (hits.length) process.exit(1);
console.log(`plain functions: none in ${paths.length} files`);
