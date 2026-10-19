import { severities, statuses } from "./findings.mjs";
import { ruleText } from "./rules.mjs";

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
 * @param {{ id: string, lines: string[] }[] | null} [rules] - From readRules, for --rules;
 *   why: each finding then shows its rule's text.
 */
export function findingList(findings, rules = null) {
  const rank = (f) => statuses.indexOf(f.status) * 10 + severities.indexOf(f.severity);
  const sorted = findings.toSorted((a, b) => rank(a) - rank(b));
  if (sorted.length === 0) return ["no findings"];

  const textOf = (id) => {
    const rule = rules?.find((entry) => entry.id === id);
    return rule ? ruleText(rule) : "not in this Start's rules.md";
  };
  return sorted.flatMap((f) => [
    `${f.status} ${f.severity} ${oneLine(f)} (round ${f.round})`,
    ...(rules ? [`  rule: ${textOf(f.rule)}`] : []),
    ...(f.status === "answered" ? [`  reason: ${f.reason}`] : []),
    ...(f.status === "fixed" && f.sha ? [`  fixed at ${f.sha.slice(0, 12)}`] : []),
    ...(f.status === "open" ? [`  fix: ${f.fix}`] : []),
  ]);
}

/**
 * The asked rules in the asked order, or every rule under its group heading.
 * @param {{ id: string, group: string, lines: string[] }[]} rules - From readRules.
 * @param {string[]} ids - From the command line; why: none means all.
 */
export function ruleLines(rules, ids) {
  if (ids.length > 0) {
    return ids.flatMap((id) => ["", ...rules.find((rule) => rule.id === id).lines]);
  }

  return rules.flatMap((rule, index) => [
    ...(rule.group !== rules[index - 1]?.group ? ["", `### ${rule.group}`, ""] : []),
    ...rule.lines,
  ]);
}

/** @param {object} f - From the findings file; why: one finding to show on one line. */
function oneLine(f) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  return `${f.rule} ${where}: ${f.summary} [${f.id}]`;
}
