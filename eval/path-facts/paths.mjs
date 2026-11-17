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
  const tagOfVar = new Map();
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
    if (ts.isCallExpression(n) && n.expression.getText() === "tag" && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
      const label = propOf(n.arguments[0], "label")?.initializer?.text;
      const decl = n.parent && ts.isVariableDeclaration(n.parent) ? n.parent.name.getText() : undefined;
      if (label && decl) tagOfVar.set(decl, label);
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
        else if (local && tagOfVar.has(local)) deps.set(key, { tag: tagOfVar.get(local) });
        else if (/^(\w+)\.(required|optional)$/.test(val)) {
          const name = val.split(".")[0];
          deps.set(key, { tag: tagOfVar.get(name) ?? imported.get(name) ?? name });
        } else deps.set(key, { cell: "?", op: "?" });
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
    return { label, paths, data: dataFacts(fn, alias) };
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


/** Data facts: the key of each read and the source of each written field, one level of
 *  local consts deep. A source is `input.x`, `tag:<label>`, `read:<cell>{keys}`, `random`,
 *  `literal`, or `?` (the code hands it through something this script does not follow). */
function dataFacts(fn, alias) {
  if (!fn) return { reads: [], writes: [] };
  const local = new Map();
  const p1 = fn.parameters?.[1];
  const ctxNames = new Set();
  if (p1 && ts.isObjectBindingPattern(p1.name)) for (const el of p1.name.elements) ctxNames.add(el.name.getText());
  const scanDecl = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name)) local.set(n.name.getText(), n.initializer);
      else if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) local.set(el.name.getText(), { from: n.initializer, field: (el.propertyName ?? el.name).getText() });
      }
    }
    if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer)) {
      for (const d of n.initializer.declarations) if (ts.isIdentifier(d.name)) local.set(d.name.getText(), n.expression);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
      (more.get(n.left.getText()) ?? more.set(n.left.getText(), []).get(n.left.getText())).push(n.right);
    }
    ts.forEachChild(n, scanDecl);
  };
  const more = new Map();
  scanDecl(fn.body);
  const reads = [];
  const writes = [];
  const bound = new Set();
  const GLOBALS = new Set(["Math", "Number", "String", "Date", "JSON", "Object", "Array", "Boolean", "undefined"]);
  const readKey = (call) => {
    const pa = call.expression;
    const d = alias.get(unwrap(pa.expression).getText());
    let arg = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
    if (arg && ts.isIdentifier(arg) && local.get(arg.getText()) && !local.get(arg.getText()).from) {
      const init = unwrap(local.get(arg.getText()));
      if (ts.isObjectLiteralExpression(init)) arg = init;
    }
    const keys = arg && ts.isObjectLiteralExpression(arg) ? fields(arg) : arg ? { "*": src(arg, 0) } : {};
    return { cell: d.cell, how: pa.name.getText(), keys };
  };
  const isCellCall = (e, names) => ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && names.includes(e.expression.name.getText()) && ts.isIdentifier(unwrap(e.expression.expression)) && alias.get(unwrap(e.expression.expression).getText())?.cell;
  const fmtKeys = (k) => `{${Object.entries(k).map(([f, v]) => `${f}<-${[...v].join("|")}`).join(",")}}`;
  const src = (e, depth) => {
    e = unwrap(e);
    const out = new Set();
    if (!e || depth > 6) return new Set(["?"]);
    if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return new Set(["literal"]);
    if (ts.isIdentifier(e)) {
      const n = e.getText();
      const d = alias.get(n);
      if (d?.tag) return new Set([`tag:${d.tag}`]);
      if (d?.op && d.op !== "?") return new Set();
      if (ctxNames.has(n)) return new Set([n === "input" ? "input.*" : n]);
      const l = local.get(n);
      if (l && l.from) {
        const base = unwrap(l.from);
        if (ts.isIdentifier(base) && ctxNames.has(base.getText()) && base.getText() === "input") return new Set([`input.${l.field}`]);
        return src(l.from, depth + 1);
      }
      if (l) {
        const all = new Set(src(l, depth + 1));
        for (const r of more.get(n) ?? []) if (depth < 4) for (const x of src(r, depth + 1)) all.add(x);
        return all;
      }
      if (GLOBALS.has(n) || bound.has(n)) return new Set();
      return new Set(["?"]);
    }
    if (ts.isPropertyAccessExpression(e)) {
      const base = unwrap(e.expression);
      if (ts.isIdentifier(base) && base.getText() === "input" && ctxNames.has("input")) return new Set([`input.${e.name.getText()}`]);
      if (ts.isIdentifier(base) && base.getText() === "random") return new Set(["random"]);
      return src(e.expression, depth);
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      for (const prm of e.parameters) bound.add(prm.name.getText());
      return src(e.body, depth);
    }
    if (ts.isCallExpression(e)) {
      const inner = ts.isPropertyAccessExpression(e.expression) ? unwrap(e.expression.expression) : undefined;
      if (inner && isCellCall(inner, ["of", "where"])) {
        const r = readKey(inner);
        return new Set([`read:${r.cell}.${r.how}${fmtKeys(r.keys)}`]);
      }
      if (isCellCall(e, ["of", "where"])) {
        const r = readKey(e);
        return new Set([`read:${r.cell}.${r.how}${fmtKeys(r.keys)}`]);
      }
    }
    ts.forEachChild(e, (c) => {
      if (ts.isExpression(c) || ts.isIdentifier(c)) for (const x of src(c, depth)) out.add(x);
    });
    return out.size ? out : new Set(["literal"]);
  };
  const fields = (obj) => {
    const f = {};
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        const s = src(p.expression, 0);
        f["..."] = new Set([...(f["..."] ?? []), ...s]);
        for (const k of Object.keys(f)) if (k !== "...") f[k] = new Set([...f[k], ...[...s].map((x) => `${x} (if it has ${k})`)]);
      } else if (ts.isShorthandPropertyAssignment(p)) f[p.name.getText()] = src(p.name, 0);
      else if (ts.isPropertyAssignment(p)) f[p.name.getText()] = src(p.initializer, 0);
    }
    return f;
  };
  const visit = (n) => {
    if (isCellCall(n, ["of", "where"])) reads.push({ line: n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1, ...readKey(n) });
    if (isCellCall(n, ["set"])) {
      const d = alias.get(unwrap(n.expression.expression).getText());
      const arg = n.arguments[0] ? unwrap(n.arguments[0]) : undefined;
      writes.push({ line: n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1, cell: d.cell, fields: arg && ts.isObjectLiteralExpression(arg) ? fields(arg) : { "*": arg ? src(arg, 0) : new Set(["?"]) } });
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return { reads, writes, fmtKeys };
}

const CHECK = "issues.inTeam";
for (const file of process.argv.slice(2)) {
  const app = basename(file, ".ts");
  const facts = [];
  const j1 = [];
  const j1u = [];
  const j6 = [];
  const j6u = [];
  const j3 = [];
  const j5 = [];
  const j7 = [];
  const ju = { J3: [], J5: [], J7: [] };
  for (const { label, paths, data } of analyze(file)) {
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
    for (const r of data.reads) facts.push(`K ${label} ${r.cell}.${r.how}${data.fmtKeys(r.keys)} @${r.line}`);
    for (const w of data.writes) facts.push(`S ${label} ${w.cell}.set${data.fmtKeys(w.fields)} @${w.line}`);
    const teamKeyed = (r) => r.keys.teamId && [...r.keys.teamId].every((x) => x === "input.teamId");
    const unseen = (r) => Object.values(r.keys).some((v) => v.has("?")) || r.keys["*"];
    if (["issue.move.do", "comment.add.do"].includes(label)) {
      for (const r of data.reads.filter((r) => r.cell === "issues")) {
        if (unseen(r) && !teamKeyed(r)) ju.J5.push(`${label} issues.${r.how} key unseen @${r.line}`);
        else if (!teamKeyed(r) || (r.how === "of" && !r.keys.id)) j5.push(`${label} issues.${r.how}${data.fmtKeys(r.keys)} @${r.line}`);
      }
    }
    if (label === "issue.create.do") {
      const w = data.writes.find((w) => w.cell === "issues");
      const num = w?.fields.number;
      if (!num) ju.J3.push(`${label} number source unseen`);
      else {
        const reads = [...num].filter((x) => x.startsWith("read:issues"));
        const bad = reads.filter((x) => !/teamId<-input\.teamId/.test(x));
        if (!reads.length) ju.J3.push(`${label} number<-${[...num].join("|")}`);
        else if (bad.length) j3.push(`${label} number<-${bad.join("|")} @${w.line}`);
      }
    }
    if (label === "comment.add.do") {
      const w = data.writes.find((w) => w.cell === "comments");
      const a = w?.fields.author;
      if (!a) ju.J7.push(`${label} author unseen`);
      else if ([...a].some((x) => x.startsWith("input") && !x.includes("(if it has"))) j7.push(`${label} author<-${[...a].join("|")} @${w.line}`);
      else if (![...a].every((x) => x.startsWith("tag:"))) ju.J7.push(`${label} author<-${[...a].join("|")}`);
    }
  }
  console.log(`== ${app}`);
  for (const f of facts) console.log(`  ${f}`);
  console.log(`  J1 ${j1.length ? `VIOLATION ${j1.join("; ")}` : j1u.length ? `UNSURE ${j1u.join("; ")}` : "OK"}`);
  console.log(`  J6 ${j6.length ? `VIOLATION ${j6.join("; ")}` : j6u.length ? `UNSURE ${j6u.join("; ")}` : "OK"}`);
  const say = (id, bad, un) => console.log(`  ${id} ${bad.length ? `VIOLATION ${bad.join("; ")}` : un.length ? `UNSURE ${un.join("; ")}` : "OK"}`);
  say("J3", j3, ju.J3);
  say("J5", j5, ju.J5);
  say("J7", j7, ju.J7);
}
