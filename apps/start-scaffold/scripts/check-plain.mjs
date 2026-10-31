import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript-api";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? app);
// TypeScript resolves types from the working folder; run from the project root.
process.chdir(root);

const base = dirname(
  createRequire(join(root, "package.json")).resolve("@tinker/start/package.json"),
);

const { commandImport, isolatedImport } = createRequire(join(base, "package.json"))(
  "./lib/checks/imports.mjs",
);

const failures = [];
const files = [];

async function scan(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (!entry.isDirectory() && /^cmds\/[^/]+\//.test(relative(root, path))) {
      failures.push(
        `${relative(root, path)}:1: nested-command: commands must be files directly under cmds; move it to cmds/${entry.name}`,
      );
    }
    if (entry.isDirectory()) await scan(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.(gen|generated|d)\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
}

await scan(join(root, "src"));
await scan(join(root, "cmds"));
await scan(join(root, "tinker"));
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
  ) {
    node = node.expression;
  }
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
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isFunction(parent)) return parent;
  }
}

function isComponent(node) {
  if (
    !node.getSourceFile().fileName.endsWith(".tsx") ||
    !/^[A-Z]/.test(nameOf(functionName(node))) ||
    node.parameters.length > 1
  ) {
    return false;
  }
  let jsx = false;
  ownWalk(node.body, (child) => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      jsx = true;
    }
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
  if (directOptions(member.parent)) {
    return ["run", "factory", "input"].includes(nameOf(member.name));
  }
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
    (directReturn(call, owner) || localReturn(call, owner))
  );
}

function localReturn(object, owner) {
  if (!ts.isVariableDeclaration(object.parent)) return false;
  const symbol = symbolOf(object.parent.name);
  let found = false;
  ownWalk(owner.body, (use) => {
    if (ts.isReturnStatement(use) && use.expression && symbolOf(use.expression) === symbol) {
      found = true;
    }
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
  if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression)) {
    return undefined;
  }
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
    ) {
      method = child;
    }
  });

  return method;
}

function externalCall(node) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
  if (
    /^(?:Object\.(?:freeze|assign)$|Reflect\.|String$|Number$|Boolean$)/.test(
      nameOf(node.expression),
    )
  ) {
    return false;
  }
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

/** A function has a name field, so Zod can select its data overload for {name: string}.
 * It still invokes a callable fallback; check the actual callback overload too.
 */
function zodCatchCallback(call, arg) {
  const signature = checker.getResolvedSignature(call);
  const file = signature?.declaration?.getSourceFile().fileName ?? "";
  if (!/\/zod\//.test(file) || declarationName(call) !== "catch") return false;

  const argument = checker.getTypeAtLocation(arg);
  return checker
    .getTypeAtLocation(call.expression)
    .getCallSignatures()
    .some((candidate) => {
      const parameter = candidate.parameters[0];
      if (!parameter) return false;
      const type = checker.getTypeOfSymbolAtLocation(parameter, arg);
      return callable(type) && checker.isTypeAssignableTo(argument, type);
    });
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
  if (tagArgument(call) || zodCatchCallback(call, arg)) return true;

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
  ) {
    return false;
  }
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

/** The native Start entry invokes and caches this exact callback argument. */
function entryArgument(node, call) {
  if (callbackIndex(call, node) !== 0) return false;
  return symbolOf(call.expression)?.declarations?.some(
    (declaration) =>
      pathOf(declaration) === "tinker/base/start-entry.ts" &&
      nameOf(declaration.name) === "createStartEntry",
  );
}

/** The shared database owns these notification callbacks until its listener closes. */
function databaseListenerArgument(node, call) {
  const index = callbackIndex(call, node);
  if (index !== 1 && index !== 2) return false;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  return (
    declaration &&
    pathOf(declaration) === "tinker/components/database/types.ts" &&
    ts.isPropertySignature(declaration.parent) &&
    nameOf(declaration.parent.name) === "listen"
  );
}

function nativeArgument(node) {
  const call = node.parent;
  return (
    argumentOf(node, call) &&
    callbackArgument(call, node) &&
    (entryArgument(node, call) ||
      databaseListenerArgument(node, call) ||
      (externalCall(call) && externalDeclaration(call)))
  );
}

function nativeOption(node) {
  const member = ts.isPropertyAssignment(node.parent) ? node.parent : node;
  if (!ts.isObjectLiteralExpression(member.parent)) return false;

  let object = member.parent;
  while (
    ts.isPropertyAssignment(object.parent) &&
    ts.isObjectLiteralExpression(object.parent.parent)
  ) {
    object = object.parent.parent;
  }

  const call = object.parent;
  if (coreSymbol(call.expression, "namespace")) return false;
  return (
    argumentOf(object, call) &&
    externalCall(call) &&
    [externalDeclaration, resolvedMethod].some((rule) => !!rule(call))
  );
}

function namedNativeCallback(node) {
  const name = functionName(node);
  if (!name) return false;
  const symbol = symbolOf(name);

  let callback = false;
  for (const source of sources) {
    walk(source, (use) => {
      if (ts.isIdentifier(use) && use !== name && symbolOf(use) === symbol && callbackUse(use)) {
        callback = true;
      }
    });
  }

  return callback;
}

function classifyNativeCallback(node) {
  if (ts.isFunctionDeclaration(node)) return false;
  if (ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent)) return true;
  return nativeArgument(node) || nativeOption(node) || namedNativeCallback(node);
}

function graphOwner(node) {
  for (let parent = enclosingFunction(node); parent; parent = enclosingFunction(parent)) {
    if (optionsMember(parent) || factoryBody(parent) || entryFunction(parent)) return true;
  }
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
  ) {
    return true;
  }
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
  if (mode === "react" && /^(?:ctx|context|clock|signal|scope|controller)$/.test(prop.name)) {
    return true;
  }
  if (!files.includes(decl.getSourceFile().fileName) && prop.name !== "signal") return false;
  return contains(checker.getTypeOfSymbolAtLocation(prop, decl), mode, seen, depth + 1);
}

function awaitedContains(type, mode, seen, depth) {
  const awaited = checker.getAwaitedType(type);
  return awaited && awaited !== type && contains(awaited, mode, seen, depth + 1);
}

function nestedTypeContains(type, mode, seen, depth) {
  if (type.isUnionOrIntersection()) {
    return type.types.some((part) => contains(part, mode, seen, depth + 1));
  }

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
  if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    return true;
  }

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
  ) {
    return;
  }
  if (ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent)) return;
  fail(node, "scope-entry-only");
}

function isCommand(node) {
  return /^cmds\/[^/]+\.tsx?$/.test(pathOf(node));
}

function checkRoots(node) {
  if (isCommand(node)) return;
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
      "looseObject",
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
      "pipe",
      "omit",
      "brand",
      "optional",
      "nullable",
      "strict",
      "loose",
      "default",
      "or",
      "refine",
      "catch",
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
      "uuid",
      "smallint",
      "bigserial",
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

/** Namespace and tag bindings are Core config; they grant no callback ownership. */
function coreDeclaration(node) {
  return coreCall(node) || coreSymbol(node.expression, "namespace") || tagArgument(node);
}

function moduleDeclarationCall(node) {
  if ([coreDeclaration, clientDeclaration, definedMainCall].some((read) => read(node))) return true;
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
const builtinSet = checker.resolveName("Set", undefined, ts.SymbolFlags.Value, false);
assert.ok(builtinSet, "the project must declare built-in Set");
const builtinMap = checker.resolveName("Map", undefined, ts.SymbolFlags.Value, false);
assert.ok(builtinMap, "the project must declare built-in Map");

const browserHttpDeclarations = new Set([
  ...builtinXhr.declarations,
  ...builtinBeacon.declarations,
]);

function typeReference(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent) || typeOnlyImport(parent)) return true;
  }
  return false;
}

function referenceSymbol(node) {
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    return checker
      .getTypeAtLocation(node.parent)
      .getProperty(nameOf(node.propertyName ?? node.name));
  }
  if (ts.isElementAccessExpression(node)) {
    const key = checker.getTypeAtLocation(node.argumentExpression);
    if (key.isStringLiteral()) {
      return checker.getTypeAtLocation(node.expression).getProperty(key.value);
    }
  }
  return locationSymbol(node);
}

function nativeReference(node, declarations) {
  if (
    !ts.isIdentifier(node) &&
    !ts.isBindingElement(node) &&
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return false;
  }
  return referenceSymbol(node)?.declarations?.some((decl) => declarations.has(decl));
}

/** Only the HTTP backend tag's default supplies native fetch. */
function backendDefault(node) {
  if (pathOf(node) !== "tinker/components/http/backend.ts") return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isPropertyAssignment(parent) || nameOf(parent.name) !== "default") continue;
    const call = parent.parent.parent;
    return (
      ts.isCallExpression(call) &&
      coreSymbol(call.expression, "tag") &&
      ts.isVariableDeclaration(call.parent) &&
      nameOf(call.parent.name) === "httpBackend"
    );
  }
  return false;
}

function checkFetch(node) {
  if (typeReference(node) || backendDefault(node) || !nativeReference(node, fetchDeclarations)) {
    return;
  }
  fail(node, "http-request: use httpRequest.controller instead of built-in fetch");
}

function checkBrowserHttp(node) {
  if (typeReference(node)) return;
  if (nativeReference(node, browserHttpDeclarations)) {
    fail(node, "http-client: app HTTP must use httpRequest.controller");
  }
}

function checkHttpResource(node) {
  if (typeReference(node)) return;
  if (
    ["tinker/components/http/http.server.ts", "tinker/components/http/index.server.ts"].includes(
      pathOf(node),
    )
  ) {
    return;
  }
  if (protocolUnitReference(node, "tinker/components/http/http.server.ts", "http")) {
    fail(node, "http-resource: app code must depend on httpRequest.controller");
  }
}

function checkHttpBackend(node) {
  if (pathOf(node) === "tinker/components/telemetry/delivery.ts") return;
  if (
    ["backend.ts", "http.server.ts", "index.ts"].some(
      (file) => pathOf(node) === `tinker/components/http/${file}`,
    )
  ) {
    return;
  }
  if (protocolUnitReference(node, "tinker/components/http/backend.ts", "httpBackend")) {
    fail(node, "http-backend: app code must depend on httpRequest.controller");
  }
}

function protocolUnitReference(node, file, name) {
  if (
    !ts.isIdentifier(node) &&
    !ts.isBindingElement(node) &&
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return false;
  }
  const symbol = referenceSymbol(node);
  const target = aliasTarget(symbol);
  return target?.declarations?.some(
    (decl) =>
      ts.isVariableDeclaration(decl) &&
      resolve(decl.getSourceFile().fileName) ===
        join(file.startsWith("tinker/") ? root : base, file) &&
      nameOf(decl.name) === name,
  );
}

/** The auth set and its SQLite twin own the same mounted protocol exception. */
const authServerFiles = [
  "tinker/components/auth/auth.server.ts",
  "tinker/components/auth-sqlite/auth.server.ts",
];

const authMountFiles = [
  "tinker/components/auth/handle.server.ts",
  "tinker/components/auth/index.server.ts",
  "tinker/components/auth-sqlite/handle.server.ts",
  "tinker/components/auth-sqlite/index.server.ts",
];

/** The MCP set owns ADR 0103's second mounted protocol exception: the SDK's Streamable HTTP. */
const mcpMountFiles = [
  "tinker/components/mcp/handle.server.ts",
  "tinker/components/mcp/index.server.ts",
];

function checkRequestHeaders(node) {
  const file = pathOf(node);
  if (authServerFiles.includes(file)) return;
  if (
    ["start.ts", "headers.server.ts", "index.server.ts"].some(
      (name) => file === `tinker/components/requests/${name}`,
    )
  ) {
    return;
  }
  if (
    protocolUnitReference(node, "tinker/components/requests/headers.server.ts", "requestHeaders")
  ) {
    fail(node, "protocol-headers: app code must use principal or currentUser");
  }
}

const builtinResponse = checker.resolveName("Response", undefined, ts.SymbolFlags.Value, false);
assert.ok(builtinResponse, "the project must declare built-in Response");
const responseDeclarations = new Set(builtinResponse.declarations);

/** Only the body of the `handleMcp` declaration may build a reply; the rest of its file may not. */
function insideMountedMcp(node) {
  if (pathOf(node) !== "tinker/components/mcp/handle.server.ts") return false;

  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return nameOf(parent.name) === "handleMcp";
  }

  return false;
}

function checkResponse(node) {
  const file = pathOf(node);
  if (file.startsWith("src/routes/")) return;
  if (file === "tinker/components/requests/body.server.ts") return;
  if (["tinker/base/server-entry.ts", "tinker/base/panics.tsx"].includes(file)) return;
  if (insideMountedMcp(node)) return;

  if (nativeReference(node, responseDeclarations)) {
    fail(node, "protocol-response: replies belong to routes or the base");
  }
}

function checkMountedAuth(node) {
  if (authMountFiles.includes(pathOf(node)) || pathOf(node) === "src/routes/api.auth.$.ts") {
    return;
  }

  if (protocolUnitReference(node, "tinker/components/auth/handle.server.ts", "handleAuth")) {
    fail(node, "protocol-auth: only the auth route may use the mounted handler");
  }
}

/** Any route may use `handleMcp` until the app names its one MCP route file, as auth's. */
function checkMountedMcp(node) {
  if (mcpMountFiles.includes(pathOf(node)) || pathOf(node).startsWith("src/routes/")) return;

  if (protocolUnitReference(node, "tinker/components/mcp/handle.server.ts", "handleMcp")) {
    fail(node, "protocol-mcp: only a route may use the mounted MCP handler");
  }
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
  if (ts.isImportEqualsDeclaration(node)) {
    return ts.isExternalModuleReference(node.moduleReference)
      ? node.moduleReference.expression
      : undefined;
  }
  if (
    ts.isCallExpression(node) &&
    (["import", "require"].includes(nameOf(node.expression)) || requireReference(node.expression))
  ) {
    return node.arguments[0];
  }
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

// SMTP owns its native sockets; only its lazy net module may load TCP.
function smtpNetModule(node, specifier) {
  const owner = enclosingFunction(node);
  return (
    specifier.text === "node:net" &&
    pathOf(node) === "tinker/components/mail/modules.ts" &&
    owner &&
    factoryBody(owner)
  );
}

function checkHttpImport(node) {
  if (typeOnlyImport(node) || typeReference(node)) return;
  const specifier = importSpecifier(node);

  if (createRequireReference(node)) {
    fail(node, "http-client: createRequire is not allowed in app code");
  }
  if (!specifier) return;

  if (!ts.isStringLiteralLike(specifier)) {
    fail(node, "http-client: module loads must use a literal path");
    return;
  }

  if (smtpNetModule(node, specifier)) return;

  if (
    httpClients.some(
      (client) => specifier.text === client || specifier.text.startsWith(`${client}/`),
    )
  ) {
    fail(node, "http-client: app HTTP must use httpRequest.controller");
  }
}

/** These immutable native values keep the copied protocol's package contracts. */
function staticProtocolValue(node) {
  if (!ts.isNewExpression(node)) return false;
  const constructors = {
    "tinker/components/errors/errors.ts": "DOMException",
  };
  if (nameOf(node.expression) === constructors[pathOf(node)]) return true;
  return false;
}

/** A literal value: a string, template, number, negative number, boolean, or null. */
function literalValue(node) {
  node = unwrap(node);
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    (ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      node.kind,
    )
  );
}

/** A Set element is one literal; a Map entry is a two-item array of literals. */
function collectionEntry(node, kind) {
  if (kind === "Map") {
    return (
      ts.isArrayLiteralExpression(node) &&
      node.elements.length === 2 &&
      node.elements.every(literalValue)
    );
  }
  return literalValue(node);
}

/** Members that only read a Set or Map. */
const collectionReads = ["has", "get", "forEach", "keys", "values", "entries"];

/** The built-in Set or Map a new expression calls, so a local Set is refused. */
function collectionKind(node) {
  const symbol = locationSymbol(unwrap(node.expression));
  if (symbol === builtinSet) return "Set";
  return symbol === builtinMap ? "Map" : undefined;
}

/** An identifier lifted through a qualified name and its value wrappers. */
function liftedReference(use) {
  let ref = use;
  while (ts.isPropertyAccessExpression(ref.parent) && ref.parent.name === ref) ref = ref.parent;
  while (
    ts.isParenthesizedExpression(ref.parent) ||
    ts.isAsExpression(ref.parent) ||
    ts.isTypeAssertionExpression(ref.parent) ||
    ts.isNonNullExpression(ref.parent) ||
    ts.isSatisfiesExpression(ref.parent)
  ) {
    ref = ref.parent;
  }
  return ref;
}

/** Import, export, and type references never read the value at runtime. */
function nameOnlyUse(use) {
  const parent = use.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    typeReference(use)
  );
}

/** A member access that only reads the binding: size once, the rest as a call. */
function collectionRead(ref) {
  const parent = ref.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== ref) return false;
  if (parent.name.text === "size") return true;
  if (!collectionReads.includes(parent.name.text)) return false;
  return ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
}

/** A member read, an iteration, or a spread keeps the binding a value. */
function valueUse(ref) {
  const parent = ref.parent;
  return (
    collectionRead(ref) ||
    (ts.isForOfStatement(parent) && parent.expression === ref) ||
    (ts.isSpreadElement(parent) && parent.expression === ref)
  );
}

/** Every use only reads the binding, so the literal Set or Map stays a static value. */
function collectionReadOnly(symbol, name) {
  let escaped = false;

  for (const source of sources) {
    walk(source, (use) => {
      if (escaped || !ts.isIdentifier(use) || use === name || symbolOf(use) !== symbol) return;
      if (!nameOnlyUse(use) && !valueUse(liftedReference(use))) escaped = true;
    });
  }

  return !escaped;
}

/** The module-level const declaration a value initializes, or undefined. */
function moduleConstantDeclaration(node) {
  const declaration = node.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    unwrap(declaration.initializer) !== node
  ) {
    return undefined;
  }

  const list = declaration.parent;
  if (
    !ts.isVariableDeclarationList(list) ||
    (list.flags & ts.NodeFlags.Const) === 0 ||
    !ts.isVariableStatement(list.parent) ||
    list.parent.parent !== node.getSourceFile()
  ) {
    return undefined;
  }

  return declaration;
}

/** One array argument of literals that nothing reads beyond its members is a value. */
function literalCollection(node, kind, declaration) {
  const [argument] = node.arguments ?? [];
  if (node.arguments?.length !== 1 || !ts.isArrayLiteralExpression(argument)) return false;

  if (!argument.elements.every((element) => collectionEntry(element, kind))) return false;

  return collectionReadOnly(symbolOf(declaration.name), declaration.name);
}

/** A const Set or Map of literals is a static value, like a const lookup table. */
function staticCollectionValue(node) {
  const kind = ts.isNewExpression(node) ? collectionKind(node) : undefined;
  if (!kind) return false;

  const declaration = moduleConstantDeclaration(node);
  return declaration !== undefined && literalCollection(node, kind, declaration);
}

function checkService(node) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
  if (!enclosingFunction(node)) {
    checkModuleEffect(node);
    return;
  }
  if (!serviceAllocation(node) || graphOwner(node)) return;
  fail(node, "service-owner");
}

function checkModuleEffect(node) {
  if (isCommand(node) || staticProtocolValue(node) || staticCollectionValue(node)) return;
  if (!moduleDeclarationCall(node)) fail(node, "module-effect");
}

function checkScopeReturn(node) {
  const signature = checker.getSignatureFromDeclaration(node);
  if (
    !optionsMember(node) &&
    !factoryBody(node) &&
    exportedFunction(node) &&
    contains(checker.getReturnTypeOfSignature(signature), "scope")
  ) {
    fail(node, "exported-scope");
  }
}

function checkComponent(node) {
  for (const param of node.parameters) {
    if (contains(checker.getTypeAtLocation(param), "react")) fail(param, "component-param");
  }
  ownWalk(node.body, (child) => {
    if (ts.isAwaitExpression(child)) fail(child, "component-await");
  });
}

/**
 * App code has no plain helper functions: each one is an operation, so every call is a span and
 * its dependencies come through the graph (Duke 2026-10-31, tinker-app #44).
 */
function checkPlainFunction(node) {
  fail(node, "plain-function: make it an operation");
}

/** Named copied entry helpers and the approved server and browser mains keep native contracts. */
const entryHelpers = {
  "tinker/components/database/database.server.ts": ["queryWithStop"],
  // The SQLite twin's guarded view: the session owns the write connection until its end.
  "tinker/components/database-sqlite/database.server.ts": ["guardQuery"],
  "tinker/components/database/lease.server.ts": ["leaseFrom", "logQuery", "query", "release"],
  "tinker/base/main.ts": ["defineMain"],
  "tinker/base/panics.server.ts": [
    // c55998e createServerEntry: register process panic cleanup without identity wrapping.
    "observeServerPanics",
  ],
  "tinker/base/panics.tsx": [
    // New: copied c55998e entry/dev-error devErrorPage: read a failed response and build its dev page.
    "devErrorPage",
  ],
  "cmds/router.ts": [
    // New: only the top-level named export owns the browser roots in plain view.
    "getRouter",
  ],
  "tinker/base/router-entry.tsx": [
    // Replacement for the copied observer callback: borrow the current render observer.
    "readRenderObservation",
    // Load the native route tree and bind its fallback views and React provider.
    "createRouterEntry",
  ],
  "tinker/base/server-entry.ts": [
    // New: bind Start's renderer to the command's request scope.
    "createServerHandler",
    "stoppedFetch",
    // New: copied c55998e entry/server fetch: dispatch a request through Start or app fetch.
    "fetch",
    // New: copied c55998e entry/server next: render the request and map its dev error response.
    "next",
  ],
  "tinker/base/start-entry.ts": [
    // Configure Start's CSRF guard and cache the command's async options once.
    "createStartEntry",
  ],
  "tinker/base/telemetry-worker.ts": [
    // New: read the worker thread's inputs and write console lines straight to the descriptor.
    "telemetryWorkerInput",
    "write",
    // New: read the shared ring, answer the port, and post health when its kind changes.
    "serveTelemetryWorker",
    "post",
    "ringLines",
    "takeLines",
  ],
};

function definedMainCall(node) {
  return (
    ts.isCallExpression(node) &&
    isCommand(node) &&
    node.parent &&
    ts.isExportAssignment(node.parent) &&
    nameOf(node.expression) === "defineMain" &&
    declarationFile(node).endsWith("/tinker/base/main.ts")
  );
}

// Every process default uses the real typed marker, including worker and CLI commands.
function checkCommandMain(node) {
  if (!isCommand(node)) return;
  if (ts.isExportAssignment(node) && !node.isExportEquals) {
    if (!definedMainCall(node.expression)) {
      fail(node, "command-main: use defineMain from ~/base/main");
    }
    return;
  }
  if (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  ) {
    fail(node, "command-main: use defineMain from ~/base/main");
  }
}

function definedMainCallback(node) {
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.parent &&
    definedMainCall(node.parent) &&
    node.parent.arguments[0] === node
  );
}

function isEntryHelper(node) {
  if (!node) return false;
  const file = pathOf(node);
  if (!entryHelpers[file]?.includes(nameOf(functionName(node)))) return false;
  if (file !== "cmds/router.ts") return true;

  return (
    ts.isFunctionDeclaration(node) &&
    node.parent === node.getSourceFile() &&
    (ts.getCombinedModifierFlags(node) & (ts.ModifierFlags.Export | ts.ModifierFlags.Default)) ===
      ts.ModifierFlags.Export
  );
}

function commandModulePath(node) {
  const parent = node.parent;
  return (
    [ts.isImportDeclaration, ts.isExportDeclaration].some((kind) => kind(parent)) ||
    (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) ||
    ts.isImportTypeNode(parent.parent)
  );
}

function entryFunction(node) {
  if (!node) return false;
  return isEntryHelper(node) || definedMainCallback(node);
}

function checkCommandImport(node) {
  if (!ts.isStringLiteral(node) || !commandModulePath(node)) return;

  for (const message of isolatedImport(root, pathOf(node), node.text, 1)) {
    fail(node, `base-import: ${message.slice(message.indexOf(" ") + 1)}`);
  }
  if (!isCommand(node)) return;

  const message = commandImport(node.text);
  if (message) fail(node, `command-import: ${message}`);
}

/** Each use of the declared name is a direct call, so the function never leaves its body. */
function calledOnly(node) {
  const symbol = symbolOf(node.name);
  let escaped = false;
  walk(node.parent, (use) => {
    if (escaped || !ts.isIdentifier(use) || use === node.name || symbolOf(use) !== symbol) return;
    if (!ts.isCallExpression(use.parent) || use.parent.expression !== use) escaped = true;
  });
  return !escaped;
}

/** Some enclosing function is the run of an operation. */
function insideRun(node) {
  for (let owner = enclosingFunction(node); owner; owner = enclosingFunction(owner)) {
    if (!optionsMember(owner) || nameOf(functionName(owner)) !== "run") continue;
    const member = ts.isPropertyAssignment(owner.parent) ? owner.parent : owner;
    if (coreSymbol(member.parent.parent.expression, "operation")) return true;
  }
  return false;
}

/** A function declared inside an operation's run and only called there belongs to that run. */
function runNested(node) {
  return ts.isFunctionDeclaration(node) && !!node.name && calledOnly(node) && insideRun(node);
}

function checkFunction(node) {
  if (!isFunction(node) || !node.body) return;
  if (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) return;

  if (entryFunction(node)) return;

  checkScopeReturn(node);

  if (isComponent(node)) {
    checkComponent(node);
    return;
  }

  if ([runNested, optionsMember, ownedMethod, nativeCallback].some((rule) => rule(node))) return;
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
    ) {
      request = true;
    }
    if (ts.isIdentifier(child) && requestSchema(variableInitializer(symbol), seen)) request = true;
  });

  return request;
}

function checkOperationInput(input) {
  if (requestSchema(input)) {
    fail(input, "operation-wire-input: requests belong to the protocol layer");
  }
}

function functionImplementation(node, seen = new Set()) {
  node = unwrap(node);
  if (!node || seen.has(node)) return undefined;
  seen.add(node);
  if (isFunction(node)) return node;

  const symbol = locationSymbol(node);
  if (symbol?.valueDeclaration && isFunction(symbol.valueDeclaration)) {
    return symbol.valueDeclaration;
  }

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
  if (implementation?.body) {
    walk(implementation.body, (child) => {
      checkOperationInputCast(child);
      if (ts.isExpression(child) && wireType(checker.getTypeAtLocation(child), "Response")) {
        response = true;
      }
    });
  }

  if (response) fail(run, "operation-wire-output: replies belong to the protocol layer");
}

/** The two named mounts: auth's `handleAuth` and the MCP set's `handleMcp`. */
function mountedDeclaration(node) {
  const name = nameOf(node.parent.name);
  if (authMountFiles.includes(pathOf(node))) return name === "handleAuth";

  return mcpMountFiles.includes(pathOf(node)) && name === "handleMcp";
}

function checkOperationWire(node) {
  if (!ts.isCallExpression(node) || !coreSymbol(node.expression, "operation")) return;
  if (mountedDeclaration(node)) return;

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
  for (const error of program.getSyntacticDiagnostics(source)) {
    fail(source, ts.flattenDiagnosticMessageText(error.messageText, " "));
  }
  walk(source, (node) => {
    checkCommandImport(node);
    checkCommandMain(node);
    checkOperationWire(node);
    checkFetch(node);
    checkBrowserHttp(node);
    checkHttpResource(node);
    checkHttpBackend(node);
    checkRequestHeaders(node);
    checkResponse(node);
    checkMountedAuth(node);
    checkMountedMcp(node);
    checkHttpImport(node);

    checkService(node);
    checkRoots(node);

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) fail(node, "no-class");
    checkFunction(node);
  });
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Plain check passed: ${sources.length} files, no plain functions.`);

if (process.argv.includes("--prove")) {
  const planted = await mkdtemp(join(tmpdir(), "start-plain-red-"));

  const cases = [
    [
      "database-owned-listener-allowed",
      null,
      'import {resource} from "@tinker/core"; import {database} from "~/components/database/index.server"; export const probe=resource({depends:{database},factory:({database},{clock})=>database.listen("probe",()=>{clock.currentTimeMillis();},()=>{clock.currentTimeMillis();})});',
    ],
    [
      "unowned-listener-forbidden",
      "plain-function",
      'import {resource} from "@tinker/core"; const local={listen(_channel:string,heard:()=>void){heard();}}; export const probe=resource({factory:()=>local.listen("probe",()=>{})});',
    ],
    ...["worker", "cli"].map((role) => [
      `${role}-defined-main-allowed`,
      null,
      'import {defineMain} from "~/base/main"; export default defineMain(async({exit})=>{exit(64);return {closed:Promise.resolve()};});',
      `cmds/check-${role}.ts`,
    ]),
    [
      "bare-process-main",
      "command-main",
      "export default async function main(){return {closed:Promise.resolve()};}",
      "cmds/check-old-main.ts",
    ],
    [
      "mail-net-static-import",
      "http-client",
      'import * as forbiddenNet from "node:net"; export { forbiddenNet };',
      "tinker/components/mail/modules.ts",
    ],
    [
      "mail-other-native-module",
      "http-client",
      'import {resource} from "@tinker/core"; export const forbiddenTls = resource({factory: () => import("node:tls")});',
      "tinker/components/mail/modules.ts",
    ],
    [
      "local-resource-return-allowed",
      null,
      'import {resource} from "@tinker/core"; export const probe=resource({label:"probe",factory:(_,{clock})=>{const handle=Object.assign({}, {read(){return clock.currentTimeMillis();}});return handle;}});',
    ],
    [
      "local-operation-return-forbidden",
      "plain-function",
      'import {operation} from "@tinker/core"; export const probe=operation({label:"probe",run:()=>{const handle=Object.assign({}, {read(){return Date.now();}});return handle.read();}});',
    ],
    [
      "resource-method-options-allowed",
      null,
      'import {resource,operation} from "@tinker/core"; const sender=resource({label:"probe.sender",factory:()=>({send(options:{done:()=>number}){return options.done();}})});export const probe=operation({label:"probe",depends:{sender},run:({sender},{clock})=>sender.send({done:()=>clock.currentTimeMillis()})});',
    ],
    [
      "real-main-marker-allowed",
      null,
      'import {defineMain} from "~/base/main"; export default defineMain(async({exit})=>{exit(0);return {closed:Promise.resolve()};});',
      "cmds/plain-probe.ts",
    ],
    [
      "fake-main-marker-forbidden",
      "service-owner",
      "const defineMain=(fn:()=>unknown)=>fn; export default defineMain(()=>new AbortController());",
      "cmds/plain-probe.ts",
    ],
    [
      "foreign-lease-name-forbidden",
      "plain-function",
      "export function leaseFrom(){return Date.now();}",
    ],

    [
      "zod-catch-name-callback-allowed",
      null,
      'import {z} from "zod"; export const probe = z.object({name: z.string()}).catch(() => ({name: "fallback"}));',
    ],
    [
      "foreign-catch-builder",
      "module-effect",
      "export const probe = Promise.resolve(1).catch(() => 2);",
    ],
    [
      "telemetry-extra-url",
      "module-effect",
      'const probe = new URL("https://extra.example");',
      "tinker/components/telemetry/settings.ts",
    ],
    [
      "src-url-default",
      "module-effect",
      'import {tag} from "@tinker/core"; const tracesUrl = tag<URL>({label: "probe", default: new URL("https://extra.example")});',
    ],
    [
      "telemetry-raw-backend-foreign",
      "http-backend",
      'import {httpBackend} from "~/components/http"; export const probe = httpBackend;',
      "tinker/components/telemetry/backend-probe.ts",
    ],
    [
      "core-config-declarations-allowed",
      null,
      'import {namespace, tag} from "@tinker/core"; const setting = tag<number>({label: "probe"}); export const probe = namespace({tags: [setting(3)]});',
    ],
    [
      "fake-tag-binding-module",
      "module-effect",
      "const tag = (value: number) => value; export const probe = tag(3);",
    ],
    [
      "namespace-options-no-callback",
      "plain-function",
      'import {namespace} from "@tinker/core"; export const probe = namespace({factory: async () => {await Promise.resolve(); return 1;}});',
    ],

    [
      "auth-mount-other-operation",
      "operation-wire-input",
      "const probe = operation({input: z.instanceof(Request), run: () => true});",
      "tinker/components/auth/handle.server.ts",
    ],
    [
      "mcp-mount-other-operation",
      "operation-wire-input",
      "const probe = operation({input: z.instanceof(Request), run: () => true});",
      "tinker/components/mcp/handle.server.ts",
    ],
    [
      "mcp-handle-response-outside",
      "protocol-response",
      "export const probe = () => new Response(null, { status: 405 });",
      "tinker/components/mcp/handle.server.ts",
    ],
    [
      "mcp-mount-response-elsewhere",
      "protocol-response",
      "export const probe = () => new Response(null, { status: 405 });",
      "tinker/components/mcp/tools.server.ts",
    ],
    [
      "mounted-mcp-userland",
      "protocol-mcp",
      'import {operation} from "@tinker/core"; import {handleMcp} from "~/components/mcp/index.server"; const probe = operation({depends: {mounted: handleMcp.controller}, run: () => 1});',
      "src/backend/plain-probe.ts",
    ],
    [
      "http-owner-extra-fetch",
      "http-request",
      "export const extraFetch = fetch;",
      "tinker/components/http/backend.ts",
    ],
    [
      "http-owner-other-tag-default",
      "http-request",
      'const otherBackend = tag<typeof fetch>({label: "other", default: (input, init) => fetch(input, init)});',
      "tinker/components/http/backend.ts",
    ],
    [
      "http-outside-default",
      "http-request",
      'import {tag} from "@tinker/core"; const httpBackend = tag<typeof fetch>({label: "http.backend", default: (input, init) => fetch(input, init)});',
      "src/other-http-default.ts",
    ],
    ...[
      ["component", "tinker/components/entry-probe/index.ts"],
      ["src", "src/entry-probe.ts"],
      ["unnamed-base", "tinker/base/entry-probe.ts"],
      ["cmd", "cmds/entry-probe.ts"],
    ].flatMap(([place, file]) => [
      [
        `${place}-entry-await`,
        "plain-function",
        "export async function createStartEntry() { await Promise.resolve(); return {}; }",
        file,
      ],
      [
        `${place}-entry-handle`,
        "plain-function",
        'import type { Scope } from "@tinker/core"; export function createServerHandler(scope: Scope.Handle) { return scope.resolve; }',
        file,
      ],
    ]),
    [
      "named-base-other-function",
      "plain-function",
      "export async function unrelatedFeature() { await Promise.resolve(); }",
      "tinker/base/start-entry.ts",
    ],
    ...[
      [
        "server-main-other-command",
        "cmds/other-server.ts",
        "export default async function main() { await Promise.resolve(); }",
      ],
      [
        "server-main-component",
        "tinker/components/entry-probe/index.ts",
        "export default async function main() { await Promise.resolve(); }",
      ],
      [
        "server-main-src",
        "src/entry-probe.ts",
        "export default async function main() { await Promise.resolve(); }",
      ],
      [
        "server-main-shadowed",
        "cmds/server.ts",
        "function anotherEntry() { return async function main() { await Promise.resolve(); }; }",
      ],
      [
        "server-other-function",
        "cmds/server.ts",
        "async function otherFeature() { await Promise.resolve(); }",
      ],
      [
        "server-nested-host-callback",
        "cmds/server.ts",
        "const hidden = {start: async () => { await Promise.resolve(); }};",
      ],
      [
        "server-private-main",
        "cmds/server.ts",
        "async function main() { await Promise.resolve(); }",
      ],
      [
        "server-named-main",
        "cmds/server.ts",
        "export async function main() { await Promise.resolve(); }",
      ],
      ...["start", "fetch", "close"].map((name) => [
        `server-removed-${name}`,
        "cmds/server.ts",
        `async function ${name}() { await Promise.resolve(); }`,
      ]),
    ].map(([name, file, code]) => [name, "plain-function", code, file]),
    [
      "router-command-other-function",
      "plain-function",
      "export async function unrelatedFeature() { await Promise.resolve(); }",
      "cmds/router.ts",
    ],
    [
      "router-command-shadowed-getRouter",
      "plain-function",
      "function anotherEntry() { return async function getRouter() { await Promise.resolve(); }; }",
      "cmds/router.ts",
    ],
    [
      "router-name-other-command",
      "plain-function",
      "export async function getRouter() { await Promise.resolve(); }",
      "cmds/other-router.ts",
    ],
    [
      "copied-router-cannot-open-root",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; export const hidden = resource({ factory: () => createScope() });',
      "tinker/base/router-entry.tsx",
    ],
    [
      "fake-start-entry-callback",
      "plain-function",
      "function createStartEntry(read: () => Promise<void>) { return read; } export const hidden = createStartEntry(async () => { await Promise.resolve(); });",
      "cmds/start-probe.ts",
    ],
    [
      "fake-once-callback",
      "plain-function",
      "function once(action: () => Promise<void>) { return action; } export const hidden = once(async () => { await Promise.resolve(); });",
      "cmds/once-probe.ts",
    ],
    [
      "unknown-base-root",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; export const root = createScope();',
      "tinker/base/feature-probe.ts",
    ],
    [
      "unknown-base-response",
      "protocol-response",
      'export const reply = new Response("wire");',
      "tinker/base/feature-probe.ts",
    ],
    ["command-package-import", "command-import", 'import "node:fs";', "cmds/cli-import-probe.ts"],
    ["src-base-import", "base-import", 'import "~/base/server";', "src/base-import-probe.ts"],
    [
      "component-base-import",
      "base-import",
      'import "../../base/server";',
      "tinker/components/base-probe/index.ts",
    ],
    ["nested-command", "nested-command", 'import "node:fs";', "cmds/lib/nested-probe.ts"],

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
      "requests-extra-response",
      "protocol-response",
      "export type Probe = Response;",
      "tinker/components/requests/plain-probe.ts",
    ],
    [
      "requests-extra-headers",
      "protocol-headers",
      'import {operation} from "@tinker/core"; import {requestHeaders} from "./headers.server"; const probe = operation({depends: {headers: requestHeaders}, run: ({headers}) => headers.get("x")});',
      "tinker/components/requests/plain-probe.ts",
    ],
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
      'import {operation} from "@tinker/core"; import * as t from "~/components/requests/index.server"; const key = "requestHeaders" as const; const probe = operation({depends: {headers: t[key]}, run: ({headers}) => headers.get("x")});',
      "src/backend/plain-probe.ts",
    ],
    [
      "http-backend-constant-key",
      "http-backend",
      'import {operation} from "@tinker/core"; import * as t from "~/components/http"; const key = "httpBackend" as const; const probe = operation({depends: {send: t[key]}, run: () => 1});',
    ],
    [
      "operation-request-custom-reader",
      "operation-wire-input",
      'import {operation} from "@tinker/core"; import {z} from "zod"; type R = Request; const probe = operation({input: (value: unknown) => z.custom<R>().parse(value), run: (_deps, ctx) => ctx.input.url});',
    ],

    [
      "mounted-auth-bracket",
      "protocol-auth",
      'import {operation} from "@tinker/core"; import * as protocol from "~/components/auth/index.server"; const probe = operation({depends: {mounted: protocol["handleAuth"].controller}, run: () => 1});',
      "src/backend/plain-probe.ts",
    ],
    [
      "request-headers-bracket",
      "protocol-headers",
      'import {operation} from "@tinker/core"; import * as protocol from "~/components/requests/index.server"; const probe = operation({depends: {headers: protocol["requestHeaders"]}, run: ({headers}) => headers.get("x")});',
      "src/backend/plain-probe.ts",
    ],

    [
      "mounted-auth-testing",
      "protocol-auth",
      'import {operation} from "@tinker/core"; import {handleAuth} from "~/components/auth/index.server"; const probe = operation({depends: {mounted: handleAuth.controller}, run: () => 1});',
      "src/backend/plain-probe.ts",
    ],
    [
      "mounted-auth-direct",
      "protocol-auth",
      'import {operation} from "@tinker/core"; import {handleAuth} from "~/components/auth/index.server"; const probe = operation({depends: {mounted: handleAuth.controller}, run: () => 1});',
      "src/backend/plain-probe.ts",
    ],
    [
      "mounted-auth-userland",
      "protocol-auth",
      'import {operation} from "@tinker/core"; import {handleAuth} from "~/components/auth/index.server"; const probe = operation({depends: {mounted: handleAuth.controller}, run: () => 1});',
      "src/plain-probe.ts",
    ],

    [
      "request-headers-testing",
      "protocol-headers",
      'import {operation} from "@tinker/core"; import {requestHeaders} from "~/components/requests/index.server"; const probe = operation({depends: {headers: requestHeaders}, run: ({headers}) => headers.get("x")});',
      "src/backend/plain-probe.ts",
    ],
    [
      "request-headers-direct",
      "protocol-headers",
      'import {operation} from "@tinker/core"; import {requestHeaders} from "~/components/requests/index.server"; const probe = operation({depends: {headers: requestHeaders}, run: ({headers}) => headers.get("x")});',
      "src/backend/plain-probe.ts",
    ],
    [
      "request-headers-userland",
      "protocol-headers",
      'import {operation} from "@tinker/core"; import {requestHeaders} from "~/components/requests/index.server"; const probe = operation({depends: {headers: requestHeaders}, run: ({headers}) => headers.get("x")});',
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
      'import {operation} from "@tinker/core"; import {httpBackend as backend} from "~/components/http"; const probe = operation({depends: {send: backend}, run: ({send}) => send("https://example.test/x")});',
    ],
    [
      "http-resource-dependency",
      "http-resource",
      'import {operation} from "@tinker/core"; import {http as client} from "~/components/http/index.server"; const probe = operation({depends: {client}, run: ({client}) => client.send("https://example.test/x", {method: "GET", signal: new AbortController().signal})});',
    ],
    [
      "http-resource-export",
      "http-resource",
      'export {http} from "~/components/http/index.server";',
    ],
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
      "plain-function",
      "const helpers = {async fetch(signal: AbortSignal) { await Promise.resolve(signal); }};",
      "src/server.ts",
    ],
    [
      "wrapped-factory",
      "plain-function",
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
      "plain-function",
      'import type {Resource} from "@tinker/core"; function probe(value: Resource.Handle<unknown>) {return value;} probe(null!); probe(null!);',
    ],
    ["class", "no-class", "class Probe {}"],
    [
      "clock",
      "plain-function",
      'import type { Clock } from "@tinker/core"; function probe(value: Clock.Handle) { return value; } probe(null!); probe(null!);',
    ],
    [
      "signal",
      "plain-function",
      "type Stop = AbortSignal; function probe(value: Stop) { return value; } probe(null!); probe(null!);",
    ],
    [
      "handle",
      "plain-function",
      'import type { Scope } from "@tinker/core"; function probe(value: Scope.Handle) { return value; } probe(null!); probe(null!);',
    ],
    ["ctx", "plain-function", "function probe(ctx: unknown) { return ctx; } probe(1); probe(2);"],
    [
      "io",
      "plain-function",
      'import type { IncomingMessage } from "node:http"; function probe(value: IncomingMessage) { return value; } probe(null!); probe(null!);',
    ],
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
      "plain-function",
      "function probe(value: () => void) { return value; } probe(() => {}); probe(() => {});",
    ],
    [
      "clock-bag",
      "plain-function",
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
      "plain-function",
      "async function probe(value: number) { return await Promise.resolve(value); } probe(1); probe(2);",
    ],
    ["class-expression", "no-class", "const probe = class {};"],
    [
      "object-arrow",
      "plain-function",
      'import type { Clock } from "@tinker/core"; export const helpers = { tick: async (clock: Clock.Handle, signal: AbortSignal) => { await clock.sleep(1, signal); } };',
    ],
    [
      "object-method",
      "plain-function",
      'import type { Clock } from "@tinker/core"; export const helpers = { async tick(clock: Clock.Handle, signal: AbortSignal) { await clock.sleep(1, signal); } };',
    ],
    [
      "freeze-arrow",
      "plain-function",
      'import type { Clock } from "@tinker/core"; export const tick = Object.freeze(async (clock: Clock.Handle, signal: AbortSignal, a: number, b: number) => { await clock.sleep(a+b, signal); });',
    ],
    [
      "hidden-method",
      "plain-function",
      'import { resource } from "@tinker/core"; export const probe = resource({factory: (_deps, ctx) => { const hidden = {async wait(clock: typeof ctx.clock, signal: AbortSignal, a: number, b: number) { await clock.sleep(a+b, signal); }}; return { go: (s: AbortSignal) => hidden.wait(ctx.clock, s, 1, 2) }; }});',
    ],
    ["or-arrow", "plain-function", "const probe = undefined || ((v: AbortSignal) => v);"],
    ["nullish-arrow", "plain-function", "const probe = undefined ?? ((v: AbortSignal) => v);"],
    [
      "src-callback",
      "plain-function",
      "function take(v: unknown) { return v; } take((v: AbortSignal) => v);",
    ],
    [
      "cmd-cli-scope",
      undefined,
      'import { createScope } from "@tinker/core"; const root = createScope({}); await root.ready; await root.close({ graceful: true });',
      "cmds/cli-probe.ts",
    ],
    [
      "cmd-worker-scope",
      undefined,
      'import { createScope } from "@tinker/core"; const root = createScope({}); await root.ready; await root.close({ graceful: true });',
      "cmds/worker-probe.ts",
    ],
    [
      "component-scope",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; createScope({});',
      "tinker/components/sync/scope-probe.ts",
    ],
    [
      "nested-command-scope",
      "scope-entry-only",
      'import { createScope } from "@tinker/core"; createScope({});',
      "cmds/nested/scope-probe.ts",
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
    ["plain-any", "plain-function", "function probe(v: any) { return v; } probe(1); probe(2);"],
    [
      "plain-generic",
      "plain-function",
      "function probe<T>(v: T) { return v; } probe(1); probe(2);",
    ],
    [
      "plain-unknown-cast",
      "plain-function",
      'import type { Clock } from "@tinker/core"; function probe(v: unknown) { return (v as Clock.Handle).currentTimeMillis(); } probe(1); probe(2);',
    ],
    [
      "request-options",
      "plain-function",
      "function probe(v: RequestInit) { return v; } probe({}); probe({});",
    ],
    [
      "pick-options",
      "plain-function",
      'function probe(v: Pick<RequestInit, "signal">) { return v; } probe({}); probe({});',
    ],
    [
      "event-options",
      "plain-function",
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
    [
      "zod-loose-object-allowed",
      null,
      'import { z } from "zod"; export const Probe = z.looseObject({ a: z.string() });',
    ],
    ["module-literal-set-allowed", null, 'export const words = new Set(["a", "b"]);'],
    ["module-literal-map-allowed", null, 'export const pairs = new Map([["a", 1], ["b", 2]]);'],
    [
      "module-set-from-call",
      "module-effect",
      'export const words = new Set(["a", "b"].map((w) => w));',
    ],
    [
      "module-set-mutated",
      "module-effect",
      'export const words = new Set(["a"]);\nwords.add("b");',
    ],
    [
      "module-set-read-allowed",
      null,
      'import {operation} from "@tinker/core"; export const words = new Set(["a", "b"]);\nexport const many = [...words].length + words.size;\nexport const probe = operation({run: () => words.has("a")});',
    ],
    [
      "module-set-from-binding",
      "module-effect",
      'const base = ["a"];\nexport const words = new Set(base);',
    ],
    [
      "module-set-paren-mutated",
      "module-effect",
      'export const words = new Set(["a"]);\nexport function grow() { (words).add("b"); }',
    ],
    [
      "module-set-passed",
      "module-effect",
      'export const words = new Set(["a"]);\nexport const probe = [words];',
    ],
    [
      "module-set-local-constructor",
      "module-effect",
      'function Set(values: string[]) { return values; }\nexport const words = new Set(["a"]);',
    ],
    [
      "run-nested-recursion-allowed",
      null,
      'import {operation} from "@tinker/core"; export const probe = operation({run: () => { function depth(n: number): number { return n <= 0 ? 0 : 1 + depth(n - 1); } return depth(3); }});',
    ],
    [
      "run-nested-escape-checked",
      "plain-effect",
      'import {operation} from "@tinker/core"; export const probe = operation({run: () => { function read() { return Date.now(); } return { read }; }});',
    ],
    [
      "module-recursion-still-helper",
      "plain-function",
      "export function depth(n: number): number { return n <= 0 ? 0 : 1 + depth(n - 1); }",
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
      "plain-function",
      `function probe() { return ${effect}; } probe(); probe();`,
    ]),
    [
      "src-resource-callback",
      "plain-function",
      'import {resource} from "@tinker/core"; const unit = resource({factory: () => ({ call: (fn: (signal: AbortSignal) => unknown) => fn(new AbortController().signal) })}); const callback = resource({depends: {unit}, factory: ({unit}) => unit.call((signal: AbortSignal) => signal)});',
    ],
  ];

  const names = process.argv
    .find((arg) => arg.startsWith("--cases="))
    ?.slice(8)
    .split(",");

  // A literal Set or Map case fails at its own line: the declaration, never the use.
  const collectionLines = new Map([
    ["module-set-mutated", "src/plain-probe.ts:1: module-effect"],
    ["module-set-paren-mutated", "src/plain-probe.ts:1: module-effect"],
    ["module-set-passed", "src/plain-probe.ts:1: module-effect"],
    ["module-set-from-binding", "src/plain-probe.ts:2: module-effect"],
    ["module-set-local-constructor", "src/plain-probe.ts:2: module-effect"],
  ]);
  const selected = names ? cases.filter(([name]) => names.includes(name)) : cases;
  if (names) assert.equal(selected.length, names.length, "unknown planted case");

  try {
    await cp(join(root, "src"), join(planted, "src"), { recursive: true });
    for (const file of [
      "tsconfig.json",
      "vite.config.ts",
      "cmds",
      "tinker",
      "package.json",
      ".tinker",
    ]) {
      await cp(join(root, file), join(planted, file), { recursive: true });
    }
    await cp(join(root, "tests"), join(planted, "tests"), { recursive: true });
    await symlink(join(root, "node_modules"), join(planted, "node_modules"), "dir");

    const generated = join(planted, ".tinker/tsconfig.json");
    await writeFile(generated, (await readFile(generated, "utf8")).replaceAll(root, planted));

    for (const [name, rule, source, file = "src/plain-probe.ts", replace] of selected) {
      const path = join(planted, file);
      const original = await readFile(path, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      await mkdir(dirname(path), { recursive: true });
      if (replace) assert.ok(original.includes(replace[0]), `${name}: ${file} lacks ${replace[0]}`);
      const base = replace ? original.replace(replace[0], replace[1]) : original;
      await writeFile(path, base + source + "\n");

      const red = spawnSync(process.execPath, [fileURLToPath(import.meta.url), planted], {
        encoding: "utf8",
      });
      const log = join(tmpdir(), `start-plain-proof-${name}.log`);
      await writeFile(log, red.stdout + red.stderr + `\nEXIT ${red.status}\n`);

      assert.equal(red.status, rule ? 1 : 0, name);
      if (rule) assert.ok(red.stderr.includes(rule), `${name}: must fail by ${rule}`);
      const line = collectionLines.get(name);
      if (line) {
        assert.ok(red.stderr.split("\n").includes(line), `must fail at ${line}`);
      }
      if (name === "src-base-import" || name === "component-base-import") {
        const owner = name === "src-base-import" ? "src" : "components";
        const specifier = name === "src-base-import" ? "~/base/server" : "../../base/server";
        assert.ok(
          red.stderr
            .split("\n")
            .includes(
              `${file}:1: base-import: "${specifier}" imports copied base code; ${owner} must not import tinker/base`,
            ),
        );
      }
      if (name === "command-package-import") {
        assert.ok(
          red.stderr.split("\n").includes(`${file}:1: command-import: ${commandImport("node:fs")}`),
        );
      }

      if (original) await writeFile(path, original);
      else await rm(path);

      console.log(`PASS: ${name} ${rule ?? "allowed"} EXIT ${red.status}; ${log}`);
    }

    console.log(`Plain proof passed: ${selected.length} planted cases.`);
  } finally {
    await rm(planted, { recursive: true, force: true });
  }
}
