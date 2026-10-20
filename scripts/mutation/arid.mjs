import { createRequire } from "node:module";
import { resolve } from "node:path";

const app = createRequire(resolve("package.json"));
const stryker = createRequire(app.resolve("@stryker-mutator/core"));
const { declareValuePlugin, PluginKind } = stryker("@stryker-mutator/api/plugin");

/** Suppress only noise: logging, observation names, and timeout default literals. */
export function shouldIgnore(path) {
  for (let current = path; current; current = current.parentPath) {
    const { node } = current;
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const name = callee.type === "MemberExpression" ? callee.property.name : callee.name;
      const receiver = callee.object;
      if (
        name === "log" ||
        (["debug", "info", "warn", "error"].includes(name) &&
          (receiver?.name === "console" || receiver?.name === "log" ||
            receiver?.name === "logger" || receiver?.property?.name === "log"))
      ) return "arid: log call";
      if (name === "child" && node.arguments[0] === path.node && path.node.type === "StringLiteral") {
        return "arid: span name";
      }
    }
  }
  const parent = path.parentPath?.node;
  if (path.node.type === "StringLiteral" && parent?.type === "ObjectProperty") {
    if (parent.key.name === "label" && parent.value === path.node) return "arid: span label";
    if (parent.key === path.node) {
      const object = path.parentPath?.parentPath;
      const owner = object?.parentPath?.node;
      if (owner?.key?.name === "attributes" ||
          (owner?.type === "CallExpression" && ["attr", "attributes", "setAttribute"].includes(owner.callee.property?.name))) {
        return "arid: attribute name";
      }
    }
  }
  if (path.node.type === "NumericLiteral") {
    for (let current = path.parentPath; current; current = current.parentPath) {
      if (current.node.type === "VariableDeclarator") {
        if (/timeout|deadline|grace|budget/i.test(current.node.id.name ?? "")) {
          return "arid: timeout constant";
        }
        break;
      }
      if (["ArrowFunctionExpression", "FunctionExpression", "CallExpression"].includes(current.node.type)) break;
    }
  }
  return undefined;
}

export const strykerPlugins = [declareValuePlugin(PluginKind.Ignore, "arid", { shouldIgnore })];
