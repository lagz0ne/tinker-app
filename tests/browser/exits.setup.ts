import { afterAll } from "vite-plus/test";
import { commands } from "vite-plus/test/browser/context";

/** Leaves the page's exits where `tinker check` reads them: one file a test file. */
afterAll(async () => {
  const exits = localStorage.getItem("tinker.exits");
  if (exits) await commands.writeFile(`.tinker/exits/${crypto.randomUUID()}.json`, exits);
});
