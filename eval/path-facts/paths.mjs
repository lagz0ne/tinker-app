// paths.mjs <ops.server.ts>...: scratch proof. Path facts per op, from the code alone.
// For each op it walks every path of the run body (if, ?:, &&, ||, early return, a loop as 0 or 1
// turn) and records the events in run order: a call of a dependency op, a read or a write of a
// dependency cell, and the exit. A call that hands a cell to unknown code counts as a "may" write
// and read (sound: too wide, never too narrow). It prints facts, not rules:
//   W <op> <exit> {cells written on some path to that exit}
//   O <op> <cell> read-before <check> : yes | no   (some path reads the cell before the call)
// Then a small join prints J1 and J6 as the CUJ doc would write them.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const ts = createRequire(import.meta.url)(join(homedir(), ".cuj-tools/node_modules/typescript"));

const CELL = /^(members|issues|comments)$/;

const propOf = (obj, name) =>
  obj.properties.find((p) => p.name && p.name.getText() === name);

const unwrap = (e) => {
  while (e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isNonNullExpression(e))) e = e.expression;
  return e;
};

const kindOf = (e) => {
  e = unwrap(e);
  if (e && ts.isObjectLiteralExpression(e)) {
    const k = propOf(e, "kind");
    if (k && ts.isPropertyAssignment(k)) {
      const v = unwrap(k.initializer);
      if (ts.isStringLiteral(v)) return v.text;
    }
    return "value";
  }
  if (e && ts.isCallExpression(e) && /refuse/.test(e.expression.getText())) return "refused";
  return e ? "value" : "void";
};

let checker;
const kindsByType = (e) => {
  const t = checker.getTypeAtLocation(e);
  const parts = t.isUnion() ? t.types : [t];
  const out = new Set();
  for (const part of parts) {
    const k = part.getProperty("kind");
    if (!k) return undefined;
    const kt = checker.getTypeOfSymbolAtLocation(k, e);
    for (const lit of kt.isUnion() ? kt.types : [kt]) {
      if (!lit.isStringLiteral()) return undefined;
      out.add(lit.value);
    }
  }
  return out.size ? [...out] : undefined;
};

function analyze(file) {
  const program = ts.createProgram([file], { noResolve: true, noEmit: true, target: ts.ScriptTarget.Latest, strict: true });
  checker = program.getTypeChecker();
  const src = program.getSourceFile(file);
  const ops = [];
  const labelOfVar = new Map();
  const imported = new Map();
  for (const st of src.statements) {
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      for (const el of st.importClause.namedBindings.elements) imported.set(el.name.getText(), (el.propertyName ?? el.name).getText());
    }
  }
  const visit = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText() === "operation" && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
      const obj = n.arguments[0];
      const label = propOf(obj, "label")?.initializer?.text;
      const decl = n.parent && ts.isVariableDeclaration(n.parent) ? n.parent.name.getText() : undefined;
      if (label && decl) labelOfVar.set(decl, label);
      ops.push({ label, obj });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);

  return ops.filter((o) => o.label).map(({ label, obj }) => {
    const deps = new Map();
    const dp = propOf(obj, "depends");
    if (dp && ts.isPropertyAssignment(dp) && ts.isObjectLiteralExpression(dp.initializer)) {
      for (const p of dp.initializer.properties) {
        const key = p.name.getText();
        const val = ts.isShorthandPropertyAssignment(p) ? p.name.getText() : p.initializer.getText();
        const local = val.match(/^(\w+)(\.controller)?$/)?.[1];
        const cell = local ? (imported.get(local) ?? local) : undefined;
        if (cell && CELL.test(cell)) deps.set(key, { cell });
        else if (local && labelOfVar.has(local)) deps.set(key, { op: labelOfVar.get(local) });
        else if (!/\.required$|\.optional$/.test(val)) deps.set(key, { cell: "?", op: "?" });
      }
    }
    const runP = propOf(obj, "run");
    const fn = runP && (ts.isPropertyAssignment(runP) ? runP.initializer : runP);
    const alias = new Map();
    const p0 = fn?.parameters?.[0];
    if (p0 && ts.isObjectBindingPattern(p0.name)) {
      for (const el of p0.name.elements) {
        const key = (el.propertyName ?? el.name).getText();
        if (deps.has(key)) alias.set(el.name.getText(), deps.get(key));
      }
    }
    const paths = walkFn(fn, alias);
    return { label, paths };
  });
}

/** Paths: arrays of events. An event: {t:"call",op} {t:"read",cell} {t:"write",cell} {t:"may",cell} {t:"exit",kind}. */
function walkFn(fn, alias) {
  if (!fn) return [];
  const done = [];
  const lineOf = (n) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;

  const expr = (e, paths) => {
    if (!e || !paths.length) return paths;
    e = unwrap(e);
    if (ts.isConditionalExpression(e)) {
      const c = expr(e.condition, paths);
      return [...expr(e.whenTrue, c.map((p) => [...p])), ...expr(e.whenFalse, c.map((p) => [...p]))];
    }
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
      const l = expr(e.left, paths);
      return [...l.map((p) => [...p]), ...expr(e.right, l.map((p) => [...p]))];
    }
    if (ts.isCallExpression(e)) {
      let ps = expr(e.expression, paths);
      for (const a of e.arguments) ps = expr(a, ps);
      const callee = e.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.getText();
        const base = unwrap(callee.expression);
        const root = ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) ? unwrap(base.expression.expression) : base;
        const d = ts.isIdentifier(root) ? alias.get(root.getText()) : undefined;
        if (d?.op && m === "run" && ts.isIdentifier(base)) return ps.map((p) => [...p, { t: "call", op: d.op, line: lineOf(e) }]);
        if (d?.cell && m === "set" && ts.isIdentifier(base)) return ps.map((p) => [...p, { t: "write", cell: d.cell, line: lineOf(e) }]);
        if (d?.cell && ["of", "where"].includes(m) && ts.isIdentifier(base)) return ps.map((p) => [...p, { t: "read", cell: d.cell, line: lineOf(e) }]);
      }
      const handed = e.arguments.map(unwrap).filter((a) => ts.isIdentifier(a) && alias.get(a.getText())?.cell);
      if (handed.length) return ps.map((p) => [...p, ...handed.map((a) => ({ t: "may", cell: alias.get(a.getText()).cell, line: lineOf(e) }))]);
      return ps;
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      const found = [];
      const scan = (n) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const base = unwrap(n.expression.expression);
          const d = ts.isIdentifier(base) ? alias.get(base.getText()) : undefined;
          const m = n.expression.name.getText();
          if (d?.cell && m === "set") found.push({ t: "may", cell: d.cell, line: lineOf(n) });
          if (d?.cell && ["of", "where"].includes(m)) found.push({ t: "read", cell: d.cell, line: lineOf(n) });
        }
        ts.forEachChild(n, scan);
      };
      scan(e.body);
      return paths.map((p) => [...p, ...found]);
    }
    let ps = paths;
    ts.forEachChild(e, (c) => {
      if (ts.isExpression(c)) ps = expr(c, ps);
    });
    return ps;
  };

  const ret = (e, paths) => {
    e = unwrap(e);
    if (e && ts.isConditionalExpression(e)) {
      const c = expr(e.condition, paths);
      ret(e.whenTrue, c.map((p) => [...p]));
      ret(e.whenFalse, c.map((p) => [...p]));
      return;
    }
    const direct = kindOf(e);
    const kinds = direct === "value" && e ? (kindsByType(e) ?? ["value"]) : [direct];
    for (const p of expr(e, paths)) for (const kind of kinds) done.push([...p, { t: "exit", kind }]);
  };

  const stmt = (s, paths) => {
    if (!paths.length) return paths;
    if (ts.isBlock(s)) return s.statements.reduce((ps, x) => stmt(x, ps), paths);
    if (ts.isReturnStatement(s)) {
      ret(s.expression, paths);
      return [];
    }
    if (ts.isIfStatement(s)) {
      const c = expr(s.expression, paths);
      const a = stmt(s.thenStatement, c.map((p) => [...p]));
      const b = s.elseStatement ? stmt(s.elseStatement, c.map((p) => [...p])) : c.map((p) => [...p]);
      return [...a, ...b];
    }
    if (ts.isVariableStatement(s)) return s.declarationList.declarations.reduce((ps, d) => expr(d.initializer, ps), paths);
    if (ts.isExpressionStatement(s)) return expr(s.expression, paths);
    if (ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isForStatement(s) || ts.isWhileStatement(s)) {
      const head = ts.isForStatement(s) ? expr(s.condition, paths) : expr(s.expression, paths);
      return [...head.map((p) => [...p]), ...stmt(s.statement, head.map((p) => [...p]))];
    }
    if (ts.isTryStatement(s)) return stmt(s.tryBlock, paths);
    if (ts.isThrowStatement(s)) {
      for (const p of expr(s.expression, paths)) done.push([...p, { t: "exit", kind: "throw" }]);
      return [];
    }
    if (ts.isSwitchStatement(s)) {
      const c = expr(s.expression, paths);
      return s.caseBlock.clauses.flatMap((cl) => cl.statements.reduce((ps, x) => stmt(x, ps), c.map((p) => [...p])));
    }
    return paths;
  };

  if (ts.isBlock(fn.body)) {
    for (const p of stmt(fn.body, [[]])) done.push([...p, { t: "exit", kind: "void" }]);
  } else ret(fn.body, [[]]);
  return done;
}

const CHECK = "issues.inTeam";
for (const file of process.argv.slice(2)) {
  const app = basename(file, ".ts");
  const facts = [];
  const j1 = [];
  const j1u = [];
  const j6 = [];
  const j6u = [];
  for (const { label, paths } of analyze(file)) {
    const byExit = new Map();
    for (const p of paths) {
      const exit = p.at(-1).kind;
      const w = byExit.get(exit) ?? new Set();
      for (const ev of p) if (ev.t === "write" || ev.t === "may") w.add(`${ev.cell}${ev.t === "may" ? "?" : ""}@${ev.line}`);
      byExit.set(exit, w);
    }
    for (const [exit, w] of byExit) {
      facts.push(`W ${label} ${exit} {${[...w].join(",")}}`);
      if (["gone", "stale", "exists"].includes(exit) && w.size) j1.push(`${label} ${exit} writes ${[...w].join(",")}`);
      if (exit === "value" && w.size && !/^issues\.(signedIn|membersOnly|inTeam)$/.test(label)) j1u.push(`${label} exit of unknown kind writes ${[...w].join(",")}`);
    }
    const early = new Set();
    const unsure = new Set();
    for (const p of paths) {
      const iRead = p.findIndex((ev) => (ev.t === "read" || ev.t === "may") && (ev.cell === "issues" || ev.cell === "?"));
      if (iRead < 0) continue;
      const iCheck = p.findIndex((ev) => ev.t === "call" && ev.op === CHECK);
      const iUnknown = p.findIndex((ev) => ev.t === "call" && ev.op === "?");
      if (iCheck >= 0 && iCheck < iRead) continue;
      if (p[iRead].cell === "?" || (iUnknown >= 0 && iUnknown < iRead)) unsure.add(p[iRead].line);
      else early.add(p[iRead].line);
    }
    const readsIssues = paths.some((p) => p.some((ev) => ev.t === "read" && (ev.cell === "issues" || ev.cell === "?")));
    if (readsIssues) facts.push(`O ${label} issues read-before ${CHECK}: ${early.size ? `yes @${[...early].join(",")}` : "no"}`);
    if (early.size && label !== CHECK) j6.push(`${label} reads issues before the check @${[...early].join(",")}`);
    if (unsure.size && label !== CHECK) j6u.push(`${label} unknown dependency before the read @${[...unsure].join(",")}`);
  }
  console.log(`== ${app}`);
  for (const f of facts) console.log(`  ${f}`);
  console.log(`  J1 ${j1.length ? `VIOLATION ${j1.join("; ")}` : j1u.length ? `UNSURE ${j1u.join("; ")}` : "OK"}`);
  console.log(`  J6 ${j6.length ? `VIOLATION ${j6.join("; ")}` : j6u.length ? `UNSURE ${j6u.join("; ")}` : "OK"}`);
}
