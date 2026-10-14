/**
 * A blank line after the imports and around each multi-line top-level statement. One-line
 * statements may sit together. Bodies are left alone. Oxfmt keeps blank lines but never adds
 * them, so this rule adds them through `vp lint --fix`.
 */
const blankLines = {
  meta: {
    type: "layout",
    fixable: "whitespace",
    messages: { blank: "Add a blank line before this statement." },
  },
  create(context) {
    const code = context.sourceCode;
    const oneLine = (node) => node.loc.start.line === node.loc.end.line;
    const isImport = (node) => node.type === "ImportDeclaration";
    const mayTouch = (prev, next) =>
      (isImport(prev) && isImport(next)) || (!isImport(prev) && oneLine(prev) && oneLine(next));

    const lineEnd = (node) =>
      code
        .getCommentsAfter(node)
        .filter((comment) => comment.loc.start.line === node.loc.end.line)
        .at(-1) ?? node;
    return {
      Program(program) {
        program.body.forEach((next, index) => {
          const prev = program.body[index - 1];
          if (!prev || mayTouch(prev, next)) return;
          const top = code.getCommentsBefore(next)[0] ?? next;
          const end = lineEnd(prev);
          if (top.loc.start.line - end.loc.end.line > 1) return;

          context.report({
            node: next,
            messageId: "blank",
            fix: (fixer) => fixer.insertTextAfter(end, "\n"),
          });
        });
      },
    };
  },
};

/**
 * A block of six or more statements reads as steps, with a blank line between them (coding
 * convention rule 14). Which lines form a step is the writer's call, so there is no fix; the rule
 * only flags a block that has no step break at all.
 */
const bodySteps = {
  meta: {
    type: "layout",
    messages: { steps: "Split this block into steps with a blank line between them." },
  },
  create(context) {
    const code = context.sourceCode;
    const gapAfter = (prev, next) => {
      const top = code.getCommentsBefore(next)[0] ?? next;
      return top.loc.start.line - prev.loc.end.line > 1;
    };
    return {
      BlockStatement(block) {
        const body = block.body;
        if (body.length < 6) return;
        if (body.some((next, index) => index > 0 && gapAfter(body[index - 1], next))) return;
        context.report({ node: block, messageId: "steps" });
      },
    };
  },
};

export default {
  meta: { name: "tinker" },
  rules: { "blank-lines": blankLines, "body-steps": bodySteps },
};
