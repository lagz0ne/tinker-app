import { data, operation } from "@tinkered/core";
import { z } from "zod";

// The tab's label filter: the board shows only the issues with this label. Empty shows all. It is
// the tab's own choice, so it is a cell of the tab, never served.

/** The label the board shows; empty for all. */
export const shownLabel = data({ label: "issues.shownLabel", initial: "" });

export const showLabel = operation({
  label: "issues.showLabel",
  input: z.object({ name: z.string() }),
  depends: { shown: shownLabel.controller },
  run: ({ shown }, { input }) => shown.set(input.name),
});
