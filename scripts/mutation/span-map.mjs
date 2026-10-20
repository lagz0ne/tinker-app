import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Test-only caller instrumentation; Core and its module exports stay untouched. */
export function spanRecorder({ app, events }) {
  const require = createRequire(resolve(app, "package.json"));

  const ts = require("typescript-api");

  const virtual = "virtual:mutation-observe";

  return {
    name: "mutation-span-recorder",
    enforce: "pre",
    resolveId(id) {
      if (id === virtual) return `\0${virtual}`;
    },
    load(id) {
      if (id !== `\0${virtual}`) return;

      return `import { createScope } from ${JSON.stringify(require.resolve("@tinker/core"))};
import { expect } from "vite-plus/test";
import { appendFileSync } from "node:fs";
export function tracedScope(options = {}) {
  const owner = expect.getState();
  const test = { file: owner.testPath, name: owner.currentTestName };
  const previous = options.observe;
  return createScope({ ...options, observe: { ...previous,
    log: previous?.log && ((entry) => {
      // Enabling spans also enables Core's automatic operation log. Preserve
      // the original log stream when this scope previously had tracing off.
      const automatic = !previous.export && !previous.history && entry.span?.kind === "operation" &&
        entry.message === entry.span.name && entry.attributes.outcome === entry.span.status && "ms" in entry.attributes;
      if (!automatic) previous.log(entry);
    }), export(span) {
    const current = test.name ? test : { file: expect.getState().testPath, name: expect.getState().currentTestName };
    if (current.name && current.file) appendFileSync(${JSON.stringify(events)}, JSON.stringify({ ...current, span: span.name }) + "\\n");
    previous?.export?.(span);
  } } });
}`;
    },
    transform(code, id) {
      if (
        id.includes("node_modules") ||
        !code.includes("createScope") ||
        !/\.[cm]?[jt]sx?(?:\?|$)/.test(id)
      ) {
        return;
      }

      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);

      const edits = source.statements
        .filter(ts.isImportDeclaration)
        .filter((statement) => statement.moduleSpecifier.text === "@tinker/core")
        .map((statement) => {
          const bindings = statement.importClause?.namedBindings;

          if (!bindings || !ts.isNamedImports(bindings)) return;

          const scope = bindings.elements.filter(
            (item) => (item.propertyName ?? item.name).text === "createScope",
          );

          if (!scope.length) return;

          const kept = bindings.elements.filter((item) => !scope.includes(item));

          const imports = kept.length
            ? `import { ${kept.map((item) => item.getText(source)).join(", ")} } from "@tinker/core";`
            : "";

          return {
            start: statement.getStart(source),
            end: statement.end,
            text: `${imports}\nimport { ${scope.map((item) => `tracedScope as ${item.name.text}`).join(", ")} } from "${virtual}";`,
          };
        })
        .filter(Boolean);

      for (const edit of edits.reverse()) {
        code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
      }

      return edits.length ? { code, map: null } : undefined;
    },
  };
}

/** Parse the checked-out graph, including imported/barrel handles, without loading live clients. */
export function handleGraph(app) {
  const require = createRequire(resolve(app, "package.json"));

  const ts = require("typescript-api");

  const config = ts.readConfigFile(resolve(app, "tsconfig.json"), ts.sys.readFile);

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, app);

  const program = ts.createProgram(parsed.fileNames, parsed.options);

  const checker = program.getTypeChecker();

  const nodes = [];

  const symbols = new Map();

  const symbolOf = (expression) => {
    let symbol = ts.isShorthandPropertyAssignment(expression.parent)
      ? checker.getShorthandAssignmentValueSymbol(expression.parent)
      : checker.getSymbolAtLocation(expression);

    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);

    return symbol;
  };

  // Both declarations and command seams need the same symbol walk.
  const references = (node) => {
    const result = [];

    const visit = (child) => {
      if (ts.isIdentifier(child)) result.push(symbolOf(child));

      ts.forEachChild(child, visit);
    };

    visit(node);

    return result;
  };

  for (const source of program.getSourceFiles()) {
    const file = relative(app, source.fileName).replaceAll("\\", "/");

    if (!/^(tinker|src|cmds)\//.test(file) || file.endsWith(".d.ts")) continue;

    const declarations = [];

    const exports = [];

    const visit = (node) => {
      if (ts.isVariableDeclaration(node)) declarations.push(node);

      if (ts.isExportAssignment(node)) exports.push(node);

      ts.forEachChild(node, visit);
    };

    visit(source);

    declarations
      .filter(
        (node) => ts.isIdentifier(node.name) && ts.isCallExpression(node.initializer ?? source),
      )
      .map((node) => ({
        node,
        call: node.initializer,
        factory:
          symbolOf(node.initializer.expression)?.name ??
          node.initializer.expression.getText(source),
      }))
      .filter(({ factory }) =>
        ["operation", "resource", "data", "tag", "extension", "createScope"].includes(factory),
      )
      .forEach(({ node, call, factory }) => {
        const options = call.arguments[0];

        const properties = ts.isObjectLiteralExpression(options ?? source)
          ? options.properties
          : [];

        const label = properties.find(
          (property) => property.name?.getText(source) === "label",
        )?.initializer;

        const depends = properties.find((property) => property.name?.getText(source) === "depends");

        const dependency = factory === "createScope" ? options : depends;

        const entry = {
          id: `${file}#${node.name.text}`,
          file,
          name: node.name.text,
          kind: factory,
          label: ts.isStringLiteralLike(label ?? source) ? label.text : undefined,
          start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          end: source.getLineAndCharacterOfPosition(node.end).line + 1,
          depends: [],
          callers: [],
          references: dependency ? references(dependency) : [],
        };

        nodes.push(entry);

        symbols.set(symbolOf(node.name), entry);
      });

    exports
      .filter(
        (node) =>
          file.startsWith("cmds/") && node.expression.getText(source).startsWith("defineMain("),
      )
      .forEach((node) => {
        nodes.push({
          id: `${file}#main`,
          file,
          name: "main",
          kind: "main",
          start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          end: source.getLineAndCharacterOfPosition(node.end).line + 1,
          depends: [],
          callers: [],
          references: references(node.expression),
        });
      });
  }

  for (const node of nodes) {
    node.depends = [
      ...new Set(node.references.map((symbol) => symbols.get(symbol)?.id).filter(Boolean)),
    ];

    delete node.references;

    for (const dependency of node.depends) {
      nodes.find((item) => item.id === dependency).callers.push(node.id);
    }
  }

  return nodes;
}

export function writeSpanMap(app, events, output) {
  const records = readFileSync(events, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const nodes = handleGraph(app);

  for (const node of nodes) {
    node.tests = [
      ...new Map(
        records
          .filter((row) => row.span === node.label)
          .map((row) => {
            const test = { file: relative(app, row.file).replaceAll("\\", "/"), name: row.name };

            return [JSON.stringify(test), test];
          }),
      ).values(),
    ];
  }

  const gaps = nodes
    .filter((node) => ["operation", "resource"].includes(node.kind) && !node.tests.length)
    .map((node) => node.id);

  const tests = [
    ...new Map(
      records.map(({ file, name }) => {
        const test = { file: relative(app, file).replaceAll("\\", "/"), name };

        return [JSON.stringify(test), test];
      }),
    ).values(),
  ];

  const result = { version: 1, nodes, gaps, tests };

  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");

  console.log(`Span map: ${nodes.length} nodes; ${gaps.length} gaps\n${gaps.join("\n")}`);

  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = resolve(process.argv[2] ?? "apps/issue-board");

  const output = resolve(process.argv[3] ?? resolve(app, "reports/mutation/span-map.json"));

  mkdirSync(dirname(output), { recursive: true });

  const events = `${output}.jsonl`;

  writeFileSync(events, "");

  const config = resolve(dirname(output), "map.config.mjs");

  const setup = resolve(dirname(output), "map.setup.mjs");

  writeFileSync(
    setup,
    `import { afterEach, expect } from "vite-plus/test";
import { appendFileSync } from "node:fs";
afterEach(() => { const state = expect.getState(); appendFileSync(${JSON.stringify(events)}, JSON.stringify({file: state.testPath, name: state.currentTestName, span: null}) + "\\n"); });\n`,
  );

  writeFileSync(
    config,
    `import { mergeConfig } from "vite-plus";
import base from ${JSON.stringify("./" + relative(dirname(config), resolve(app, "vite.config")).replaceAll("\\", "/"))};
import tests from ${JSON.stringify("./" + relative(dirname(config), resolve(app, "vitest.config.ts")).replaceAll("\\", "/"))};
import { spanRecorder } from ${JSON.stringify(import.meta.url)};
export default mergeConfig(mergeConfig(base, tests), { plugins: [spanRecorder(${JSON.stringify({ app, events })})], test: { setupFiles: [${JSON.stringify(setup)}], include: ["tests/**/*.test.{ts,tsx,mjs,js}"], maxWorkers: 1, fileParallelism: false } });\n`,
  );

  const result = spawnSync(
    "pnpm",
    ["exec", "vp", "test", "--config", config, "--maxWorkers=1", "--no-file-parallelism"],
    {
      cwd: app,
      stdio: "inherit",
      env: { ...process.env, VITEST_MAX_WORKERS: "1", VP_RUN_CONCURRENCY_LIMIT: "1" },
    },
  );

  unlinkSync(config);

  unlinkSync(setup);

  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else writeSpanMap(app, events, output);
}
