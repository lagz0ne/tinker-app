import { severities, statuses } from "./findings.mjs";

/**
 * Counts by severity and by status, then each open important finding on one line.
 * @param {object[]} findings - From the merged file; why: the state to sum up.
 */
export function summary(findings) {
  const count = (field, names) =>
    names.map((name) => `${name} ${findings.filter((f) => f[field] === name).length}`).join(", ");
  const important = findings.filter((f) => f.status === "open" && f.severity === "important");

  return [
    `severity: ${count("severity", severities)}`,
    `status: ${count("status", statuses)}`,
    ...(important.length > 0
      ? ["open important:", ...important.map((f) => `  ${oneLine(f)}`)]
      : []),
  ];
}

/**
 * The findings as a list: open first, then answered, then fixed; important first in each.
 * @param {object[]} findings - From readFindings; why: the list to print.
 */
export function findingList(findings) {
  const rank = (f) => statuses.indexOf(f.status) * 10 + severities.indexOf(f.severity);
  const sorted = findings.toSorted((a, b) => rank(a) - rank(b));
  if (sorted.length === 0) return ["no findings"];

  return sorted.flatMap((f) => [
    `${f.status} ${f.severity} ${oneLine(f)} (round ${f.round})`,
    ...(f.status === "answered" ? [`  reason: ${f.reason}`] : []),
    ...(f.status === "fixed" && f.sha ? [`  fixed at ${f.sha.slice(0, 12)}`] : []),
    ...(f.status === "open" ? [`  fix: ${f.fix}`] : []),
  ]);
}

/** @param {object} f - From the findings file; why: one finding to show on one line. */
function oneLine(f) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  return `${f.rule} ${where}: ${f.summary} [${f.id}]`;
}
