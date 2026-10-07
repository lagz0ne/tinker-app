import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import ts from "typescript-api";
import { createRequire } from "node:module";

const PLAIN_MAX = 17;
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? app);
// TypeScript resolves types from the working folder; run from the project root.
process.chdir(root);
const base = dirname(
  createRequire(join(root, "package.json")).resolve("@tinker/start/package.json"),
);
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
function pathOf(node) {
  return relative(root, node.getSourceFile().fileName);
}
function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node))
  )
    node = node.expression;
  return node;
}
function locationSymbol(node) {
  const symbol =
    node.parent && ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
  return aliasTarget(symbol);
}
function aliasTarget(symbol) {
  return symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}
function identifierInitializer(decl) {
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  return ts.isIdentifier(unwrap(decl.initializer)) ? decl.initializer : undefined;
}
function bindingTypeSymbol(decl, node, symbol) {
  return decl && ts.isBindingElement(decl)
    ? (checker.getTypeAtLocation(node).symbol ?? symbol)
    : undefined;
}
function symbolOf(node, seen = new Set()) {
  node = unwrap(node);
  if (!node) return undefined;
  const symbol = locationSymbol(node);
  if (seen.has(symbol)) return symbol;
  seen.add(symbol);
  const decl = symbol?.valueDeclaration;
  const bound = bindingTypeSymbol(decl, node, symbol);
  if (bound) return bound;
  const initializer = identifierInitializer(decl);
  return initializer ? symbolOf(initializer, seen) : symbol;
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
function coreCall(node) {
  return (
    ts.isCallExpression(node) &&
    ["resource", "extension", "operation", "data", "tag"].some((name) =>
      coreSymbol(node.expression, name),
    )
  );
}
function at(node) {
  const file = node.getSourceFile();
  return `${pathOf(node)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}
function fail(node, rule) {
  failures.push(`${at(node)}: ${rule}`);
}
function functionName(node) {
  return (
    node.name ??
    (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)
      ? node.parent.name
      : undefined)
  );
}
function isFunction(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}
function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (isFunction(parent)) return parent;
}

function isComponent(node) {
  if (
    !node.getSourceFile().fileName.endsWith(".tsx") ||
    !/^[A-Z]/.test(nameOf(functionName(node))) ||
    node.parameters.length > 1
  )
    return false;
  let jsx = false;
  ownWalk(node.body, (child) => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child))
      jsx = true;
  });
  return jsx;
}
function ownWalk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => {
    if (!isFunction(child)) ownWalk(child, visit);
  });
}
function directOptions(object) {
  return coreCall(object.parent) && object.parent.arguments.includes(object);
}
function hookOptions(object) {
  const property = object.parent;
  return (
    ts.isPropertyAssignment(property) &&
    nameOf(property.name) === "hooks" &&
    ts.isObjectLiteralExpression(property.parent) &&
    directOptions(property.parent)
  );
}
function optionsMember(node) {
  const member = ts.isPropertyAssignment(node.parent) ? node.parent : node;
  if (!member.name || !ts.isObjectLiteralExpression(member.parent)) return false;
  if (directOptions(member.parent))
    return ["run", "factory", "input"].includes(nameOf(member.name));
  return hookOptions(member.parent);
}

function factoryBody(node) {
  if (!optionsMember(node) || nameOf(functionName(node)) !== "factory") return false;
  const member = ts.isPropertyAssignment(node.parent) ? node.parent : node;
  return coreSymbol(member.parent.parent.expression, "resource");
}

function directReturn(expression, owner) {
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return ts.isReturnStatement(expression.parent) && enclosingFunction(expression.parent) === owner;
}
function assignedReturn(object, owner) {
  const call = object.parent;
  return (
    ts.isCallExpression(call) &&
    nameOf(call.expression) === "Object.assign" &&
    directReturn(call, owner)
  );
}
function localReturn(object, owner) {
  if (!ts.isVariableDeclaration(object.parent)) return false;
  const symbol = symbolOf(object.parent.name);
  let found = false;
  ownWalk(owner.body, (use) => {
    if (ts.isReturnStatement(use) && use.expression && symbolOf(use.expression) === symbol)
      found = true;
  });
  return found;
}
function returnedObject(object, owner) {
  return (
    unwrap(owner.body) === object ||
    directReturn(object, owner) ||
    assignedReturn(object, owner) ||
    localReturn(object, owner)
  );
}

function valueOwner(owner) {
  if (!owner) return false;
  return (
    factoryBody(owner) || (optionsMember(owner) && nameOf(owner.parent.parent?.name) === "hooks")
  );
}
function ownedMethod(node) {
  const member = ts.isPropertyAssignment(node.parent) ? node.parent : node;
  if (!ts.isObjectLiteralExpression(member.parent)) return false;
  const owner = enclosingFunction(member.parent);
  return valueOwner(owner) && returnedObject(member.parent, owner);
}

function initializerOf(node) {
  return symbolOf(node)?.valueDeclaration?.initializer;
}
function propertyOf(object, name) {
  return object?.properties?.find((prop) => nameOf(prop.name) === name);
}
function parameterBinding(receiver) {
  if (!ts.isIdentifier(receiver)) return undefined;
  const binding = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
  return binding && ts.isBindingElement(binding) && ts.isParameter(binding.parent.parent)
    ? binding
    : undefined;
}
function dependencyInitializer(options, binding) {
  const depends = propertyOf(options, "depends")?.initializer;
  const dependency = propertyOf(depends, nameOf(binding.propertyName ?? binding.name));
  return initializerOf(dependency?.initializer ?? dependency?.name);
}
function dependencyUnit(receiver) {
  const binding = parameterBinding(receiver);
  if (!binding) return undefined;
  const factory = binding.parent.parent.parent;
  if (!optionsMember(factory) || !ts.isPropertyAssignment(factory.parent)) return undefined;
  return dependencyInitializer(factory.parent.parent, binding);
}
function resolvedUnit(receiver) {
  if (ts.isIdentifier(receiver)) receiver = initializerOf(receiver) ?? receiver;
  if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression))
    return undefined;
  return receiver.expression.name.text === "resolve"
    ? initializerOf(receiver.arguments[0])
    : undefined;
}
function resolvedMethod(call) {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const receiver = call.expression.expression;
  const unit = dependencyUnit(receiver) ?? resolvedUnit(receiver);
  if (!unit || !coreSymbol(unit.expression, "resource")) return undefined;
  let method;
  walk(unit, (child) => {
    if (
      isFunction(child) &&
      nameOf(functionName(child)) === call.expression.name.text &&
      ownedMethod(child)
    )
      method = child;
  });
  return method;
}

function externalCall(node) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
  if (
    /^(?:Object\.(?:freeze|assign)$|Reflect\.|String$|Number$|Boolean$)/.test(
      nameOf(node.expression),
    )
  )
    return false;
  const declarations = resolvedMethod(node) ?? checker.getResolvedSignature(node)?.declaration;
  return (
    declarations &&
    (!files.includes(declarations.getSourceFile().fileName) || ownedMethod(declarations))
  );
}
function tagArgument(call) {
  return symbolOf(call.expression)?.declarations?.some(
    (decl) =>
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      coreSymbol(decl.initializer.expression, "tag"),
  );
}
function callbackType(signature, param, index, arg) {
  const instantiated = signature?.parameters[Math.min(index, signature.parameters.length - 1)];
  const type = instantiated
    ? checker.getTypeOfSymbolAtLocation(instantiated, arg)
    : checker.getTypeAtLocation(param);
  return type.flags & ts.TypeFlags.TypeParameter ? checker.getBaseConstraintOfType(type) : type;
}
function callbackSlot(call, index) {
  const signature = checker.getResolvedSignature(call);
  const declaration = signature?.declaration ?? resolvedMethod(call);
  const param = declaration?.parameters[Math.min(index, declaration.parameters.length - 1)];
  return { signature, param };
}
function callbackIndex(call, arg) {
  return call.arguments?.indexOf(arg) ?? -1;
}
function callbackArgument(call, arg) {
  if (tagArgument(call)) return true;
  const index = callbackIndex(call, arg);
  const { signature, param } = callbackSlot(call, index);
  if (!param || index < 0) return false;
  if (nameOf(call.expression).endsWith(".validator")) return true;
  const type = callbackType(signature, param, index, arg);
  return type && !(type.flags & ts.TypeFlags.Any) && callable(type);
}

function callbackUse(use) {
  const call = use.parent;
  if (
    !ts.isCallExpression(call) ||
    !/\.(?:addEventListener|removeEventListener|on|once|defer|dispose|listen|hold)$/.test(
      nameOf(call.expression),
    )
  )
    return false;
  return (
    ts.isCallExpression(call) &&
    call.arguments.includes(use) &&
    externalCall(call) &&
    callbackArgument(call, use)
  );
}
const nativeCache = new Map();
function nativeCallback(node) {
  if (!nativeCache.has(node)) nativeCache.set(node, classifyNativeCallback(node));
  return nativeCache.get(node);
}
function argumentOf(node, call) {
  return (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.arguments?.includes(node);
}
function externalDeclaration(call) {
  return !files.includes(
    checker.getResolvedSignature(call)?.declaration?.getSourceFile().fileName ??
      resolvedMethod(call)?.getSourceFile().fileName,
  );
}
function nativeArgument(node) {
  const call = node.parent;
  return (
    argumentOf(node, call) &&
    externalCall(call) &&
    externalDeclaration(call) &&
    callbackArgument(call, node)
  );
}
function nativeOption(node) {
  const member = ts.isPropertyAssignment(node.parent) ? node.parent : node;
  if (!ts.isObjectLiteralExpression(member.parent)) return false;
  let object = member.parent;
  while (
    ts.isPropertyAssignment(object.parent) &&
    ts.isObjectLiteralExpression(object.parent.parent)
  )
    object = object.parent.parent;
  const call = object.parent;
  return argumentOf(object, call) && externalCall(call) && externalDeclaration(call);
}
function namedNativeCallback(node) {
  const name = functionName(node);
  if (!name) return false;
  const symbol = symbolOf(name);
  let callback = false;
  for (const source of sources)
    walk(source, (use) => {
      if (ts.isIdentifier(use) && use !== name && symbolOf(use) === symbol && callbackUse(use))
        callback = true;
    });
  return callback;
}
function classifyNativeCallback(node) {
  if (ts.isFunctionDeclaration(node)) return false;
  if (ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent)) return true;
  return nativeArgument(node) || nativeOption(node) || namedNativeCallback(node);
}

function graphOwner(node) {
  for (let parent = enclosingFunction(node); parent; parent = enclosingFunction(parent))
    if (optionsMember(parent) || factoryBody(parent)) return true;
  return false;
}
function callable(type) {
  return (
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0 ||
    (type.isUnionOrIntersection() && type.types.some(callable))
  );
}
function unitType(type) {
  if (
    checker
      .getPropertiesOfType(type)
      .some((prop) => /^__@(?:resource|operation|data|tag|extension)Sym@/.test(prop.name))
  )
    return true;
  return ["Resource", "Operation", "Data", "Tag", "Extension"].includes(
    type.aliasSymbol?.name ?? type.symbol?.name,
  );
}
function typeNameOf(type, text) {
  return type.aliasSymbol?.name ?? type.symbol?.name ?? text;
}
function forbiddenTypeName(type, mode) {
  const text = checker.typeToString(type).split("<")[0];
  const typeName = typeNameOf(type, text);
  const patterns = {
    scope: /\b(?:RootHandle|SessionHandle|Scope\.Handle)\b/,
    holder:
      /\b(?:RootHandle|SessionHandle|DataController|OperationController|Clock|Ctx|AbortController|Pool|Client|Socket|Server|Connection|EventSource|WebSocket|Worker|BroadcastChannel|ReadableStream|WritableStream)\b/,
    plain:
      /\b(?:RootHandle|SessionHandle|DataController|OperationController|Clock|Ctx|AbortSignal|AbortController|Controller|Context|Scope|ProcessEnv|IncomingMessage|ServerResponse|Socket|Server|Client|Pool|ReadStream|WriteStream|ReadableStream|WritableStream|Response|Request|Headers)\b/,
  };
  const pattern = patterns[mode] ?? patterns.plain;
  return (
    pattern.test(typeName) || (pattern.test(text) && !text.startsWith("{") && !text.includes("=>"))
  );
}
function coreHandleType(type) {
  const symbol = type.aliasSymbol ?? type.symbol;
  return (
    /Handle|Controller|Ctx/.test(symbol?.name ?? "") &&
    symbol.declarations?.some((decl) =>
      /(?:@tinker\/core|packages\/core)\//.test(decl.getSourceFile().fileName),
    )
  );
}
function primitiveType(type) {
  return (
    type.flags &
    (ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.Any |
      ts.TypeFlags.Unknown)
  );
}
function propertyContains(prop, mode, seen, depth) {
  const decl = prop.valueDeclaration ?? prop.declarations?.at(0);
  if (!decl) return false;
  if (mode === "react" && /^(?:ctx|context|clock|signal|scope|controller)$/.test(prop.name))
    return true;
  if (!files.includes(decl.getSourceFile().fileName) && prop.name !== "signal") return false;
  return contains(checker.getTypeOfSymbolAtLocation(prop, decl), mode, seen, depth + 1);
}
function awaitedContains(type, mode, seen, depth) {
  const awaited = checker.getAwaitedType(type);
  return awaited && awaited !== type && contains(awaited, mode, seen, depth + 1);
}
function nestedTypeContains(type, mode, seen, depth) {
  if (type.isUnionOrIntersection())
    return type.types.some((part) => contains(part, mode, seen, depth + 1));
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const bound = checker.getBaseConstraintOfType(type);
    return bound ? contains(bound, mode, seen, depth + 1) : mode === "plain";
  }
  if (callable(type)) return mode === "plain";
  if (primitiveType(type)) return false;
  if (awaitedContains(type, mode, seen, depth)) return true;
  return checker
    .getPropertiesOfType(type)
    .some((prop) => propertyContains(prop, mode, seen, depth));
}
function skipType(type, seen, depth) {
  return !type || seen.has(type) || depth > 12;
}
function contains(type, mode, seen = new Set(), depth = 0) {
  if (skipType(type, seen, depth)) return false;
  seen.add(type);
  if (unitType(type)) return ["plain", "react"].includes(mode);
  if (forbiddenTypeName(type, mode) || coreHandleType(type)) return true;
  return nestedTypeContains(type, mode, seen, depth);
}

function exportedFunction(node) {
  if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    return true;
  const module = checker.getSymbolAtLocation(node.getSourceFile());
  if (!module) return false;
  let name = functionName(node);
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) name = parent.name;
    if (ts.isExportAssignment(parent)) return true;
  }
  if (!name) return false;
  const symbol = symbolOf(name);
  return checker
    .getExportsOfModule(module)
    .some(
      (entry) =>
        (entry.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(entry) : entry) === symbol,
    );
}
function moduleBinding(node) {
  return ts.isVariableDeclaration(node) && node.parent.parent.parent === node.getSourceFile();
}
function checkScopeReference(node) {
  if (
    ![ts.isIdentifier, ts.isStringLiteral].some((kind) => kind(node)) ||
    !coreSymbol(node, "createScope")
  )
    return;
  if (ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent)) return;
  fail(node, "scope-entry-only");
}
function checkRoots(node) {
  checkScopeReference(node);
  if (!moduleBinding(node) || !contains(checker.getTypeAtLocation(node.name), "holder")) return;
  fail(node, "module-handle");
}

function declarationName(node) {
  return ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : symbolOf(node.expression)?.name;
}
function zodDeclaration(node, file) {
  return (
    /\/zod\//.test(file) &&
    [
      "string",
      "number",
      "boolean",
      "unknown",
      "email",
      "url",
      "uuid",
      "object",
      "strictObject",
      "literal",
      "enum",
      "array",
      "record",
      "union",
      "discriminatedUnion",
      "instanceof",
      "extend",
      "min",
      "max",
      "int",
      "positive",
      "nonnegative",
      "regex",
      "trim",
      "toUpperCase",
      "brand",
      "optional",
      "nullable",
      "strict",
      "loose",
      "default",
      "or",
      "refine",
    ].includes(declarationName(node))
  );
}
function schemaDeclaration(node, file) {
  return (
    /\/drizzle-orm\//.test(file) &&
    [
      "pgTable",
      "text",
      "timestamp",
      "boolean",
      "integer",
      "jsonb",
      "index",
      "primaryKey",
      "notNull",
      "unique",
      "default",
      "defaultNow",
      "generatedAlwaysAsIdentity",
      "$type",
      "references",
      "on",
    ].includes(symbolOf(node.expression)?.name)
  );
}
function frameworkDeclaration(node, file) {
  return (
    [
      "createIsomorphicFn",
      "createServerFn",
      "createFileRoute",
      "createMiddleware",
      "createStartHandler",
      "cva",
      "createRootRouteWithContext",
      "createStart",
    ].includes(symbolOf(node.expression)?.name) && /node_modules|packages\/core/.test(file)
  );
}
function clientDeclaration(node) {
  return (
    pathOf(node) === "src/client.tsx" &&
    ["startTransition", "hydrateRoot"].includes(symbolOf(node.expression)?.name)
  );
}
function unitMetadataCall(node) {
  return (
    ts.isCallExpression(node) &&
    nameOf(node.expression) === "Object.assign" &&
    node.arguments.every((arg) => ts.isObjectLiteralExpression(arg) || coreCall(arg))
  );
}
function routeDeclaration(node) {
  return (
    ts.isCallExpression(node.expression) &&
    ["createFileRoute", "createRootRouteWithContext"].includes(
      symbolOf(node.expression.expression)?.name,
    ) &&
    moduleDeclarationCall(node.expression)
  );
}
function chainedDeclaration(node) {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const chain = node.expression.expression;
  return (
    ["server", "client", "middleware", "handler", "validator"].includes(
      node.expression.name.text,
    ) &&
    ts.isCallExpression(chain) &&
    moduleDeclarationCall(chain)
  );
}
function declarationFile(node) {
  return checker.getResolvedSignature(node)?.declaration?.getSourceFile().fileName ?? "";
}
function moduleDeclarationCall(node) {
  if (coreCall(node) || clientDeclaration(node)) return true;
  const file = declarationFile(node);
  return (
    zodDeclaration(node, file) ||
    schemaDeclaration(node, file) ||
    frameworkDeclaration(node, file) ||
    unitMetadataCall(node) ||
    routeDeclaration(node) ||
    chainedDeclaration(node)
  );
}

function serviceAllocation(node) {
  return (
    (ts.isNewExpression(node) &&
      /(?:^|\.)(?:Map|Set|AbortController|EventSource|WebSocket|Worker|Pool|Client|Server|ReadableStream|WritableStream|BroadcastChannel)$/.test(
        nameOf(node.expression),
      )) ||
    (ts.isCallExpression(node) &&
      /(?:^|\.)(?:createServer|connect|watch|setTimeout|setInterval|requestAnimationFrame|addEventListener|createTransport|createAuthClient|pino|betterAuth)$/.test(
        nameOf(node.expression),
      ))
  );
}
const builtinFetch = checker.resolveName("fetch", undefined, ts.SymbolFlags.Value, false);
assert.ok(builtinFetch, "the project must declare built-in fetch");
const fetchDeclarations = new Set(builtinFetch.declarations);
const builtinXhr = checker.resolveName("XMLHttpRequest", undefined, ts.SymbolFlags.Value, false);
assert.ok(builtinXhr, "the project must declare built-in XMLHttpRequest");
const navigatorType = checker.resolveName("Navigator", undefined, ts.SymbolFlags.Type, false);
assert.ok(navigatorType, "the project must declare Navigator");
const builtinBeacon = checker.getDeclaredTypeOfSymbol(navigatorType).getProperty("sendBeacon");
assert.ok(builtinBeacon, "Navigator must declare sendBeacon");
const browserHttpDeclarations = new Set([
  ...builtinXhr.declarations,
  ...builtinBeacon.declarations,
]);
function typeReference(node) {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isTypeNode(parent) || typeOnlyImport(parent)) return true;
  return false;
}
function referenceSymbol(node) {
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent))
    return checker
      .getTypeAtLocation(node.parent)
      .getProperty(nameOf(node.propertyName ?? node.name));
  if (ts.isElementAccessExpression(node)) {
    const key = checker.getTypeAtLocation(node.argumentExpression);
    if (key.isStringLiteral())
      return checker.getTypeAtLocation(node.expression).getProperty(key.value);
  }
  return locationSymbol(node);
}
function nativeReference(node, declarations) {
  if (
    !ts.isIdentifier(node) &&
    !ts.isBindingElement(node) &&
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  )
    return false;
  return referenceSymbol(node)?.declarations?.some((decl) => declarations.has(decl));
}
function checkFetch(node) {
  if (typeReference(node) || !nativeReference(node, fetchDeclarations)) return;
  fail(node, "http-request: use httpRequest.controller instead of built-in fetch");
}
function checkBrowserHttp(node) {
  if (typeReference(node)) return;
  if (nativeReference(node, browserHttpDeclarations))
    fail(node, "http-client: app HTTP must use httpRequest.controller");
}
function checkHttpResource(node) {
  if (typeReference(node)) return;
  if (protocolUnitReference(node, "src/backend/http.ts", "http"))
    fail(node, "http-resource: app code must depend on httpRequest.controller");
}
function checkHttpBackend(node) {
  if (protocolUnitReference(node, "src/backend/http-backend.ts", "httpBackend"))
    fail(node, "http-backend: app code must depend on httpRequest.controller");
}
function protocolUnitReference(node, file, name) {
  if (
    !ts.isIdentifier(node) &&
    !ts.isBindingElement(node) &&
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  )
    return false;
  const symbol = referenceSymbol(node);
  const target = aliasTarget(symbol);
  return target?.declarations?.some(
    (decl) =>
      ts.isVariableDeclaration(decl) &&
      resolve(decl.getSourceFile().fileName) === join(base, file) &&
      nameOf(decl.name) === name,
  );
}
function checkRequestHeaders(node) {
  const file = pathOf(node);
  if (file === "src/backend/auth.ts") return;
  if (protocolUnitReference(node, "src/backend/headers.server.ts", "requestHeaders"))
    fail(node, "protocol-headers: app code must use principal or currentUser");
}
const builtinResponse = checker.resolveName("Response", undefined, ts.SymbolFlags.Value, false);
assert.ok(builtinResponse, "the project must declare built-in Response");
const responseDeclarations = new Set(builtinResponse.declarations);
function checkResponse(node) {
  const file = pathOf(node);
  if (file.startsWith("src/routes/")) return;
  if (nativeReference(node, responseDeclarations))
    fail(node, "protocol-response: replies belong to routes or the base");
}
function checkMountedAuth(node) {
  if (protocolUnitReference(node, "src/parts/auth/handle.server.ts", "handleAuth"))
    fail(node, "protocol-auth: only the auth route may use the mounted handler");
}
const httpClients = [
  "node:http",
  "node:https",
  "node:http2",
  "http",
  "https",
  "http2",
  "ws",
  "ofetch",
  "undici",
  "axios",
  "ky",
  "node-fetch",
  "got",
  "superagent",
  "node:net",
  "node:tls",
  "net",
  "tls",
  "dgram",
  "node:dgram",
];
function requireReference(node) {
  const symbol = symbolOf(node);
  return (
    symbol?.name === "require" &&
    symbol.declarations?.some((decl) =>
      decl.getSourceFile().fileName.endsWith("@types/node/module.d.ts"),
    )
  );
}
function importSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node))
    return ts.isExternalModuleReference(node.moduleReference)
      ? node.moduleReference.expression
      : undefined;
  if (
    ts.isCallExpression(node) &&
    (["import", "require"].includes(nameOf(node.expression)) || requireReference(node.expression))
  )
    return node.arguments[0];
}
function typeOnlyExport(node) {
  if (node.isTypeOnly) return true;
  return (
    node.exportClause &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((binding) => binding.isTypeOnly)
  );
}
function typeOnlyImport(node) {
  if (ts.isExportDeclaration(node)) return typeOnlyExport(node);
  if (!ts.isImportDeclaration(node)) return false;
  return typeOnlyClause(node.importClause);
}
function typeOnlyClause(clause) {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (clause.name || !bindings || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((binding) => binding.isTypeOnly);
}
function createRequireReference(node) {
  const symbol = referenceSymbol(node);
  return (
    symbol?.name === "createRequire" &&
    symbol.declarations?.some((decl) =>
      decl.getSourceFile().fileName.endsWith("@types/node/module.d.ts"),
    )
  );
}
function checkHttpImport(node) {
  if (typeOnlyImport(node) || typeReference(node)) return;
  const specifier = importSpecifier(node);
  if (createRequireReference(node))
    fail(node, "http-client: createRequire is not allowed in app code");
  if (!specifier) return;
  if (!ts.isStringLiteralLike(specifier)) {
    fail(node, "http-client: module loads must use a literal path");
    return;
  }
  if (
    httpClients.some(
      (client) => specifier.text === client || specifier.text.startsWith(`${client}/`),
    )
  )
    fail(node, "http-client: app HTTP must use httpRequest.controller");
}
function checkService(node) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
  if (!enclosingFunction(node)) {
    if (!moduleDeclarationCall(node)) fail(node, "module-effect");
    return;
  }
  if (!serviceAllocation(node) || graphOwner(node)) return;
  fail(node, "service-owner");
}
function callerOf(use) {
  let caller = enclosingFunction(use);
  while (caller && !functionName(caller)) {
    const call = caller.parent;
    if (
      !(ts.isNewExpression(call) && nameOf(call.expression) === "Promise") &&
      !(
        ts.isCallExpression(call) &&
        /\.(?:map|filter|flatMap|reduce|then|catch|finally)$/.test(nameOf(call.expression))
      )
    )
      break;
    caller = enclosingFunction(caller);
  }
  return caller;
}
function anonymousCallerName(caller) {
  const owner = enclosingFunction(caller);
  const siblings = [];
  walk(owner?.body ?? caller.getSourceFile(), (child) => {
    if (isFunction(child) && enclosingFunction(child) === owner) siblings.push(child);
  });
  return `${owner ? callerName(owner) : "module"}.callback${siblings.indexOf(caller) + 1}`;
}
function callerName(caller) {
  const member = nameOf(functionName(caller)) || nameOf(caller.name);
  for (let parent = caller.parent; parent && !isFunction(parent); parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return `${nameOf(parent.name)}.${member || "callback"}`;
  }
  return member || anonymousCallerName(caller);
}
function calledExpression(use) {
  return ts.isPropertyAccessExpression(use.parent) && use.parent.name === use ? use.parent : use;
}
function registeredCaller(expression) {
  const property = expression.parent;
  return (
    ts.isPropertyAssignment(property) &&
    property.initializer === expression &&
    optionsMember(property)
  );
}
function calledUse(expression) {
  const call = expression.parent;
  return (
    ts.isCallExpression(call) &&
    (call.expression === expression ||
      (call.arguments.includes(expression) && callbackArgument(call, expression)))
  );
}
function symbolUse(use, name, symbol) {
  return ts.isIdentifier(use) && use !== name && symbolOf(use) === symbol;
}
function callerLabel(use, caller) {
  return `${pathOf(use)}#${caller ? callerName(caller) : "module"}`;
}
function addCaller(use, name, symbol, node, source, callers) {
  if (!symbolUse(use, name, symbol)) return;
  const expression = calledExpression(use);
  const registered = registeredCaller(expression);
  if (!registered && !calledUse(expression)) return;
  const caller = registered ? expression.parent : callerOf(use);
  if (caller === node) return;
  callers.set(caller ?? source, callerLabel(use, caller));
}
function callSites(name, node) {
  const symbol = symbolOf(name),
    callers = new Map();
  for (const source of sources)
    walk(source, (use) => addCaller(use, name, symbol, node, source, callers));
  return [...callers.values()].sort((a, b) => a.localeCompare(b));
}

function paramRow(param) {
  const doc = ts
    .getJSDocParameterTags(param)
    .map((tag) => (typeof tag.comment === "string" ? tag.comment.replace(/^-\s*/, "") : ""))
    .join(" ");
  if (!/\bFrom\b.+;\s*(?:why|for)\b.+/i.test(doc)) fail(param, "param-doc");
  const type = checker.getTypeAtLocation(param);
  if (
    /^(?:ctx|context|clock|signal|scope|controller)$/i.test(nameOf(param.name)) ||
    type.flags & ts.TypeFlags.Any ||
    contains(type, "plain")
  )
    fail(param, "plain-param");
  return `  - \`${nameOf(param.name)}\`: \`${param.type?.getText() ?? checker.typeToString(type)}\`. ${doc}`;
}
function effectReference(node) {
  if (ts.isIdentifier(node)) return /^(?:localStorage|sessionStorage)$/.test(node.text);
  return (
    ts.isPropertyAccessExpression(node) &&
    /^(?:crypto\.|console\.|performance\.now$|Date\.now$|globalThis\.fetch$|(?:globalThis\.)?(?:localStorage|sessionStorage)\.)/.test(
      nameOf(node),
    )
  );
}
function effectCall(node) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
  return (
    /\.(?:currentTimeMillis|sleep)$/.test(nameOf(node.expression)) ||
    /^(?:fetch|globalThis\.fetch|Date(?:\.now)?|performance\.now|crypto\..*|console\..*|(?:globalThis\.)?(?:localStorage|sessionStorage)\..*)$/.test(
      nameOf(node.expression),
    )
  );
}
function checkCast(node) {
  if (
    (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
    contains(checker.getTypeAtLocation(node.type), "plain")
  )
    fail(node, "plain-cast");
}
function checkEffect(node) {
  if (
    effectCall(node) ||
    effectReference(node) ||
    ts.isAwaitExpression(node) ||
    serviceAllocation(node)
  )
    fail(node, "plain-effect");
  checkCast(node);
}

const plain = [];
function checkScopeReturn(node) {
  const signature = checker.getSignatureFromDeclaration(node);
  if (
    !optionsMember(node) &&
    !factoryBody(node) &&
    exportedFunction(node) &&
    contains(checker.getReturnTypeOfSignature(signature), "scope")
  )
    fail(node, "exported-scope");
}
function checkComponent(node) {
  for (const param of node.parameters)
    if (contains(checker.getTypeAtLocation(param), "react")) fail(param, "component-param");
  ownWalk(node.body, (child) => {
    if (ts.isAwaitExpression(child)) fail(child, "component-await");
  });
}
function checkPlainFunction(node) {
  const name = functionName(node);
  const params = node.parameters.map(paramRow);
  if (node.parameters.length > 3) fail(node, "three-params");
  walk(node.body, checkEffect);
  if (!name) {
    fail(node, "unnamed-plain");
    return;
  }
  const callers = callSites(name, node);
  if (callers.length < 2) fail(node, "two-sites");
  plain.push(
    `- **${pathOf(node)}#${nameOf(name)}**\n${params.join("\n")}\n  - Callers:\n${callers.map((caller) => `    - \`${caller}\``).join("\n")}`,
  );
}
function checkFunction(node) {
  if (!isFunction(node) || !node.body) return;
  if (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) return;
  checkScopeReturn(node);
  if (isComponent(node)) {
    checkComponent(node);
    return;
  }
  if ([optionsMember, ownedMethod, nativeCallback].some((rule) => rule(node))) return;
  checkPlainFunction(node);
}

function nativeDomSymbol(symbol, name) {
  return (
    symbol?.name === name &&
    symbol.declarations?.some((decl) => decl.getSourceFile().fileName.endsWith("lib.dom.d.ts"))
  );
}
function wireType(type, name, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (nativeDomSymbol(type.symbol, name)) return true;
  if (primitiveType(type) || callable(type)) return false;
  return nestedWireType(type, name, seen);
}
function nestedWireType(type, name, seen) {
  const awaited = checker.getAwaitedType(type);
  if (awaited && awaited !== type && wireType(awaited, name, seen)) return true;
  if (type.isUnionOrIntersection()) return type.types.some((part) => wireType(part, name, seen));
  return wireTypeArguments(type, name, seen) || wireProperties(type, name, seen);
}
function wireTypeArguments(type, name, seen) {
  return (
    type.flags & ts.TypeFlags.Object &&
    type.objectFlags & ts.ObjectFlags.Reference &&
    checker.getTypeArguments(type).some((part) => wireType(part, name, seen))
  );
}
function wireProperties(type, name, seen) {
  return checker.getPropertiesOfType(type).some((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.at(0);
    return (
      declaration &&
      files.includes(declaration.getSourceFile().fileName) &&
      wireType(checker.getTypeOfSymbolAtLocation(property, declaration), name, seen)
    );
  });
}
function variableInitializer(symbol) {
  const declaration = symbol?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
}
function requestSchema(node, seen = new Set()) {
  if (!node || seen.has(node)) return false;
  seen.add(node);
  const schema = checker.getTypeAtLocation(node);
  const output = schema.getProperty("_output");
  if (output && wireType(checker.getTypeOfSymbolAtLocation(output, node), "Request")) return true;
  let request = false;
  walk(node, (child) => {
    const symbol = locationSymbol(child);
    const type = checker.getTypeAtLocation(child);
    if (
      nativeDomSymbol(symbol, "Request") ||
      wireType(type, "Request") ||
      type
        .getConstructSignatures()
        .some((signature) => wireType(checker.getReturnTypeOfSignature(signature), "Request"))
    )
      request = true;
    if (ts.isIdentifier(child) && requestSchema(variableInitializer(symbol), seen)) request = true;
  });
  return request;
}
function checkOperationInput(input) {
  if (requestSchema(input))
    fail(input, "operation-wire-input: requests belong to the protocol layer");
}
function functionImplementation(node, seen = new Set()) {
  node = unwrap(node);
  if (!node || seen.has(node)) return undefined;
  seen.add(node);
  if (isFunction(node)) return node;
  const symbol = locationSymbol(node);
  if (symbol?.valueDeclaration && isFunction(symbol.valueDeclaration))
    return symbol.valueDeclaration;
  return functionImplementation(variableInitializer(symbol), seen);
}
function checkOperationInputCast(node) {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) checkOperationInput(node.type);
}
function checkOperationRun(run) {
  if (!run) return;
  const expression = run.initializer ?? (ts.isShorthandPropertyAssignment(run) ? run.name : run);
  const signatures = checker.getTypeAtLocation(expression).getCallSignatures();
  let response = signatures.some((signature) =>
    wireType(checker.getReturnTypeOfSignature(signature), "Response"),
  );
  const implementation = functionImplementation(expression);
  if (implementation?.body)
    walk(implementation.body, (child) => {
      checkOperationInputCast(child);
      if (ts.isExpression(child) && wireType(checker.getTypeAtLocation(child), "Response"))
        response = true;
    });
  if (response) fail(run, "operation-wire-output: replies belong to the protocol layer");
}
function checkOperationWire(node) {
  if (!ts.isCallExpression(node) || !coreSymbol(node.expression, "operation")) return;
  const options = node.arguments[0];
  if (
    !options ||
    !ts.isObjectLiteralExpression(options) ||
    options.properties.some(ts.isSpreadAssignment)
  ) {
    fail(node, "operation-options: use a plain object literal without spreads");
    return;
  }
  checkOperationInput(propertyOf(options, "input")?.initializer);
  checkOperationRun(propertyOf(options, "run"));
}

for (const source of sources) {
  for (const error of program.getSyntacticDiagnostics(source))
    fail(source, ts.flattenDiagnosticMessageText(error.messageText, " "));
  walk(source, (node) => {
    checkOperationWire(node);
    checkFetch(node);
    checkBrowserHttp(node);
    checkHttpResource(node);
    checkHttpBackend(node);
    checkRequestHeaders(node);
    checkResponse(node);
    checkMountedAuth(node);
    checkHttpImport(node);
    checkService(node);
    checkRoots(node);
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) fail(node, "no-class");
    checkFunction(node);
  });
}
if (plain.length > PLAIN_MAX)
  failures.push(
    `PLAIN.md: plain-max ${plain.length} exceeds ${PLAIN_MAX}; raising the cap needs a decision`,
  );
const list = `# Plain functions\n\nThis list is checked against src.\nCallers include direct calls and typed callback registrations.\nRepeated calls by one caller count once; self-calls do not count.\nTests and generated files do not count.\n\n${plain.join("\n\n")}\n`;
if (process.argv.includes("--list")) process.stdout.write(list);
else {
  const saved = await readFile(join(root, "PLAIN.md"), "utf8");
  if (saved !== list) {
    const rows = list.split("\n"),
      savedRows = saved.split("\n");
    const index = rows.findIndex((row, index) => row !== savedRows[index]);
    failures.push(
      `PLAIN.md: plain-list disagrees with code at row ${index + 1}; saved: ${savedRows[index]}; code: ${rows[index]}`,
    );
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
if (!process.argv.includes("--list"))
  console.log(
    `Plain check passed: ${sources.length} files, ${plain.length} plain functions (cap ${PLAIN_MAX}).`,
  );
if (process.argv.includes("--prove")) {
  const planted = await mkdtemp(join(tmpdir(), "start-plain-red-"));
  const cases = [
    [
      "operation-request-input-cast",
      "operation-wire-input",
      'import {operation} from "@tinker/core"; import {z} from "zod"; const probe = operation({input: z.unknown(), run: (_deps, ctx) => (ctx.input as Request).url});',
    ],
    [
      "response-resource-unknown",
      "protocol-response",
      'import {operation, resource} from "@tinker/core"; const replies = resource({factory: () => new Response() as unknown}); const probe = operation({depends: {reply: replies}, run: ({reply}) => reply});',
    ],
    [
      "response-resource-method-unknown",
      "protocol-response",
      'import {operation, resource} from "@tinker/core"; const replies = resource({factory: () => ({make: (): unknown => new Response()})}); const probe = operation({depends: {replies}, run: ({replies}) => replies.make()});',
    ],
    [
      "response-reflect-construct",
      "protocol-response",
      'import {resource} from "@tinker/core"; const probe = resource({factory: () => Reflect.construct(Response, [])});',
    ],
    ["response-type-reference", "protocol-response", "export type Probe = Response;"],
    [
      "response-route-allowed",
      null,
      'import {createFileRoute} from "@tanstack/react-router"; export const Route = createFileRoute("/api/telemetry")({server: {handlers: {GET: () => new Response()}}}); export type Reply = Response;',
      "src/routes/plain-probe.ts",
    ],
    [
      "response-userland-refused",
      "protocol-response",
      'import {resource} from "@tinker/core"; const probe = resource({factory: () => new Response()}); export type Reply = Response;',
      "src/plain-probe.ts",
    ],
    [
      "response-local-type-allowed",
      null,
      "type Response = {value: string}; export type Probe = Response;",
    ],
    [
      "request-headers-constant-key",
      "protocol-headers",
      'import {operation} from "@tinker/core"; import * as t from "@tinker/start/testing"; const key = "requestHeaders" as const; const probe = operation({depends: {headers: t[key]}, run: ({headers}) => headers.get("x")});',
      "src/backend/plain-probe.ts",
    ],
    [
      "http-backend-constant-key",
      "http-backend",
      'import {operation} from "@tinker/core"; import * as t from "@tinker/start/testing"; const key = "httpBackend" as const; const probe = operation({depends: {send: t[key]}, run: () => 1});',
    ],
    [
      "operation-request-custom-reader",
      "operation-wire-input",
      'import {operation} from "@tinker/core"; import {z} from "zod"; type R = Request; const probe = operation({input: (value: unknown) => z.custom<R>().parse(value), run: (_deps, ctx) => ctx.input.url});',
    ],

    [
      "mounted-auth-bracket",
      "protocol-auth",
      'import {operation} from "@tinker/core"; import * as protocol from "@tinker/start/testing"; const probe = operation({depends: {mounted: protocol["handleAuth"].controller}, run: () => 1});',
      "src/backend/plain-probe.ts",
    ],
    [
      "request-headers-bracket",
      "protocol-headers",
      'import {operation} from "@tinker/core"; import * as protocol from "@tinker/start/testing"; const probe = operation({depends: {headers: protocol["requestHeaders"]}, run: ({headers}) => headers.get("x")});',
      "src/backend/plain-probe.ts",
    ],

    [
      "mounted-auth-testing",
      "protocol-auth",
      'import {operation} from "@tinker/core"; import {handleAuth} from "@tinker/start/testing"; const probe = operation({depends: {mounted: handleAuth.controller}, run: () => 1});',
      "src/backend/plain-probe.ts",
    ],
    [
      "mounted-auth-direct",
      "protocol-auth",
      'import {operation} from "@tinker/core"; import {handleAuth} from "@tinker/start/testing"; const probe = operation({depends: {mounted: handleAuth.controller}, run: () => 1});',
      "src/backend/plain-probe.ts",
    ],
    [
      "mounted-auth-userland",
      "protocol-auth",
      'import {operation} from "@tinker/core"; import {handleAuth} from "@tinker/start/testing"; const probe = operation({depends: {mounted: handleAuth.controller}, run: () => 1});',
      "src/plain-probe.ts",
    ],

    [
      "request-headers-testing",
      "protocol-headers",
      'import {operation} from "@tinker/core"; import {requestHeaders} from "@tinker/start/testing"; const probe = operation({depends: {headers: requestHeaders}, run: ({headers}) => headers.get("x")});',
      "src/backend/plain-probe.ts",
    ],
    [
      "request-headers-direct",
      "protocol-headers",
      'import {operation} from "@tinker/core"; import {requestHeaders} from "@tinker/start/server"; const probe = operation({depends: {headers: requestHeaders}, run: ({headers}) => headers.get("x")});',
      "src/backend/plain-probe.ts",
    ],
    [
      "request-headers-userland",
      "protocol-headers",
      'import {operation} from "@tinker/core"; import {requestHeaders} from "@tinker/start/server"; const probe = operation({depends: {headers: requestHeaders}, run: ({headers}) => headers.get("x")});',
      "src/plain-probe.ts",
    ],

    [
      "operation-response-callback",
      "operation-wire-output",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => new Promise((resolve) => resolve(new Response()))});',
    ],
    [
      "operation-response-cast",
      "operation-wire-output",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => new Response() as unknown});',
    ],
    [
      "operation-response-array",
      "operation-wire-output",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => [new Response()]});',
    ],
    [
      "operation-response-object",
      "operation-wire-output",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => ({reply: new Response()})});',
    ],
    [
      "operation-request-destructured",
      "operation-wire-input",
      'import {operation} from "@tinker/core"; import {z} from "zod"; const {Request: Req} = globalThis; const probe = operation({input: z.instanceof(Req), run: (_deps, ctx) => ctx.input.url});',
    ],
    [
      "operation-request-type-alias",
      "operation-wire-input",
      'import {operation} from "@tinker/core"; import {z} from "zod"; type R = Request; const probe = operation({input: z.custom<R>(), run: (_deps, ctx) => ctx.input.url});',
    ],
    [
      "operation-options-spread",
      "operation-options",
      'import {operation} from "@tinker/core"; const opts = {}; const run = String; const probe = operation({...opts, run});',
    ],
    [
      "operation-options-variable",
      "operation-options",
      'import {operation} from "@tinker/core"; const opts = {run: String}; const probe = operation(opts);',
    ],
    [
      "operation-response-typed-callback",
      "operation-wire-output",
      'import {operation} from "@tinker/core"; declare const reply: Response; const probe = operation({run: () => { const ignored = Promise.resolve().then(() => reply); return 1; }});',
    ],

    [
      "dynamic-require-alias",
      "http-client",
      'import {operation} from "@tinker/core"; const load = require; const moduleName = "node:http"; const probe = operation({run: () => load(moduleName)});',
    ],
    [
      "create-require-destructured",
      "http-client",
      'import {operation} from "@tinker/core"; const probe = operation({run: async () => { const {createRequire} = await import("node:module"); return createRequire(import.meta.url); }});',
    ],
    [
      "operation-request",
      "operation-wire-input",
      'import {operation} from "@tinker/core"; import {z} from "zod"; const probe = operation({input: z.instanceof(Request), run: (_deps, ctx) => ctx.input.url});',
    ],
    [
      "operation-request-alias",
      "operation-wire-input",
      'import {operation as op} from "@tinker/core"; import {z} from "zod"; const schema = z.instanceof(Request); const probe = op({input: schema, run: (_deps, ctx) => ctx.input.url});',
    ],
    [
      "operation-response",
      "operation-wire-output",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => new Response()});',
    ],
    [
      "operation-response-async",
      "operation-wire-output",
      'import {operation} from "@tinker/core"; const probe = operation({run: async () => new Response()});',
    ],
    [
      "operation-response-union",
      "operation-wire-output",
      'import {operation} from "@tinker/core"; const probe = operation({run: (_deps, ctx) => ctx.random.next() ? new Response() : null});',
    ],
    [
      "destructured-fetch-shorthand",
      "http-request",
      'import {operation} from "@tinker/core"; const {fetch} = globalThis; const probe = operation({run: () => fetch("https://example.test")});',
    ],
    [
      "destructured-beacon",
      "http-client",
      'import {operation} from "@tinker/core"; const {sendBeacon} = navigator; const probe = operation({run: () => sendBeacon("https://example.test", "x")});',
    ],
    [
      "destructured-xhr",
      "http-client",
      'import {operation} from "@tinker/core"; const {XMLHttpRequest} = globalThis; const probe = operation({run: () => new XMLHttpRequest()});',
    ],
    [
      "dynamic-import",
      "http-client",
      'import {operation} from "@tinker/core"; const moduleName = "node:http"; const probe = operation({run: () => import(moduleName)});',
    ],
    [
      "dynamic-require",
      "http-client",
      'import {operation} from "@tinker/core"; const moduleName = "node:http"; const probe = operation({run: () => require(moduleName)});',
    ],
    [
      "create-require",
      "http-client",
      'import {createRequire} from "node:module"; import {operation} from "@tinker/core"; const probe = operation({run: () => createRequire(import.meta.url)});',
    ],
    [
      "create-require-namespace",
      "http-client",
      'import * as mod from "node:module"; import {operation} from "@tinker/core"; const probe = operation({run: () => mod.createRequire(import.meta.url)});',
    ],
    ["type-export-client", null, 'export type { ClientRequest } from "node:http";'],
    ["client-net", "http-client", 'import * as client from "net"; export { client };'],
    ["client-tls", "http-client", 'import * as client from "tls"; export { client };'],
    ["client-dgram", "http-client", 'import * as client from "dgram"; export { client };'],
    [
      "client-node-dgram",
      "http-client",
      'import * as client from "node:dgram"; export { client };',
    ],
    [
      "client-xhr-constructor",
      "http-client",
      'import {resource} from "@tinker/core"; const probe = resource({factory: () => new XMLHttpRequest()});',
    ],
    [
      "client-xhr-global",
      "http-client",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => globalThis.XMLHttpRequest});',
    ],
    [
      "client-xhr-bracket",
      "http-client",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => window["XMLHttpRequest"]});',
    ],
    [
      "client-beacon-call",
      "http-client",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => navigator.sendBeacon("https://example.test/x", "hello")});',
    ],
    [
      "client-beacon-value",
      "http-client",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => navigator.sendBeacon});',
    ],
    [
      "client-beacon-bracket",
      "http-client",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => navigator["sendBeacon"]("https://example.test/x", "hello")});',
    ],
    [
      "client-websocket-allowed",
      null,
      'import {resource} from "@tinker/core"; const probe = resource({factory: (_deps, ctx) => { const socket = new WebSocket("wss://example.test/sync"); ctx.defer(() => socket.close()); return socket; }});',
    ],
    [
      "client-eventsource-allowed",
      null,
      'import {resource} from "@tinker/core"; const probe = resource({factory: (_deps, ctx) => { const events = new EventSource("https://example.test/sync"); ctx.defer(() => events.close()); return events; }});',
    ],
    [
      "client-import-type",
      null,
      'import type { ClientHttp2Session } from "node:http2"; export type Probe = ClientHttp2Session;',
    ],
    [
      "client-named-import-type",
      null,
      'import { type IncomingMessage, type ServerResponse } from "node:http"; export type Probe = IncomingMessage | ServerResponse;',
    ],
    [
      "client-mixed-import",
      "http-client",
      'import { type IncomingMessage, request } from "node:http"; export { request }; export type Probe = IncomingMessage;',
    ],
    [
      "client-default-and-type",
      "http-client",
      'import client, { type AxiosInstance } from "axios"; export { client }; export type Probe = AxiosInstance;',
    ],
    ["client-empty-import", "http-client", 'import {} from "node:http";'],
    [
      "client-node-http2",
      "http-client",
      'import * as client from "node:http2"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.connect("https://example.test/x")});',
    ],
    [
      "client-http2",
      "http-client",
      'import * as client from "http2"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.connect("https://example.test/x")});',
    ],
    [
      "client-ws",
      "http-client",
      'import * as client from "ws"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.WebSocket("https://example.test/x")});',
    ],
    [
      "client-ofetch",
      "http-client",
      'import * as client from "ofetch"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.ofetch("https://example.test/x")});',
    ],
    [
      "client-node-http",
      "http-client",
      'import * as client from "node:http"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-node-https",
      "http-client",
      'import * as client from "node:https"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-http",
      "http-client",
      'import * as client from "http"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-https",
      "http-client",
      'import * as client from "https"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-undici",
      "http-client",
      'import * as client from "undici"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-axios",
      "http-client",
      'import * as client from "axios"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-ky",
      "http-client",
      'import * as client from "ky"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-node-fetch",
      "http-client",
      'import * as client from "node-fetch"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-got",
      "http-client",
      'import * as client from "got"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-superagent",
      "http-client",
      'import * as client from "superagent"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-node-net",
      "http-client",
      'import * as client from "node:net"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-node-tls",
      "http-client",
      'import * as client from "node:tls"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    ["client-reexport", "http-client", 'export * from "node:https";'],
    [
      "client-dynamic",
      "http-client",
      'import {operation} from "@tinker/core"; const probe = operation({run: async () => (await import("node:https")).request("https://example.test/x")});',
    ],
    [
      "client-require",
      "http-client",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => require("node:http").request("https://example.test/x")});',
    ],
    [
      "client-import-equals",
      "http-client",
      'import client = require("node:https"); import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],
    [
      "client-subpath",
      "http-client",
      'import * as client from "axios/unsafe/adapters/http.js"; import {operation} from "@tinker/core"; const probe = operation({run: () => client.request("https://example.test/x")});',
    ],

    [
      "http-backend-dependency",
      "http-backend",
      'import {operation} from "@tinker/core"; import {httpBackend as backend} from "@tinker/start/testing"; const probe = operation({depends: {send: backend}, run: ({send}) => send("https://example.test/x")});',
    ],
    [
      "http-resource-dependency",
      "http-resource",
      'import {operation} from "@tinker/core"; import {http as client} from "@tinker/start/testing"; const probe = operation({depends: {client}, run: ({client}) => client.send("https://example.test/x", {method: "GET", signal: new AbortController().signal})});',
    ],
    ["http-resource-export", "http-resource", 'export {http} from "@tinker/start/testing";'],
    [
      "fetch-tag-value",
      "http-request",
      'import {tag} from "@tinker/core"; const probe = tag({default: fetch});',
    ],
    [
      "fetch-alias",
      "http-request",
      'import {operation} from "@tinker/core"; const send = fetch; const probe = operation({run: () => send("https://example.test/x")});',
    ],
    [
      "window-fetch",
      "http-request",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => window.fetch("https://example.test/x")});',
    ],
    [
      "self-fetch",
      "http-request",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => self.fetch("https://example.test/x")});',
    ],
    [
      "destructured-fetch",
      "http-request",
      'import {operation} from "@tinker/core"; const {fetch: f} = globalThis; const probe = operation({run: () => f("https://example.test/x")});',
    ],
    [
      "operation-fetch",
      "http-request",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => fetch("https://example.test/x")});',
    ],
    [
      "resource-fetch",
      "http-request",
      'import {resource} from "@tinker/core"; const probe = resource({factory: () => ({send: () => fetch("https://example.test/x")})});',
    ],
    [
      "callback-fetch",
      "http-request",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => Promise.resolve().then(() => fetch("https://example.test/x"))});',
    ],
    [
      "parenthesized-fetch",
      "http-request",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => (fetch)("https://example.test/x")});',
    ],
    [
      "global-fetch-reference",
      "http-request",
      'import {tag} from "@tinker/core"; const probe = tag({default: globalThis.fetch});',
    ],
    [
      "global-fetch-call",
      "http-request",
      'import {operation} from "@tinker/core"; const probe = operation({run: () => globalThis.fetch("https://example.test/x")});',
    ],
    [
      "global-fetch-element",
      "http-request",
      'import {tag} from "@tinker/core"; const probe = tag({default: globalThis["fetch"]});',
    ],
    [
      "entry-hidden-fetch",
      "plain-param",
      "const helpers = {async fetch(signal: AbortSignal) { await Promise.resolve(signal); }};",
      "src/server.ts",
    ],
    [
      "wrapped-factory",
      "unnamed-plain",
      'import {resource} from "@tinker/core"; const probe = resource({factory: Object.freeze(async (clock: unknown, signal: AbortSignal, a: number, b: number) => { await Promise.resolve(signal); })});',
    ],
    [
      "entry-service",
      "service-owner",
      'import {createIsomorphicFn} from "@tanstack/react-start"; const hiddenService = createIsomorphicFn().server(() => new BroadcastChannel("x"));',
      "src/server.ts",
    ],
    [
      "entry-hidden-controller",
      "service-owner",
      'import {createIsomorphicFn} from "@tanstack/react-start"; const hiddenStop = createIsomorphicFn().server(() => new AbortController());',
      "src/server.ts",
    ],
    [
      "unit-param",
      "plain-param",
      'import type {Resource} from "@tinker/core"; function probe(value: Resource.Handle<unknown>) {return value;} probe(null!); probe(null!);',
    ],
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
    ["service-module", "module-effect", "const cache = new Map();"],
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
    [
      "object-arrow",
      "plain-param",
      'import type { Clock } from "@tinker/core"; export const helpers = { tick: async (clock: Clock.Handle, signal: AbortSignal) => { await clock.sleep(1, signal); } };',
    ],
    [
      "object-method",
      "plain-param",
      'import type { Clock } from "@tinker/core"; export const helpers = { async tick(clock: Clock.Handle, signal: AbortSignal) { await clock.sleep(1, signal); } };',
    ],
    [
      "freeze-arrow",
      "unnamed-plain",
      'import type { Clock } from "@tinker/core"; export const tick = Object.freeze(async (clock: Clock.Handle, signal: AbortSignal, a: number, b: number) => { await clock.sleep(a+b, signal); });',
    ],
    [
      "hidden-method",
      "plain-param",
      'import { resource } from "@tinker/core"; export const probe = resource({factory: (_deps, ctx) => { const hidden = {async wait(clock: typeof ctx.clock, signal: AbortSignal, a: number, b: number) { await clock.sleep(a+b, signal); }}; return { go: (s: AbortSignal) => hidden.wait(ctx.clock, s, 1, 2) }; }});',
    ],
    ["or-arrow", "unnamed-plain", "const probe = undefined || ((v: AbortSignal) => v);"],
    ["nullish-arrow", "unnamed-plain", "const probe = undefined ?? ((v: AbortSignal) => v);"],
    [
      "src-callback",
      "unnamed-plain",
      "function take(v: unknown) { return v; } take((v: AbortSignal) => v);",
    ],
    [
      "one-caller-two-calls",
      "two-sites",
      "function probe(v: number) { return v; } function caller() { probe(1); probe(2); } caller();",
    ],
    [
      "self-call",
      "two-sites",
      "function probe(v: number): number { return v ? probe(v-1) : v; } function caller() { probe(1); } caller();",
    ],
    [
      "non-call-use",
      "two-sites",
      "function probe(v: number) { return v; } String(probe); String(probe);",
    ],
    [
      "scope-element",
      "scope-entry-only",
      'import * as Core from "@tinker/core"; Core["createScope"]({});',
    ],
    [
      "scope-parentheses",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; (createScope)({});',
    ],
    [
      "scope-comma",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; (0, createScope)({});',
    ],
    [
      "scope-call",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; createScope.call(undefined, {});',
    ],
    [
      "scope-array",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; [createScope][0]!({});',
    ],
    [
      "scope-cast",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; (createScope as typeof createScope)({});',
    ],
    [
      "scope-reflect",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; Reflect.apply(createScope, undefined, [{}]);',
    ],
    [
      "scope-entry-module",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; const root = createScope({});',
      "src/router.ts",
    ],
    [
      "holder-const",
      "module-handle",
      'import type { Scope } from "@tinker/core"; export const holder = {scope: undefined as Promise<Scope.Handle> | undefined};',
    ],
    ["holder-stop", "module-handle", "export let stop: AbortController | undefined;"],
    [
      "holder-pool",
      "module-handle",
      'import type pg from "pg"; export let pool: pg.Pool | undefined;',
    ],
    [
      "scope-accessor",
      "exported-scope",
      'import type { Scope } from "@tinker/core"; const holder = {scope: undefined as Promise<Scope.Handle> | undefined}; export const app = {get root() {return holder.scope;}};',
    ],
    [
      "scope-property",
      "exported-scope",
      'import type { Scope } from "@tinker/core"; const holder = {scope: undefined as Promise<Scope.Handle> | undefined}; export const app = {root: () => holder.scope};',
    ],
    ["plain-any", "plain-param", "function probe(v: any) { return v; } probe(1); probe(2);"],
    ["plain-generic", "plain-param", "function probe<T>(v: T) { return v; } probe(1); probe(2);"],
    [
      "plain-unknown-cast",
      "plain-cast",
      'import type { Clock } from "@tinker/core"; function probe(v: unknown) { return (v as Clock.Handle).currentTimeMillis(); } probe(1); probe(2);',
    ],
    [
      "request-options",
      "plain-param",
      "function probe(v: RequestInit) { return v; } probe({}); probe({});",
    ],
    [
      "pick-options",
      "plain-param",
      'function probe(v: Pick<RequestInit, "signal">) { return v; } probe({}); probe({});',
    ],
    [
      "event-options",
      "plain-param",
      "function probe(v: AddEventListenerOptions) { return v; } probe({}); probe({});",
    ],
    [
      "component-clock",
      "component-param",
      'import type {Clock} from "@tinker/core"; export function Probe(clock: Clock.Handle) { void clock.sleep(1); return <div/>; }',
      "src/plain-probe.tsx",
    ],
    [
      "component-await",
      "component-await",
      "export async function Probe() { await Promise.resolve(); return <div/>; }",
      "src/plain-probe.tsx",
    ],
    [
      "component-bag",
      "component-param",
      "export function Probe(props: {stop: AbortSignal; onDone: () => void}) { return <div/>; }",
      "src/plain-probe.tsx",
    ],
    [
      "module-mail",
      "module-effect",
      'import nodemailer from "nodemailer"; const probe = nodemailer.createTransport({});',
    ],
    [
      "module-auth",
      "module-effect",
      'import { createAuthClient } from "better-auth/react"; const probe = createAuthClient();',
    ],
    ["module-broadcast", "module-effect", 'const probe = new BroadcastChannel("x");'],
    ["module-frame", "module-effect", "requestAnimationFrame(() => {});"],
    ["module-listener", "module-effect", 'globalThis.addEventListener("message", () => {});'],
    [
      "option-timer",
      "module-effect",
      'import {resource} from "@tinker/core"; const probe = resource({label: String(setInterval(() => {}, 1)), factory: () => ({})});',
    ],
    [
      "module-unknown-call",
      "module-effect",
      "function surprise() { return 1; } const probe = surprise();",
    ],
    [
      "module-zod-parse",
      "module-effect",
      'import {z} from "zod"; const probe = z.string().parse("x");',
    ],
    ...[
      "new Date()",
      "Date()",
      "performance.now()",
      "crypto.randomUUID()",
      'globalThis.fetch("/")',
      'localStorage.getItem("x")',
      'sessionStorage.getItem("x")',
      "console.log(1)",
    ].map((effect, index) => [
      `plain-native-effect-${index}`,
      "plain-effect",
      `function probe() { return ${effect}; } probe(); probe();`,
    ]),
    [
      "src-resource-callback",
      "plain-param",
      'import {resource} from "@tinker/core"; const unit = resource({factory: () => ({ call: (fn: (signal: AbortSignal) => unknown) => fn(new AbortController().signal) })}); const callback = resource({depends: {unit}, factory: ({unit}) => unit.call((signal: AbortSignal) => signal)});',
    ],
    [
      "plain-cap",
      "plain-max",
      'import {operation} from "@tinker/core";\n' +
        Array.from(
          { length: PLAIN_MAX + 1 },
          (_, index) =>
            `/** @param v - From the caller; why: keep its number. */ function pure${index}(v: number) { return v; }`,
        ).join("\n") +
        "\nconst a = operation({run: () => [" +
        Array.from({ length: PLAIN_MAX + 1 }, (_, index) => `pure${index}(1)`).join(",") +
        "]}); const b = operation({run: () => [" +
        Array.from({ length: PLAIN_MAX + 1 }, (_, index) => `pure${index}(2)`).join(",") +
        "]});",
    ],
    ["list", "plain-list", "export const probe = 1;"],
  ];
  const names = process.argv
    .find((arg) => arg.startsWith("--cases="))
    ?.slice(8)
    .split(",");
  const selected = names ? cases.filter(([name]) => names.includes(name)) : cases;
  if (names) assert.equal(selected.length, names.length, "unknown planted case");
  try {
    await cp(join(root, "src"), join(planted, "src"), { recursive: true });
    for (const file of ["tsconfig.json", "PLAIN.md", "package.json", ".tinker"])
      await cp(join(root, file), join(planted, file), { recursive: true });
    await cp(join(root, "tests"), join(planted, "tests"), { recursive: true });
    await symlink(join(root, "node_modules"), join(planted, "node_modules"), "dir");
    const generated = join(planted, ".tinker/tsconfig.json");
    await writeFile(generated, (await readFile(generated, "utf8")).replaceAll(root, planted));
    for (const [name, rule, source, file = "src/plain-probe.ts"] of selected) {
      const path = join(planted, file);
      const original = await readFile(path, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      await writeFile(path, original + source + "\n");
      if (name === "list") await writeFile(join(planted, "PLAIN.md"), "wrong list\n");
      const red = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), planted, ...(name === "plain-cap" ? ["--list"] : [])],
        {
          encoding: "utf8",
        },
      );
      const log = join(tmpdir(), `start-plain-proof-${name}.log`);
      await writeFile(log, red.stdout + red.stderr + `\nEXIT ${red.status}\n`);
      assert.equal(red.status, rule ? 1 : 0, name);
      if (rule) assert.ok(red.stderr.includes(rule), `${name}: must fail by ${rule}`);
      if (original) await writeFile(path, original);
      else await rm(path);
      console.log(`PASS: ${name} ${rule ?? "allowed"} EXIT ${red.status}; ${log}`);
    }
    console.log(`Plain proof passed: ${selected.length} planted cases.`);
  } finally {
    await rm(planted, { recursive: true, force: true });
  }
}
