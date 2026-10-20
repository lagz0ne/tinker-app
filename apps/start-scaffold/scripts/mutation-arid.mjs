import { createRequire } from "node:module";
import { resolve } from "node:path";

const app = createRequire(resolve("package.json"));
const stryker = createRequire(app.resolve("@stryker-mutator/core"));
const { declareValuePlugin, PluginKind } = stryker("@stryker-mutator/api/plugin");

// Babel path matchers are Stryker's native ignorer seam. Keep each rule narrow:
// names and timeout literals are noise; values and business bounds are not.
const rules = [
  {
    reason: "arid: log call",
    match: (path) =>
      path.find((current) => {
        if (!current.isCallExpression()) return false;

        const callee = current.get("callee");
        if (callee.isIdentifier({ name: "log" })) return true;
        if (!callee.isMemberExpression()) return false;

        const receiver = callee.get("object");
        const name = callee.node.property.name;
        if (name === "log") return !receiver.isIdentifier({ name: "Math" });
        if (!["debug", "info", "warn", "error"].includes(name)) return false;
        return (
          ["console", "log", "logger"].some((name) => receiver.isIdentifier({ name })) ||
          receiver.node.property?.name === "log"
        );
      }),
  },
  {
    reason: "arid: span name",
    match(path) {
      if (!path.isStringLiteral()) return false;
      const parent = path.parentPath;
      if (!parent.isCallExpression()) return false;
      return (
        parent.node.arguments[0] === path.node &&
        parent.get("callee").isMemberExpression() &&
        parent.get("callee.property").isIdentifier({ name: "child" })
      );
    },
  },
  {
    reason: "arid: span label",
    match(path) {
      if (!path.isStringLiteral()) return false;
      const parent = path.parentPath;
      return (
        parent.isObjectProperty() &&
        parent.get("key").isIdentifier({ name: "label" }) &&
        parent.node.value === path.node
      );
    },
  },
  {
    reason: "arid: attribute name",
    match(path) {
      if (!path.isStringLiteral()) return false;
      const parent = path.parentPath;
      if (!parent.isMemberExpression()) return false;
      return (
        parent.node.property === path.node &&
        parent.get("object").isMemberExpression() &&
        parent.get("object.property").isIdentifier({ name: "attributes" })
      );
    },
  },
  {
    reason: "arid: attribute name",
    match(path) {
      if (!path.isStringLiteral()) return false;
      const parent = path.parentPath;
      if (!parent.isCallExpression()) return false;
      return (
        parent.node.arguments[0] === path.node &&
        ["attr", "setAttribute"].includes(parent.node.callee.property?.name)
      );
    },
  },
  {
    reason: "arid: attribute name",
    match(path) {
      if (!path.isStringLiteral()) return false;
      const parent = path.parentPath;
      if (!parent.isObjectProperty()) return false;
      if (parent.node.key !== path.node) return false;

      const owner = parent.parentPath.parentPath;
      return owner.isObjectProperty() && owner.get("key").isIdentifier({ name: "attributes" });
    },
  },
  {
    reason: "arid: attribute name",
    match(path) {
      if (!path.isStringLiteral()) return false;
      const parent = path.parentPath;
      if (!parent.isObjectProperty()) return false;
      if (parent.node.key !== path.node) return false;

      const owner = parent.parentPath.parentPath;
      return (
        owner.isCallExpression() &&
        ["attr", "attributes", "setAttribute"].includes(owner.node.callee.property?.name)
      );
    },
  },
  {
    reason: "arid: timeout constant",
    match(path) {
      if (!path.isNumericLiteral()) return false;
      const owner = path.findParent((current) =>
        [
          "VariableDeclarator",
          "ArrowFunctionExpression",
          "FunctionExpression",
          "CallExpression",
        ].includes(current.node.type),
      );
      return (
        owner?.isVariableDeclarator() &&
        /timeout|deadline|grace|budget/i.test(owner.node.id.name ?? "")
      );
    },
  },
];

/** Stryker's ignorer hook; the reason also appears in its mutation report. */
export const shouldIgnore = (path) => rules.find((rule) => rule.match(path))?.reason;

export const strykerPlugins = [declareValuePlugin(PluginKind.Ignore, "arid", { shouldIgnore })];
