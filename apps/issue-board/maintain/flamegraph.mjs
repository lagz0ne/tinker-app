import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// V8 samples carry elapsed microseconds. Idle samples are left out of CPU totals.
// No source map, library, browser script, or network fetch is needed by the SVG.
const [input, output = input.replace(/\.cpuprofile$/, ".svg")] = process.argv.slice(2);
const profile = JSON.parse(readFileSync(input, "utf8"));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();

for (const node of nodes.values()) {
  for (const child of node.children ?? []) parents.set(child, node.id);
  node.self = 0;
  node.total = 0;
}

for (let index = 0; index < profile.samples.length; index += 1) {
  const node = nodes.get(profile.samples[index]);
  if (["(idle)", "(program)"].includes(node.callFrame.functionName)) continue;
  const weight = Math.max(0, profile.timeDeltas[index] ?? 0);
  node.self += weight;
  let current = node;

  while (current) {
    current.total += weight;
    current = nodes.get(parents.get(current.id));
  }
}

const sources = new Map();

function sourceLines(source) {
  if (!sources.has(source)) {
    try {
      sources.set(source, readFileSync(source, "utf8").split("\n"));
    } catch {
      sources.set(source, []);
    }
  }
  return sources.get(source);
}

function frame(node) {
  const call = node.callFrame;
  let name = call.functionName || "(anonymous)";
  let source = call.url;
  if (source.startsWith("file:")) source = fileURLToPath(source);

  if (source.startsWith("/")) {
    const lines = sourceLines(source);
    const at = call.lineNumber;
    if (["run", "factory"].includes(name)) {
      const previous = lines
        .slice(Math.max(0, at - 220), at + 1)
        .join("\n")
        .split("//#endregion")
        .at(-1);
      const labels = [...previous.matchAll(/label: ["']([^"']+)["']/g)];
      if (labels.length) name = `${labels.at(-1)[1]}.${name}`;
    }
  }
  return { name, file: source ? basename(source) : "V8", line: call.lineNumber + 1 };
}

const grouped = new Map();

for (const node of nodes.values()) {
  const info = frame(node);
  const key = `${info.name} (${info.file}:${info.line})`;
  grouped.set(key, (grouped.get(key) ?? 0) + node.self);
}

const top = [...grouped].sort((a, b) => b[1] - a[1]).slice(0, 5);
const root = profile.nodes[0];
const total = root.total;

const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c],
  );

const width = 1500;
const heightStep = 20;
let depth = 0;
const boxes = [];

function draw(node, x, level) {
  if (node.total <= 0) return;
  depth = Math.max(depth, level);
  const w = (node.total / total) * (width - 32);
  const info = frame(node);
  const hue = [...info.name].reduce((hash, c) => (hash * 31 + c.charCodeAt(0)) >>> 0, 0) % 55;

  const sourcePath = node.callFrame.url.startsWith("file:")
    ? fileURLToPath(node.callFrame.url)
    : node.callFrame.url;
  const sourceLines = sources.get(sourcePath) ?? [];
  const ticks = (node.positionTicks ?? [])
    .map(
      ({ line, ticks }) =>
        `line ${line}: ${ticks} ticks: ${(sourceLines[line - 1] ?? "").trim().slice(0, 240)}`,
    )
    .join("\n");
  const title = `${info.name}\n${node.callFrame.url}:${info.line}\nself ${node.self} µs; stack ${node.total} µs; ${(node.total / total) * 100}% of sampled CPU\nSampled source lines (first 240 characters):\n${ticks}`;

  boxes.push(
    `<g><title>${esc(title)}</title><rect x="${x}" y="${100 + level * heightStep}" width="${Math.max(0, w - 0.25)}" height="19" fill="hsl(${hue} 85% 70%)" stroke="#fff" stroke-width="0.25"/>${w > 30 ? `<text x="${x + 3}" y="${114 + level * heightStep}">${esc(info.name.slice(0, Math.floor((w - 6) / 7)))}</text>` : ""}</g>`,
  );
  let offset = x;

  for (const id of node.children ?? []) {
    const child = nodes.get(id);
    draw(child, offset, level + 1);
    offset += (child.total / total) * (width - 32);
  }
}

draw(root, 16, 0);
const footer = 140 + (depth + 1) * heightStep;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${footer + 180}" viewBox="0 0 ${width} ${footer + 180}" role="img" aria-label="${esc(basename(input))} CPU flamegraph"><style>text{font:12px monospace;fill:#16202a}g:hover rect{stroke:#172554;stroke-width:1.5}</style><rect width="100%" height="100%" fill="#fff"/><text x="16" y="30" style="font:bold 20px sans-serif">${esc(basename(input))}</text><text x="16" y="55">CPU samples, root at top; hover a frame for source and sample weight.</text><text x="16" y="76">Startup and shutdown included. Idle and program samples excluded. Width is sampled CPU, not request latency.</text>${boxes.join("")}<text x="16" y="${footer}">Top five self frames (µs of samples):</text>${top.map(([name, value], i) => `<text x="16" y="${footer + 24 + i * 23}">${esc(`${i + 1}. ${name}: ${value}`)}</text>`).join("")}</svg>`;
writeFileSync(output, svg);

const report = {
  profile: basename(input),
  totalCpuSampleMicroseconds: total,
  topFive: top.map(([frame, selfMicroseconds]) => ({ frame, selfMicroseconds })),
  frames: [...grouped]
    .filter(([, value]) => value > 0)
    .map(([frame, selfMicroseconds]) => ({ frame, selfMicroseconds })),
};

writeFileSync(output.replace(/\.svg$/, ".frames.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ profile: report.profile, topFive: report.topFive }));
