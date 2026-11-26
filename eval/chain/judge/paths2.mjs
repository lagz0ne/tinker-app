// cuj19: J6 (step 3+): a `.do` op that another op calls is a helper, not a root (paths2-run19c.mjs = before).
// cuj19: J6/R8 (all steps): a check a start hook binds in a tag counts where the call op reads it (paths2-run19b.mjs = before).
// cuj19: J3 (all steps) accepts a whole-cell read filtered by teamId === input.teamId (paths2-run19a.mjs = before).
// cuj18: ck5+ helper matching sees through `await x.run(...)` (paths2-run17.mjs = before), and matches a guard on a
//  helper's plain `true` / `false` answer (`if (!done)`) (paths2-run18a.mjs = before).
// paths2.mjs --step N --graph <tinker.graph> <file.ts>...  (cuj11 chain judge; from run 10's paths.mjs)
// cuj11 changes, and only these:
//  - all files are read as one app: an op imported from a sibling file is known by its label;
//  - the member check counts when a call reaches issues.inTeam through its calls (graph closure);
//  - step 3 adds the cell `archived` (R8: the check runs before the archive mark is read),
//    the answer `archived` to J1 (team.archive.do's own success answer `archived` aside), and drops J7 (R9 goes);
//  - J5 reads every issues read in move, rename (step 2+), comment (step 1-2) and the ops they call;
//  - one result block for all files.
// cuj16 (run 16, steps 5-8; steps 1-4 judge as run 15): cells labels (ck5+) and events (ck7+); a `.delete` is a
//  write (ck5+); a call to an op whose graph closure writes a team cell is a write at the call site, and a helper
//  (not `.do`, not a hook) is judged at its call sites only, not on its own exits (J1, ck5+, as Option 1 does for reads);
//  R4 adds `notAssignable` (ck6+); R8 guards labels (ck5+), events (ck7+), and members (ck8: "any part"; team.create.do
//  is R1's exception); J5 roots add issue.label.do (ck5+), issue.assign.do (ck6+); J3 follows a `number` field handed
//  to a helper (ck5+). paths2-run15.mjs = the judge before.
// cuj15: a local op named like a cell is the op (see the depends parse). paths2-run13.mjs = the judge before.
// cuj13 lead decision (2026-11-22, Option 1; R8 is about run order): at step 3 and 4, J6 is judged on call ops
//  (`.do`) and the read hook only; a call to a helper op that reads a guarded cell (by tinker.graph, through its
//  calls) and does not reach issues.inTeam is a read of that cell at the call site. Steps 1-2: run 12 J6, unchanged.
//  The run 12 judge with step 4 is kept as paths2-run12.mjs.
// cuj13 (run 13): step 4 = step 3 rules, plus the answer `forbidden` in J1 (TASK ck4 R4). Nothing else.
// cuj12 (run 12), J6 blind spot (lead decision 2026-11-21): a dependency on a whole cell
//  (`depends: { marks: archived }`, no `.controller`) is read before the run body, so it is a read at
//  the start of every path. A controller's whole-cell `.get()` in the body is a read where it stands.
//  tinker.graph prints both as `reads{<cell>.get}`; that graph fact is the cross-check: a guarded
//  `<cell>.get` in the graph that the code walk did not see makes J6 UNSURE.
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

const CELL = /^(members|issues|comments|archived|labels|events)$/;

const propOf = (obj, name) => obj.properties.find((p) => p.name && p.name.getText() === name);

const unwrap = (e) => {
  while (
    e &&
    (ts.isAsExpression(e) ||
      ts.isParenthesizedExpression(e) ||
      ts.isSatisfiesExpression?.(e) ||
      ts.isNonNullExpression(e))
  )
    e = e.expression;
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

const labelOfVar = new Map();
const tagOfVar = new Map();
// cuj19 (lead, 2026-11-25; all steps): a tag that a start hook binds from the answer of an op that reaches
// issues.inTeam, run with a teamId from the hook's input. A call op that reads its `.value` has the check there.
const checkTags = new Set();
function analyze(file) {
  const program = ts.createProgram([file], {
    noResolve: true,
    noEmit: true,
    target: ts.ScriptTarget.Latest,
    strict: true,
  });
  checker = program.getTypeChecker();
  const src = program.getSourceFile(file);
  const ops = [];
  const imported = new Map();
  for (const st of src.statements) {
    if (
      ts.isImportDeclaration(st) &&
      st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings)
    ) {
      for (const el of st.importClause.namedBindings.elements)
        imported.set(el.name.getText(), (el.propertyName ?? el.name).getText());
    }
  }
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText() === "operation" &&
      n.arguments[0] &&
      ts.isObjectLiteralExpression(n.arguments[0])
    ) {
      const obj = n.arguments[0];
      const label = propOf(obj, "label")?.initializer?.text;
      const decl =
        n.parent && ts.isVariableDeclaration(n.parent) ? n.parent.name.getText() : undefined;
      if (label && decl) labelOfVar.set(decl, label);
      ops.push({ label, obj });
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.getText() === "tag" &&
      n.arguments[0] &&
      ts.isObjectLiteralExpression(n.arguments[0])
    ) {
      const label = propOf(n.arguments[0], "label")?.initializer?.text;
      const decl =
        n.parent && ts.isVariableDeclaration(n.parent) ? n.parent.name.getText() : undefined;
      if (label && decl) tagOfVar.set(decl, label);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);

  return ops
    .filter((o) => o.label)
    .map(({ label, obj }) => {
      const deps = new Map();
      const dp = propOf(obj, "depends");
      if (dp && ts.isPropertyAssignment(dp) && ts.isObjectLiteralExpression(dp.initializer)) {
        for (const p of dp.initializer.properties) {
          const key = p.name.getText();
          const val = ts.isShorthandPropertyAssignment(p)
            ? p.name.getText()
            : p.initializer.getText();
          const local = val.match(/^(\w+)(\.controller)?$/)?.[1];
          const cell = local ? (imported.get(local) ?? local) : undefined;
          // cuj15 fix: a local op whose variable name equals a cell name (`const archived = operation(...)`)
          // is that op, not the cell. Before, the name test came first and made it a whole-cell read.
          if (local && labelOfVar.has(local) && !imported.has(local))
            deps.set(key, { op: labelOfVar.get(local) });
          else if (cell && CELL.test(cell))
            deps.set(key, {
              cell,
              whole: !/\.controller$/.test(val),
              line: p.getSourceFile().getLineAndCharacterOfPosition(p.getStart()).line + 1,
            });
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
      if (fn && (propOf(obj, "input")?.initializer?.getText() ?? "").endsWith("hook.start")) {
        const declOf = (name) => {
          let found;
          const scan = (n) => {
            if (
              !found &&
              ts.isVariableDeclaration(n) &&
              ts.isIdentifier(n.name) &&
              n.name.getText() === name &&
              n.initializer
            )
              found = n.initializer;
            ts.forEachChild(n, scan);
          };
          scan(fn.body);
          return found;
        };
        const textOf = (x, d = 0) => {
          x = unwrap(x);
          if (d > 4 || !x) return "";
          if (ts.isIdentifier(x)) {
            const i = declOf(x.getText());
            return i ? textOf(i, d + 1) : x.getText();
          }
          if (ts.isPropertyAccessExpression(x))
            return textOf(x.expression, d) + "." + x.name.getText();
          return x.getText();
        };
        const scanTags = (n) => {
          if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            tagOfVar.has(n.expression.getText()) &&
            n.arguments.length === 1
          ) {
            let a = unwrap(n.arguments[0]);
            if (ts.isIdentifier(a)) a = unwrap(declOf(a.getText()));
            if (a && ts.isAwaitExpression(a)) a = unwrap(a.expression);
            const base =
              a &&
              ts.isCallExpression(a) &&
              ts.isPropertyAccessExpression(a.expression) &&
              a.expression.name.getText() === "run"
                ? unwrap(a.expression.expression)
                : undefined;
            const op = base && ts.isIdentifier(base) ? alias.get(base.getText())?.op : undefined;
            const arg = op && unwrap(a.arguments[0]);
            const inp =
              arg && ts.isObjectLiteralExpression(arg)
                ? unwrap(propOf(arg, "input")?.initializer)
                : undefined;
            const tid =
              inp && ts.isObjectLiteralExpression(inp) ? propOf(inp, "teamId") : undefined;
            const tv = tid
              ? ts.isShorthandPropertyAssignment(tid)
                ? tid.name
                : tid.initializer
              : undefined;
            if (
              op &&
              (op === CHECK || closure(op).has(CHECK)) &&
              tv &&
              /\binput\b/.test(textOf(tv))
            )
              checkTags.add(tagOfVar.get(n.expression.getText()));
          }
          ts.forEachChild(n, scanTags);
        };
        scanTags(fn.body);
      }
      const paths = walkFn(fn, alias, deps);
      return { label, paths, data: dataFacts(fn, alias) };
    });
}

/** Paths: arrays of events. An event: {t:"call",op} {t:"read",cell} {t:"write",cell} {t:"may",cell} {t:"exit",kind}. */
function walkFn(fn, alias, deps = new Map()) {
  if (!fn) return [];
  const done = [];
  const lineOf = (n) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
  // cuj16 (ck5+): `const v = x.run(...)` of a dependency op: v answers one of that op's exits (tinker.graph);
  // `if (v.kind !== "k") return v;` narrows it on each branch (a path fact).
  const viaVar = new Map();
  // cuj18: `await x.run(...)` is the same call (ck5+ only; unwrap() itself is unchanged for ck1-4).
  const noAwait = (e) => {
    e = unwrap(e);
    return e && ts.isAwaitExpression(e) ? unwrap(e.expression) : e;
  };
  const runOp = (e) => {
    e = noAwait(e);
    return e &&
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.getText() === "run" &&
      ts.isIdentifier(unwrap(e.expression.expression))
      ? alias.get(unwrap(e.expression.expression).getText())?.op
      : undefined;
  };
  const viaNode = new Map();
  if (step >= 5) {
    const scanV = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        runOp(n.initializer)
      ) {
        viaVar.set(n.name.getText(), runOp(n.initializer));
        viaNode.set(noAwait(n.initializer), n.name.getText());
      }
      ts.forEachChild(n, scanV);
    };
    scanV(fn.body);
  }
  // cuj16: literal fields of a returned object (`{ ok: false }`, `{ kind: "x" }`), to match a caller's guard.
  const litOf = (x) => {
    x = unwrap(x);
    if (!x) return undefined;
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
    if (x.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (x.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isNumericLiteral(x)) return Number(x.text);
    return undefined;
  };
  const objOf = (x) => {
    x = unwrap(x);
    if (!x || !ts.isObjectLiteralExpression(x)) return undefined;
    const o = {};
    for (const pr of x.properties)
      if (ts.isPropertyAssignment(pr) && litOf(pr.initializer) !== undefined)
        o[pr.name.getText()] = litOf(pr.initializer);
    return o;
  };
  const fieldOf = (a) => {
    a = unwrap(a);
    return ts.isPropertyAccessExpression(a) &&
      ts.isIdentifier(unwrap(a.expression)) &&
      viaVar.has(unwrap(a.expression).getText())
      ? { v: unwrap(a.expression).getText(), field: a.name.getText() }
      : undefined;
  };
  // cuj18: a guard on the value itself (`if (!done)`) of a helper that answers `true` / `false`.
  const selfOf = (a) => {
    a = unwrap(a);
    return ts.isIdentifier(a) && viaVar.has(a.getText())
      ? { v: a.getText(), field: "" }
      : undefined;
  };
  const kindTest = (c) => {
    c = unwrap(c);
    if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) {
      const f = fieldOf(c.operand) ?? selfOf(c.operand);
      return f ? { ...f, truthy: true, eq: false } : undefined;
    }
    if (selfOf(c)) return { ...selfOf(c), truthy: true, eq: true };
    if (fieldOf(c)) return { ...fieldOf(c), truthy: true, eq: true };
    if (!ts.isBinaryExpression(c)) return undefined;
    const eq = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
      c.operatorToken.kind,
    );
    const ne = [
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(c.operatorToken.kind);
    if (!eq && !ne) return undefined;
    const side = (a, b) => {
      const f = fieldOf(a);
      const l = litOf(b);
      return f && l !== undefined ? { ...f, lit: l } : undefined;
    };
    const s = side(c.left, c.right) ?? side(c.right, c.left);
    return s ? { ...s, eq } : undefined;
  };

  const expr = (e, paths) => {
    if (!e || !paths.length) return paths;
    e = unwrap(e);
    if (ts.isConditionalExpression(e)) {
      const c = expr(e.condition, paths);
      return [
        ...expr(
          e.whenTrue,
          c.map((p) => [...p]),
        ),
        ...expr(
          e.whenFalse,
          c.map((p) => [...p]),
        ),
      ];
    }
    if (
      ts.isBinaryExpression(e) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(e.operatorToken.kind)
    ) {
      const l = expr(e.left, paths);
      return [
        ...l.map((p) => [...p]),
        ...expr(
          e.right,
          l.map((p) => [...p]),
        ),
      ];
    }
    if (ts.isCallExpression(e)) {
      let ps = expr(e.expression, paths);
      for (const a of e.arguments) ps = expr(a, ps);
      const callee = e.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.getText();
        const base = unwrap(callee.expression);
        const root =
          ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression)
            ? unwrap(base.expression.expression)
            : base;
        const d = ts.isIdentifier(root) ? alias.get(root.getText()) : undefined;
        if (d?.op && m === "run" && ts.isIdentifier(base))
          return ps.map((p) => [...p, { t: "call", op: d.op, line: lineOf(e), v: viaNode.get(e) }]);
        if (d?.cell && (m === "set" || (step >= 5 && m === "delete")) && ts.isIdentifier(base))
          return ps.map((p) => [...p, { t: "write", cell: d.cell, line: lineOf(e) }]);
        if (d?.cell && ["of", "where", "get"].includes(m) && ts.isIdentifier(base))
          return ps.map((p) => [...p, { t: "read", cell: d.cell, line: lineOf(e) }]);
      }
      const handed = e.arguments
        .map(unwrap)
        .filter((a) => ts.isIdentifier(a) && alias.get(a.getText())?.cell);
      if (handed.length)
        return ps.map((p) => [
          ...p,
          ...handed.map((a) => ({ t: "may", cell: alias.get(a.getText()).cell, line: lineOf(e) })),
        ]);
      return ps;
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      const found = [];
      const scan = (n) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const base = unwrap(n.expression.expression);
          const d = ts.isIdentifier(base) ? alias.get(base.getText()) : undefined;
          const m = n.expression.name.getText();
          if (d?.cell && (m === "set" || (step >= 5 && m === "delete")))
            found.push({ t: "may", cell: d.cell, line: lineOf(n) });
          if (d?.cell && ["of", "where", "get"].includes(m))
            found.push({ t: "read", cell: d.cell, line: lineOf(n) });
        }
        ts.forEachChild(n, scan);
      };
      scan(e.body);
      return paths.map((p) => [...p, ...found]);
    }
    if (
      ts.isPropertyAccessExpression(e) &&
      e.name.getText() === "value" &&
      ts.isIdentifier(unwrap(e.expression)) &&
      checkTags.has(alias.get(unwrap(e.expression).getText())?.tag)
    ) {
      return paths.map((p) => [...p, { t: "call", op: CHECK, line: lineOf(e), viaTag: true }]);
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
      ret(
        e.whenTrue,
        c.map((p) => [...p]),
      );
      ret(
        e.whenFalse,
        c.map((p) => [...p]),
      );
      return;
    }
    // cuj16 (ck5+): `return x.run(...)` of a dependency op answers what that op answers; the op's own exits
    // are judged where it is defined, so this exit is "via" it (its writes at this call are not this op's to judge).
    if (step >= 5 && e && ts.isAwaitExpression(e)) e = unwrap(e.expression);
    if (
      step >= 5 &&
      e &&
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.getText() === "run" &&
      ts.isIdentifier(unwrap(e.expression.expression)) &&
      alias.get(unwrap(e.expression.expression).getText())?.op
    ) {
      const op = alias.get(unwrap(e.expression.expression).getText()).op;
      for (const p of expr(e, paths))
        done.push([...p, { t: "exit", kind: "via:" + op, line: lineOf(e) }]);
      return;
    }
    if (
      step >= 5 &&
      e &&
      ts.isIdentifier(e) &&
      viaVar.has(e.getText()) &&
      graphExits.has(viaVar.get(e.getText()))
    ) {
      const v = e.getText();
      for (const p of expr(e, paths)) {
        let ks = graphExits.get(viaVar.get(v));
        for (const f of p)
          if (f.t === "kind" && f.v === v && f.field === "kind" && !f.truthy)
            ks = ks.filter((k) => (k === f.lit) === f.is);
        for (const kind of ks.length ? ks : ["value"])
          done.push([...p, { t: "exit", kind, via: viaVar.get(v) }]);
      }
      return;
    }
    const direct = kindOf(e);
    const kinds = direct === "value" && e ? (kindsByType(e) ?? ["value"]) : [direct];
    const obj = objOf(e);
    const lit = litOf(e);
    for (const p of expr(e, paths))
      for (const kind of kinds) done.push([...p, { t: "exit", kind, obj, lit }]);
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
      const kt = kindTest(s.expression);
      const fact = (is) =>
        kt ? [{ t: "kind", v: kt.v, field: kt.field, lit: kt.lit, truthy: kt.truthy, is }] : [];
      const a = stmt(
        s.thenStatement,
        c.map((p) => [...p, ...fact(kt?.eq)]),
      );
      const b = s.elseStatement
        ? stmt(
            s.elseStatement,
            c.map((p) => [...p, ...fact(!kt?.eq)]),
          )
        : c.map((p) => [...p, ...fact(!kt?.eq)]);
      return [...a, ...b];
    }
    if (ts.isVariableStatement(s))
      return s.declarationList.declarations.reduce((ps, d) => expr(d.initializer, ps), paths);
    if (ts.isExpressionStatement(s)) return expr(s.expression, paths);
    if (
      ts.isForOfStatement(s) ||
      ts.isForInStatement(s) ||
      ts.isForStatement(s) ||
      ts.isWhileStatement(s)
    ) {
      const head = ts.isForStatement(s) ? expr(s.condition, paths) : expr(s.expression, paths);
      return [
        ...head.map((p) => [...p]),
        ...stmt(
          s.statement,
          head.map((p) => [...p]),
        ),
      ];
    }
    if (ts.isTryStatement(s)) return stmt(s.tryBlock, paths);
    if (ts.isThrowStatement(s)) {
      for (const p of expr(s.expression, paths)) done.push([...p, { t: "exit", kind: "throw" }]);
      return [];
    }
    if (ts.isSwitchStatement(s)) {
      const c = expr(s.expression, paths);
      return s.caseBlock.clauses.flatMap((cl) =>
        cl.statements.reduce(
          (ps, x) => stmt(x, ps),
          c.map((p) => [...p]),
        ),
      );
    }
    return paths;
  };

  const start = [...deps.values()]
    .filter((d) => d.cell && d.cell !== "?" && d.whole)
    .map((d) => ({ t: "read", cell: d.cell, line: d.line, dep: true }));
  if (ts.isBlock(fn.body)) {
    for (const p of stmt(fn.body, [[...start]])) done.push([...p, { t: "exit", kind: "void" }]);
  } else ret(fn.body, [[...start]]);
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
  if (p1 && ts.isObjectBindingPattern(p1.name))
    for (const el of p1.name.elements) ctxNames.add(el.name.getText());
  const scanDecl = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name)) local.set(n.name.getText(), n.initializer);
      else if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements)
          local.set(el.name.getText(), {
            from: n.initializer,
            field: (el.propertyName ?? el.name).getText(),
          });
      }
    }
    if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer)) {
      for (const d of n.initializer.declarations)
        if (ts.isIdentifier(d.name)) local.set(d.name.getText(), n.expression);
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left)
    ) {
      (more.get(n.left.getText()) ?? more.set(n.left.getText(), []).get(n.left.getText())).push(
        n.right,
      );
    }
    ts.forEachChild(n, scanDecl);
  };
  const more = new Map();
  scanDecl(fn.body);
  const reads = [];
  const writes = [];
  const bound = new Set();
  const GLOBALS = new Set([
    "Math",
    "Number",
    "String",
    "Date",
    "JSON",
    "Object",
    "Array",
    "Boolean",
    "undefined",
  ]);
  const readKey = (call) => {
    const pa = call.expression;
    const d = alias.get(unwrap(pa.expression).getText());
    let arg = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
    if (arg && ts.isIdentifier(arg) && local.get(arg.getText()) && !local.get(arg.getText()).from) {
      const init = unwrap(local.get(arg.getText()));
      if (ts.isObjectLiteralExpression(init)) arg = init;
    }
    const keys =
      arg && ts.isObjectLiteralExpression(arg) ? fields(arg) : arg ? { "*": src(arg, 0) } : {};
    return { cell: d.cell, how: pa.name.getText(), keys };
  };
  const isCellCall = (e, names) =>
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    names.includes(e.expression.name.getText()) &&
    ts.isIdentifier(unwrap(e.expression.expression)) &&
    alias.get(unwrap(e.expression.expression).getText())?.cell;
  const fmtKeys = (k) =>
    `{${Object.entries(k)
      .map(([f, v]) => `${f}<-${[...v].join("|")}`)
      .join(",")}}`;
  const wholeGet = (x, depth) => {
    x = unwrap(x);
    if (!x || depth > 6) return undefined;
    if (ts.isIdentifier(x)) {
      const l = local.get(x.getText());
      return l && !l.from ? wholeGet(l, depth + 1) : undefined;
    }
    if (
      ts.isCallExpression(x) &&
      ts.isPropertyAccessExpression(x.expression) &&
      x.expression.name.getText() === "get" &&
      x.arguments.length === 0
    ) {
      const base = unwrap(x.expression.expression);
      return ts.isIdentifier(base) ? alias.get(base.getText())?.cell : undefined;
    }
    return undefined;
  };
  const teamFilter = (fn, depth) => {
    fn = unwrap(fn);
    if (
      !fn ||
      !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ||
      fn.parameters.length !== 1
    )
      return "filter<-?";
    const pn = fn.parameters[0].name;
    const isTeam = (x) => {
      x = unwrap(x);
      if (ts.isIdentifier(pn))
        return (
          ts.isPropertyAccessExpression(x) &&
          x.name.getText() === "teamId" &&
          ts.isIdentifier(unwrap(x.expression)) &&
          unwrap(x.expression).getText() === pn.getText()
        );
      return (
        ts.isObjectBindingPattern(pn) &&
        ts.isIdentifier(x) &&
        pn.elements.some(
          (el) =>
            el.name.getText() === x.getText() &&
            (el.propertyName ?? el.name).getText() === "teamId",
        )
      );
    };
    let b = fn.body;
    if (ts.isBlock(b)) {
      const r =
        b.statements.length === 1 && ts.isReturnStatement(b.statements[0])
          ? b.statements[0].expression
          : undefined;
      if (!r) return "filter<-?";
      b = r;
    }
    b = unwrap(b);
    if (
      !ts.isBinaryExpression(b) ||
      ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
        b.operatorToken.kind,
      )
    )
      return "filter<-?";
    const other = isTeam(b.left) ? b.right : isTeam(b.right) ? b.left : undefined;
    if (!other) return "filter<-?";
    const v = [...src(other, depth + 1)];
    return v.length === 1 && v[0] === "input.teamId"
      ? "teamId<-input.teamId"
      : `teamId<-${v.join("|") || "?"}`;
  };
  const src = (e, depth) => {
    e = unwrap(e);
    const out = new Set();
    if (!e || depth > 6) return new Set(["?"]);
    if (
      ts.isStringLiteral(e) ||
      ts.isNumericLiteral(e) ||
      ts.isNoSubstitutionTemplateLiteral(e) ||
      e.kind === ts.SyntaxKind.TrueKeyword ||
      e.kind === ts.SyntaxKind.FalseKeyword
    )
      return new Set(["literal"]);
    if (ts.isIdentifier(e)) {
      const n = e.getText();
      const d = alias.get(n);
      if (d?.tag) return new Set([`tag:${d.tag}`]);
      if (d?.op && d.op !== "?") return new Set();
      if (ctxNames.has(n)) return new Set([n === "input" ? "input.*" : n]);
      const l = local.get(n);
      if (l && l.from) {
        const base = unwrap(l.from);
        if (ts.isIdentifier(base) && ctxNames.has(base.getText()) && base.getText() === "input")
          return new Set([`input.${l.field}`]);
        return src(l.from, depth + 1);
      }
      if (l) {
        const all = new Set(src(l, depth + 1));
        for (const r of more.get(n) ?? [])
          if (depth < 4) for (const x of src(r, depth + 1)) all.add(x);
        return all;
      }
      if (GLOBALS.has(n) || bound.has(n)) return new Set();
      return new Set(["?"]);
    }
    if (ts.isPropertyAccessExpression(e)) {
      const base = unwrap(e.expression);
      if (ts.isIdentifier(base) && base.getText() === "input" && ctxNames.has("input"))
        return new Set([`input.${e.name.getText()}`]);
      if (ts.isIdentifier(base) && base.getText() === "random") return new Set(["random"]);
      return src(e.expression, depth);
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      for (const prm of e.parameters) bound.add(prm.name.getText());
      return src(e.body, depth);
    }
    if (ts.isCallExpression(e)) {
      const inner = ts.isPropertyAccessExpression(e.expression)
        ? unwrap(e.expression.expression)
        : undefined;
      // cuj19 (lead, 2026-11-25; all steps): a whole-cell read filtered by team on the server,
      // `x.get().filter((i) => i.teamId === input.teamId)`, reads by team as `where({ teamId })` does.
      // Another filter is a read with another key (J3: VIOLATION); no filter stays unseen (J3: UNSURE).
      if (
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.name.getText() === "filter" &&
        e.arguments.length === 1
      ) {
        const cell = wholeGet(e.expression.expression, depth);
        if (cell) return new Set([`read:${cell}.get{${teamFilter(e.arguments[0], depth)}}`]);
      }
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
        for (const k of Object.keys(f))
          if (k !== "...") f[k] = new Set([...f[k], ...[...s].map((x) => `${x} (if it has ${k})`)]);
      } else if (ts.isShorthandPropertyAssignment(p)) f[p.name.getText()] = src(p.name, 0);
      else if (ts.isPropertyAssignment(p)) f[p.name.getText()] = src(p.initializer, 0);
    }
    return f;
  };
  const numbers = [];
  const visit = (n) => {
    // cuj16: each object literal with a `number` field (J3 at ck5+, when create hands the issue to a helper).
    if (
      ts.isObjectLiteralExpression(n) &&
      n.properties.some((p) => p.name && p.name.getText() === "number")
    ) {
      const f = fields(n);
      numbers.push({
        line: n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1,
        cell: "issues",
        fields: { number: f.number },
      });
    }
    if (isCellCall(n, ["of", "where"]))
      reads.push({
        line: n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1,
        ...readKey(n),
      });
    if (isCellCall(n, ["set"])) {
      const d = alias.get(unwrap(n.expression.expression).getText());
      const arg = n.arguments[0] ? unwrap(n.arguments[0]) : undefined;
      writes.push({
        line: n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1,
        cell: d.cell,
        fields:
          arg && ts.isObjectLiteralExpression(arg)
            ? fields(arg)
            : { "*": arg ? src(arg, 0) : new Set(["?"]) },
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return { reads, writes, fmtKeys, numbers };
}

const CHECK = "issues.inTeam";
const argv = process.argv.slice(2);
let step = 1,
  graphFile;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--step") step = Number(argv[++i]);
  else if (argv[i] === "--graph") graphFile = argv[++i];
  else files.push(argv[i]);
}
// v2: steps 9, 10 and 11 are judged as step 8 (no new answer kind, no new team part).
if (step === 9 || step === 10 || step === 11) step = 8;
if (![1, 2, 3, 4, 5, 6, 7, 8].includes(step) || !files.length) {
  console.error("usage: node paths2.mjs --step 1-8 [--graph tinker.graph] <file.ts>...");
  process.exit(2);
}
const graphCalls = new Map();
const graphReads = new Map();
const CELL_OF_LABEL = {
  "issues.list": "issues",
  "issues.archived": "archived",
  "issues.members": "members",
  "issues.comments": "comments",
  "issues.labels": "labels",
  "issues.events": "events",
};
const graphWrites = new Map();
const graphExits = new Map();
if (graphFile)
  for (const line of readFileSync(graphFile, "utf8").split(/\r?\n/)) {
    const label = line.trim().split(/\s+/)[0];
    if (label === "view") continue; // 0.34.10: view lines are pages, not ops
    const m = line.match(/calls\{([^}]*)\}/);
    if (label) graphCalls.set(label, m && m[1] ? m[1].split(",") : []);
    const r = line.match(/reads\{([^}]*)\}/);
    if (label) graphReads.set(label, r && r[1] ? r[1].split(",") : []);
    const w = line.match(/writes\{([^}]*)\}/);
    if (label) graphWrites.set(label, w && w[1] ? w[1].split(",") : []);
    const x = line.match(/exits\{([^}]*)\}/);
    if (label && x) graphExits.set(label, x[1] ? x[1].split(",") : []);
  }
const closure = (label) => {
  const seen = new Set(),
    todo = [...(graphCalls.get(label) ?? [])];
  while (todo.length) {
    const c = todo.pop();
    if (seen.has(c)) continue;
    seen.add(c);
    todo.push(...(graphCalls.get(c) ?? []));
  }
  return seen;
};
const NOWRITE =
  step >= 6
    ? ["gone", "stale", "exists", "archived", "forbidden", "notAssignable"]
    : step >= 4
      ? ["gone", "stale", "exists", "archived", "forbidden"]
      : step === 3
        ? ["gone", "stale", "exists", "archived"]
        : ["gone", "stale", "exists"];
const GUARDED =
  step >= 8
    ? ["issues", "archived", "labels", "events", "members", "?"]
    : step >= 7
      ? ["issues", "archived", "labels", "events", "?"]
      : step >= 5
        ? ["issues", "archived", "labels", "?"]
        : step >= 3
          ? ["issues", "archived", "?"]
          : ["issues", "?"];
const J5ROOTS =
  {
    1: ["issue.move.do", "comment.add.do"],
    2: ["issue.move.do", "issue.rename.do", "comment.add.do"],
    3: ["issue.move.do", "issue.rename.do"],
    4: ["issue.move.do", "issue.rename.do"],
    5: ["issue.move.do", "issue.rename.do", "issue.label.do"],
  }[Math.min(step, 5)] ?? [];
if (step >= 6) J5ROOTS.push("issue.assign.do");
const J5OPS = new Set(J5ROOTS.flatMap((r) => [r, ...closure(r)]));
for (const f of files) analyze(f); // first pass: op and tag names of every file
const all = files.flatMap((f) => analyze(f));
// cuj16 (ck5+): the team cells an op writes on its paths to one exit kind (its own writes, and the cells its calls may write).
// cuj16: the team cells an op writes on its paths whose answer fits the caller's guards on it (`!v.ok`, `v.kind === "x"`).
const factWrites = (op, facts) => {
  const o = all.find((x) => x.label === op);
  if (!o) return helperWrites(op);
  const fits = (p) =>
    facts.every((f) => {
      const val =
        f.field === ""
          ? p.at(-1).lit
          : (p.at(-1).obj?.[f.field] ?? (f.field === "kind" ? p.at(-1).kind : undefined));
      if (val === undefined) return true;
      return f.truthy ? !!val === f.is : (val === f.lit) === f.is;
    });
  const out = new Set();
  for (const p of o.paths)
    if (fits(p))
      for (const ev of p) {
        if (ev.t === "write" || ev.t === "may") out.add(ev.cell);
        if (ev.t === "call") for (const c of helperWrites(ev.op)) out.add(c);
      }
  return [...out];
};
const exitWrites = (op, kind, depth = 0) => {
  const o = all.find((x) => x.label === op);
  if (!o || depth > 4) return helperWrites(op);
  const out = new Set();
  for (const p of o.paths)
    if (p.at(-1).kind === kind)
      for (const ev of p) {
        if (ev.t === "write" || ev.t === "may") out.add(ev.cell);
        if (ev.t === "call") for (const c of helperWrites(ev.op)) out.add(c);
      }
  return [...out];
};
const reaches = (op) => op === CHECK || closure(op).has(CHECK);
// cuj16: the team cells a call writes (the op and its calls, by tinker.graph); ck5+ only.
const helperWrites = (op) =>
  step < 5 || !op || op === "?"
    ? []
    : [
        ...new Set(
          [op, ...closure(op)].flatMap((o) =>
            (graphWrites.get(o) ?? [])
              .map((g) => CELL_OF_LABEL[g.replace(/\.[a-z]+$/, "")])
              .filter(Boolean),
          ),
        ),
      ];
// cuj19 (all steps from 3, as Option 1): a `.do` op that another op calls (tinker.graph) is a helper, judged at
// its call sites; only call ops nobody calls are roots (a writer may name a helper `team.clear.do`).
const calledOps = new Set([...graphCalls.values()].flat());
const isRoot = (label) =>
  step < 3 || (label.endsWith(".do") && !calledOps.has(label)) || label === "issues.membersOnly";
const helperReads = (op) =>
  step >= 3 &&
  !!op &&
  op !== "?" &&
  !reaches(op) &&
  [op, ...closure(op)].some((o) =>
    (graphReads.get(o) ?? []).some((g) =>
      GUARDED.includes(CELL_OF_LABEL[g.replace(/\.[a-z]+$/, "")]),
    ),
  );
{
  const app = files.map((f) => basename(f)).join(" ");
  const facts = [];
  const j1 = [];
  const j1u = [];
  const j6 = [];
  const j6u = [];
  const j3 = [];
  const j5 = [];
  const j7 = [];
  const ju = { J3: [], J5: [], J7: [] };
  for (const { label, paths, data } of all) {
    const byExit = new Map();
    for (const p of paths) {
      const last = p.at(-1);
      const exit = last.kind;
      const w = byExit.get(exit) ?? new Set();
      for (const ev of p)
        if (ev.t === "write" || ev.t === "may")
          w.add(`${ev.cell}${ev.t === "may" ? "?" : ""}@${ev.line}`);
      const viaCall = last.via
        ? p.findLastIndex((ev) => ev.t === "call" && ev.op === last.via)
        : -1;
      p.forEach((ev, i) => {
        if (
          ev.t !== "call" ||
          (exit.startsWith("via:") && ev.op === exit.slice(4) && ev.line === last.line)
        )
          return;
        const facts = ev.v ? p.filter((f) => f.t === "kind" && f.v === ev.v) : [];
        for (const c of i === viaCall
          ? exitWrites(ev.op, exit)
          : facts.length
            ? factWrites(ev.op, facts)
            : helperWrites(ev.op))
          w.add(`${c}<-${ev.op}@${ev.line}`);
      });
      byExit.set(exit, w);
    }
    for (const [exit, w] of byExit) {
      facts.push(`W ${label} ${exit} {${[...w].join(",")}}`);
      if (
        NOWRITE.includes(exit) &&
        !(step >= 3 && label === "team.archive.do" && exit === "archived") &&
        w.size
      )
        j1.push(`${label} ${exit} writes ${[...w].join(",")}`);
      if (
        (exit === "value" || exit.startsWith("via:")) &&
        w.size &&
        !/^issues\.(signedIn|membersOnly|inTeam)$/.test(label) &&
        (step < 5 || isRoot(label))
      )
        j1u.push(`${label} exit of unknown kind writes ${[...w].join(",")}`);
    }
    const early = new Set();
    const unsure = new Set();
    for (const p of paths) {
      const iRead = p.findIndex(
        (ev) =>
          ((ev.t === "read" || ev.t === "may") && GUARDED.includes(ev.cell)) ||
          (ev.t === "call" && helperReads(ev.op)),
      );
      if (iRead < 0) continue;
      const iCheck = p.findIndex((ev) => ev.t === "call" && reaches(ev.op));
      const iUnknown = p.findIndex((ev) => ev.t === "call" && ev.op === "?");
      if (iCheck >= 0 && iCheck < iRead) continue;
      if (p[iRead].cell === "?" || (iUnknown >= 0 && iUnknown < iRead)) unsure.add(p[iRead].line);
      else early.add(p[iRead].line);
    }
    const readsIssues = paths.some((p) =>
      p.some((ev) => ev.t === "read" && GUARDED.includes(ev.cell)),
    );
    if (readsIssues)
      facts.push(
        `O ${label} ${GUARDED.filter((c) => c !== "?").join("/")} read-before ${CHECK}: ${early.size ? `yes @${[...early].join(",")}` : "no"}`,
      );
    if (
      early.size &&
      label !== CHECK &&
      isRoot(label) &&
      !(step >= 8 && label === "team.create.do")
    )
      j6.push(
        `${label} reads ${GUARDED.filter((c) => c !== "?").join("/")} before the check @${[...early].join(",")}`,
      );
    const seenRead = (cell) =>
      paths.some((p) => p.some((ev) => ev.t === "read" && ev.cell === cell));
    for (const g of graphReads.get(label) ?? []) {
      const cell = CELL_OF_LABEL[g.replace(/\.get$/, "")];
      if (
        g.endsWith(".get") &&
        cell &&
        GUARDED.includes(cell) &&
        label !== CHECK &&
        !seenRead(cell)
      )
        j6u.push(`${label} graph reads{${g}}, the code walk did not see it`);
    }
    for (const ev of paths[0] ?? [])
      if (ev.dep)
        facts.push(
          `D ${label} depends on the whole cell ${ev.cell} @${ev.line}: read before the run body`,
        );
    if (
      unsure.size &&
      label !== CHECK &&
      isRoot(label) &&
      !(step >= 8 && label === "team.create.do")
    )
      j6u.push(`${label} unknown dependency before the read @${[...unsure].join(",")}`);
    for (const r of data.reads)
      facts.push(`K ${label} ${r.cell}.${r.how}${data.fmtKeys(r.keys)} @${r.line}`);
    for (const w of data.writes)
      facts.push(`S ${label} ${w.cell}.set${data.fmtKeys(w.fields)} @${w.line}`);
    const teamKeyed = (r) => r.keys.teamId && [...r.keys.teamId].every((x) => x === "input.teamId");
    const unseen = (r) => Object.values(r.keys).some((v) => v.has("?")) || r.keys["*"];
    if (J5OPS.has(label)) {
      for (const r of data.reads.filter((r) => r.cell === "issues")) {
        if (unseen(r) && !teamKeyed(r))
          ju.J5.push(`${label} issues.${r.how} key unseen @${r.line}`);
        else if (!teamKeyed(r) || (r.how === "of" && !r.keys.id))
          j5.push(`${label} issues.${r.how}${data.fmtKeys(r.keys)} @${r.line}`);
      }
    }
    if (label === "issue.create.do") {
      const w =
        data.writes.find((w) => w.cell === "issues") ??
        (step >= 5 ? data.numbers.find(Boolean) : undefined);
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
      else if ([...a].some((x) => x.startsWith("input") && !x.includes("(if it has")))
        j7.push(`${label} author<-${[...a].join("|")} @${w.line}`);
      else if (![...a].every((x) => x.startsWith("tag:")))
        ju.J7.push(`${label} author<-${[...a].join("|")}`);
    }
  }
  console.log(`== ${app}`);
  for (const f of facts) console.log(`  ${f}`);
  console.log(
    `  J1 ${j1.length ? `VIOLATION ${j1.join("; ")}` : j1u.length ? `UNSURE ${j1u.join("; ")}` : "OK"}`,
  );
  console.log(
    `  J6 ${j6.length ? `VIOLATION ${j6.join("; ")}` : j6u.length ? `UNSURE ${j6u.join("; ")}` : "OK"}`,
  );
  const say = (id, bad, un) =>
    console.log(
      `  ${id} ${bad.length ? `VIOLATION ${bad.join("; ")}` : un.length ? `UNSURE ${un.join("; ")}` : "OK"}`,
    );
  say("J3", j3, ju.J3);
  say("J5", j5, ju.J5);
  if (step < 3) say("J7", j7, ju.J7);
}
