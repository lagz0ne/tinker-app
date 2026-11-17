// Scratch: print the Tinker shape of one feature folder. Names of locals are dropped;
// contract names (cell labels, rpc addresses) stay, since the task gives them.
// usage: node shape.mjs <folder>            -> shape lines
//        node shape.mjs <folder> <golden>    -> diff vs golden file, exit 1 on a gap
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const dir = process.argv[2];
const files = [];
(function scan(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) scan(p);
    else if (/\.tsx?$/.test(f) && !/\.test\./.test(f)) files.push(p);
  }
})(dir);

const src = files.map((p) => ({
  path: relative(dir, p),
  server: /\.server\./.test(p),
  sf: ts.createSourceFile(p, readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true, p.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
}));

const walk = (n, f) => { f(n); ts.forEachChild(n, (c) => walk(c, f)); };
const callee = (c) => ts.isCallExpression(c) ? c.expression.getText() : "";
const prop = (obj, name) => obj?.properties?.find((p) => p.name?.getText().replace(/"/g, "") === name)?.initializer;
const unwrap = (n) => (n && ts.isCallExpression(n) && n.expression.getText() === "memo" ? n.arguments[0] : n);

// 1. name table per file: const name -> unit; imports point at the other file's table
const tables = new Map(src.map((f) => [f.path, new Map()]));
const imports = new Map(src.map((f) => [f.path, new Map()]));
const resolveFile = (from, spec) => {
  if (!spec.startsWith(".")) return;
  const base = join(from, "..", spec).replace(/^\.\//, "");
  return src.find((f) => [".ts", ".tsx", "/index.ts", "/index.tsx"].some((e) => f.path === base + e))?.path;
};
for (const f of src) for (const st of f.sf.statements) {
  if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings?.elements) continue;
  const target = resolveFile(f.path, st.moduleSpecifier.text);
  if (target) for (const e of st.importClause.namedBindings.elements) imports.get(f.path).set(e.name.text, [target, (e.propertyName ?? e.name).text]);
}
const look = (file, name, seen = 0) => {
  const local = tables.get(file)?.get(name);
  if (local || seen > 5) return local;
  const imp = imports.get(file)?.get(name);
  return imp && look(imp[0], imp[1], seen + 1);
};
let cur;
const units = { set: (k, v) => tables.get(cur).set(k, { ...v, file: cur, name: k }), get: (k) => look(cur, k) };
for (const { sf, path } of src) { cur = path; walk(sf, (n) => {
  if (!ts.isVariableDeclaration(n) || !n.initializer || !ts.isIdentifier(n.name)) return;
  const init = n.initializer, name = n.name.text, c = callee(init);
  const opts = ts.isCallExpression(init) ? init.arguments[0] : undefined;
  const label = prop(opts, "label")?.getText().replace(/"/g, "");
  if (c === "data") {
    const mode = prop(opts, "mode")?.getText().replace(/"/g, "") ?? "plain";
    let keys = [];
    const key = prop(opts, "key");
    if (key) walk(key, (k) => { if (ts.isObjectLiteralExpression(k)) keys = k.properties.map((p) => p.name.getText()); });
    units.set(name, { kind: "cell", label, line: `cell ${label} ${mode}${keys.length ? ` key{${keys.join(",")}}` : ""}` });
  } else if (c === "tag") {
    // a tag made in the writer's own file is a local name: only its role counts
    const own = !/contract|sign-in|index/.test(path);
    units.set(name, { kind: "tag", label: own ? "own" : label, line: `tag ${own ? "own" : label}` });
  }
  else if (c === "operation") units.set(name, { kind: "op", label, node: opts });
  else if (c === "remoteData") units.set(name, { kind: "board", parts: Object.fromEntries(opts.properties.map((p) => [p.name.getText(), (p.initializer ?? p.name).getText()])) });
  else if (c === "rpc") units.set(name, { kind: "api", node: opts });
  else if (c === "derived") units.set(name, { kind: "derived", label, line: `derived ${label}` });
  else if (c === "capsule") units.set(name, { kind: "capsule", label, node: opts });
  else if (ts.isCallExpression(init) && /z\./.test(c)) units.set(name, { kind: "zod", node: init });
}); }
const all = [...tables.values()].flatMap((t) => [...t.values()]);
const cellOf = (v) => units.get(v)?.label ?? v;

const out = [];
// 2. contract
for (const u of all) {
  cur = u.file;
  if (u.kind === "cell" || u.kind === "tag" || u.kind === "derived") out.push(`contract  ${u.line}`);
  if (u.kind === "board") for (const [part, cell] of Object.entries(u.parts)) out.push(`contract  served ${part} = ${cellOf(cell)}`);
  if (u.kind === "api") for (const p of u.node.properties) {
    const kinds = new Set();
    const visit = (k) => {
      if (ts.isIdentifier(k) && units.get(k.text)?.kind === "zod") walk(units.get(k.text).node, visit);
      if (ts.isCallExpression(k) && /z\.literal$/.test(callee(k))) kinds.add(k.arguments[0].getText().replace(/"/g, ""));
      if (ts.isCallExpression(k) && /z\.enum$/.test(callee(k)) && ts.isArrayLiteralExpression(k.arguments[0])) k.arguments[0].elements.forEach((e) => kinds.add(e.getText().replace(/"/g, "")));
    };
    walk(prop(p.initializer, "output") ?? p, visit);
    out.push(`contract  rpc ${p.name.getText().replace(/"/g, "")} -> ${[...kinds].sort().join("|")}`);
  }
  if (u.kind === "capsule") out.push(`contract  capsule exports{${prop(u.node, "exports")?.properties.map((p) => p.name.getText()).sort().join(",")}}`);
}

// 3. implement map: "addr": opVar
const addrOf = new Map();
for (const { sf, path } of src) { cur = path; walk(sf, (n) => {
  // `{ "team.create": createTeam }` or `{ "team.create": operation({...}) }`: the op may sit in
  // the map itself. A map counts when every entry is an op under a string name.
  const opIn = (p) => ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name) &&
    ((ts.isIdentifier(p.initializer) && units.get(p.initializer.text)?.kind === "op") || callee(p.initializer) === "operation");
  if (ts.isObjectLiteralExpression(n) && n.properties.length && n.properties.every(opIn))
    for (const p of n.properties) {
      let u = ts.isIdentifier(p.initializer) ? units.get(p.initializer.text) : undefined;
      if (!u) { u = { kind: "op", node: p.initializer.arguments[0], file: path, name: p.name.text }; all.push(u); }
      addrOf.set(u, p.name.text);
    }
}); }

// 4. ops
for (const u of all) {
  if (u.kind !== "op") continue;
  cur = u.file;
  const o = u.node;
  const deps = {};
  for (const p of prop(o, "depends")?.properties ?? []) {
    const t = (p.initializer ?? p.name).getText();
    const [base, how = "value"] = t.split(".");
    const b = units.get(base);
    deps[p.name.getText()] = b?.kind === "op" ? { show: `op:${addrOf.get(b) ?? "check"}` } : { show: `${b?.kind ?? "?"}:${b?.label ?? base}.${how}`, label: b?.label ?? base };
  }
  const input = prop(o, "input")?.getText() ?? "none";
  const role = /(^|\.)hook\.start$/.test(input) ? "hook" : addrOf.has(u) ? `serves ${addrOf.get(u)}` : "check";
  const writes = new Set(), reads = new Set(), kinds = new Set(), calls = new Set();
  let refuse = false;
  const run = prop(o, "run");
  // `run: ({ issues: list }) =>` renames a dep: follow the new name
  const first = run?.parameters?.[0]?.name;
  if (first && ts.isObjectBindingPattern(first)) for (const el of first.elements) {
    if (el.propertyName && deps[el.propertyName.getText()]) deps[el.name.getText()] = deps[el.propertyName.getText()];
  }
  if (run) walk(run, (k) => {
    if (ts.isCallExpression(k) && ts.isPropertyAccessExpression(k.expression)) {
      const m = k.expression.name.text;
      let root = k.expression.expression;
      while (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root)) root = ts.isCallExpression(root) ? root.expression : root.expression;
      const d = deps[root.getText()];
      if (d?.label && ["set", "update", "delete"].includes(m)) writes.add(`${d.label}.${m}`);
      if (d?.label && ["of", "where"].includes(m)) reads.add(`${d.label}.${m}`);
      if (d && m === "run") calls.add(d.show);
      if (m === "refuse") refuse = true;
    }
    if (ts.isReturnStatement(k) && k.expression && ts.isIdentifier(k.expression)) {
      // `return gone` where `const gone = { kind: "gone" }` sits in the same file
      walk(u.node.getSourceFile(), (d) => {
        const init = d.initializer && ts.isAsExpression(d.initializer) ? d.initializer.expression : d.initializer;
        if (ts.isVariableDeclaration(d) && d.name.getText() === k.expression.text && init && ts.isObjectLiteralExpression(init)) {
          const kp = prop(init, "kind");
          if (kp) walk(kp, (v) => { if (ts.isStringLiteral(v)) kinds.add(v.text); });
        }
      });
    }
    // `kind: ok ? "added" : "gone"` names two kinds: take each string in the value
    if (ts.isPropertyAssignment(k) && k.name.getText() === "kind") walk(k.initializer, (v) => { if (ts.isStringLiteral(v)) kinds.add(v.text); });
  });
  const fileKind = /\.server\./.test(u.file) ? "server" : "client";
  const declared = (prop(o, "depends")?.properties ?? []).map((p) => deps[p.name.getText()].show);
  out.push(`${fileKind.padEnd(9)} op ${role}: deps{${declared.sort().join(",")}} reads{${[...reads].sort()}} writes{${[...writes].sort()}} calls{${[...calls].sort()}} returns{${[...kinds].sort().join("|")}}${refuse ? " refuses" : ""}`);
}

// 5. page components: name dropped, hooks kept
const banned = /^(useState|useEffect|useReducer|useMemo|useLayoutEffect|useCallback|fetch|WebSocket|EventSource)$/;
for (const { sf, server, path } of src) {
  cur = path;
  if (server || !sf.fileName.endsWith("x")) continue;
  const comps = [];
  walk(sf, (n) => {
    let fn;
    // a component, or a hook of the page's own (`useTeam`): where the hooks sit is free
    const pageFn = /^([A-Z]|use[A-Z])/;
    if (ts.isFunctionDeclaration(n) && pageFn.test(n.name?.text ?? "")) fn = n;
    if (ts.isVariableDeclaration(n) && pageFn.test(n.name.getText())) fn = unwrap(n.initializer);
    if (fn && (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn))) comps.push(fn);
  });
  for (const fn of comps) {
    const uses = [];
    let hasData = false;
    walk(fn.body, (k) => {
      if (!ts.isCallExpression(k) && !ts.isNewExpression(k)) return;
      const c = k.expression.getText();
      let a = k.arguments?.[0]?.getText() ?? "";
      const localInit = (nm) => { let r; walk(fn.body, (d) => { if (ts.isVariableDeclaration(d) && d.name.getText() === nm && d.initializer) r = d.initializer.getText(); }); return r; };
      a = localInit(a) ?? a;
      a = a.replace(/\((\w+)\)$/, (_, v) => `(${localInit(v) ?? v})`);
      if (c === "useData") {
        hasData = true;
        const m = a.match(/^[\w.]+\.(\w+)\.(of|where)\(/) ?? a.match(/^[\w.]+\.(status)\(/);
        const sm = a.match(/^[\w.]+\.status\([\w.]+\.(\w+)\.(of|where)/);
        uses.push(sm ? `data status(${sm[1]}.${sm[2]})` : /^[\w.]+\.status\(\w+\)$/.test(a) ? "data status(prop)" : m ? `data ${m[1]}${m[2] ? "." + m[2] : ""}` : `data ${units.get(a)?.label ?? a}`);
      } else if (c === "useRun") {
        const m = a.match(/\["([^"]+)"\]/);
        uses.push(m ? `run ${m[1]}` : a.endsWith(".invalidate") ? "run invalidate" : `run ${units.get(a)?.label ?? a}`);
      } else if (banned.test(c)) uses.push(`BANNED ${c}`);
    });
    // component boundaries are free: each use counts once per file
    for (const use of uses) out.push(`page      ${use}`);
  }
}

const lines = [...new Set(out)].sort();
const golden = process.argv[3];
if (!golden) { console.log(lines.join("\n")); process.exit(0); }
const want = readFileSync(golden, "utf8").trim().split("\n");
const missing = want.filter((l) => !lines.includes(l)), extra = lines.filter((l) => !want.includes(l));
for (const l of missing) console.log(`- ${l}`);
for (const l of extra) console.log(`+ ${l}`);
console.log(`shape: ${want.length - missing.length}/${want.length} golden lines, ${extra.length} extra`);
process.exit(missing.length || extra.length ? 1 : 0);
