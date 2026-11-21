// SlopCodeBench metrics on TS/TSX: erosion (Sec 2.3) + clone share.
// mass(f)=CC(f)*sqrt(SLOC(f)); erosion = sum mass[CC>10] / sum mass.
const ts = require(process.env.TS_PATH || "typescript");
const fs = require("fs");
const isFn = (n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isGetAccessor(n) ||
  ts.isSetAccessor(n) ||
  ts.isConstructorDeclaration(n);
function decisions(node) {
  let c = 0;
  const walk = (n) => {
    if (n !== node && isFn(n)) return;
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.CaseClause:
        c++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const k = n.operatorToken.kind;
        if (
          k === ts.SyntaxKind.AmpersandAmpersandToken ||
          k === ts.SyntaxKind.BarBarToken ||
          k === ts.SyntaxKind.QuestionQuestionToken
        )
          c++;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return c + 1;
}
function sloc(sf, node) {
  const own = new Set();
  const s = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line,
    e = sf.getLineAndCharacterOfPosition(node.end).line;
  const inner = [];
  const w = (n) => {
    if (n !== node && isFn(n)) {
      inner.push([
        sf.getLineAndCharacterOfPosition(n.getStart(sf)).line,
        sf.getLineAndCharacterOfPosition(n.end).line,
      ]);
      return;
    }
    ts.forEachChild(n, w);
  };
  w(node);
  const lines = sf.text.split("\n");
  let k = 0;
  for (let i = s; i <= e; i++) {
    if (inner.some(([a, b]) => i > a && i <= b && !(i === a))) continue;
    const t = lines[i].trim();
    if (t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) k++;
  }
  return Math.max(k, 1);
}
function clones(text, W = 6) {
  const L = text.split("\n").map((l) => l.trim());
  const idx = [];
  L.forEach((l, i) => {
    if (l.length > 3 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("import"))
      idx.push(i);
  });
  const seen = new Map(),
    hit = new Set();
  for (let j = 0; j + W <= idx.length; j++) {
    const key = idx
      .slice(j, j + W)
      .map((i) => L[i])
      .join("\n");
    if (seen.has(key)) {
      for (const i of idx.slice(j, j + W)) hit.add(i);
      for (const i of seen.get(key)) hit.add(i);
    } else seen.set(key, idx.slice(j, j + W));
  }
  return { clone: hit.size, loc: idx.length };
}
const files = process.argv.slice(2);
let num = 0,
  den = 0,
  locT = 0,
  cloneT = 0,
  fns = 0,
  hi = 0,
  maxcc = 0,
  maxName = "";
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const sf = ts.createSourceFile(
    f,
    text,
    ts.ScriptTarget.Latest,
    true,
    f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const v = (n) => {
    if (isFn(n)) {
      const cc = decisions(n),
        sl = sloc(sf, n),
        m = cc * Math.sqrt(sl);
      den += m;
      fns++;
      if (cc > 10) {
        num += m;
        hi++;
      }
      if (cc > maxcc) {
        maxcc = cc;
        maxName =
          f.split("/").slice(-2).join("/") +
          ":" +
          (sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(n, v);
  };
  v(sf);
  const c = clones(text);
  locT += c.loc;
  cloneT += c.clone;
}
console.log(
  JSON.stringify({
    files: files.length,
    loc: locT,
    fns,
    ccOver10: hi,
    maxcc,
    maxAt: maxName,
    erosion: +(den ? num / den : 0).toFixed(3),
    cloneShare: +(locT ? cloneT / locT : 0).toFixed(3),
  }),
);
