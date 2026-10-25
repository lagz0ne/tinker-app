import { join } from "node:path";

import { createServer, createServerModuleRunner } from "vite";
import { expect, onTestFinished, test } from "vite-plus/test";

import { installDevServer } from "../lib/main-host.mjs";
import { baseDir } from "../lib/paths.mjs";
import { fixture } from "./fixture.mjs";

/** The app command the dev entry runs; each test sets what it does. */
const command = `
export const control = { calls: [], run: undefined };

export default function main(inputs) {
  control.calls.push(inputs);
  return control.run(inputs);
}
`;

/** A command that serves until its signal aborts, and answers with its call count. */
const serving =
  (control) =>
  ({ signal }) => ({
    closed: new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    fetch: (request) => new Response(`${control.calls.length} ${new URL(request.url).pathname}`),
  });

/**
 * A Vite dev server in this process with the glue's server-main alias and app root, its SSR
 * runner, the dev entry that `vite dev` runs, and the command it imports. Vite's close joins
 * the command, as `tinker()` installs it; the test's end closes it and resets the exit code.
 */
async function devServer({ hmr = true } = {}) {
  const root = fixture({ "cmds/server.mjs": command });
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, ws: false },
    resolve: {
      alias: [{ find: /^#tinker\/server-main$/, replacement: join(root, "cmds/server.mjs") }],
    },
    define: { "import.meta.env.TINKER_APP_ROOT": JSON.stringify(root) },
  });
  const exits = [];
  installDevServer(root, server, (code) => exits.push(code));
  onTestFinished(async () => {
    await server.close();
    process.exitCode = undefined;
  });

  const runner = createServerModuleRunner(server.environments.ssr, { hmr });
  const { control } = await runner.import(join(root, "cmds/server.mjs"));
  const { default: entry } = await runner.import(join(baseDir, "lib/dev-server.mjs"));
  return { root, server, entry, control, exits };
}

test("the first request starts the command once, with the process env, no args, and fetch", async () => {
  const { entry, control } = await devServer();
  control.run = serving(control);

  const first = await entry.fetch(new Request("http://app/one"));
  const second = await entry.fetch(new Request("http://app/two"));

  expect(await first.text()).toBe("1 /one");
  expect(await second.text()).toBe("1 /two");
  expect(control.calls).toHaveLength(1);
  expect(control.calls[0]).toMatchObject({ env: process.env, args: [], stdout: process.stdout });
  expect(control.calls[0].stderr).toBe(process.stderr);
});

test("a command with no fetch answers 503 and closes the dev server with exit 1", async () => {
  const { entry, control, exits } = await devServer();
  control.run = () => ({ closed: Promise.resolve() });

  const reply = await entry.fetch(new Request("http://app/"));

  expect(reply.status).toBe(503);
  expect(control.calls[0].signal.reason).toMatchObject({
    name: "TypeError",
    message: "server main must return fetch",
  });
  await expect.poll(() => exits).toEqual([1]);
  expect(process.exitCode).toBe(1);
});

test("a command that fails to start fails its request, and the next request starts it again", async () => {
  const { entry, control } = await devServer();
  const failure = new Error("start failed");
  control.run = () => {
    throw failure;
  };

  await expect(entry.fetch(new Request("http://app/"))).rejects.toBe(failure);

  control.run = serving(control);
  const reply = await entry.fetch(new Request("http://app/"));
  expect(await reply.text()).toBe("2 /");
});

test("a command that exits during start answers 503 and closes the dev server with its code", async () => {
  const { entry, control, exits } = await devServer();
  control.run = ({ exit }) => {
    exit(3);
    return { closed: Promise.resolve(), fetch: () => new Response("never") };
  };

  const reply = await entry.fetch(new Request("http://app/"));

  expect(reply.status).toBe(503);
  expect(await reply.text()).toBe("Command stopped");
  await expect.poll(() => exits).toEqual([3]);
  expect(process.exitCode).toBe(3);
});

test("a full reload stops the command and the next request starts a new one", async () => {
  const { server, entry, control, exits } = await devServer();
  const signals = [];
  control.run = (inputs) => {
    signals.push(inputs.signal);
    return serving(control)(inputs);
  };
  await entry.fetch(new Request("http://app/"));

  server.environments.ssr.hot.send({ type: "full-reload" });

  await expect.poll(() => signals[0].aborted).toBe(true);
  expect(exits).toEqual([]);
  const reply = await entry.fetch(new Request("http://app/"));
  expect(await reply.text()).toBe("2 /");
});

test("Vite's close stops the running command and exits with its code", async () => {
  const { server, entry, control, exits } = await devServer();
  control.run = serving(control);
  await entry.fetch(new Request("http://app/"));

  await server.close();

  expect(exits).toEqual([0]);
});

test("a start that fails after a reload keeps the command the reload started", async () => {
  const { server, entry, control } = await devServer();
  const late = Promise.withResolvers();
  control.run = () => late.promise;
  const first = entry.fetch(new Request("http://app/"));
  first.catch(() => {});

  server.environments.ssr.hot.send({ type: "full-reload" });
  await expect.poll(() => control.calls[0].signal.aborted).toBe(true);
  control.run = serving(control);
  expect(await (await entry.fetch(new Request("http://app/"))).text()).toBe("2 /");

  late.reject(new Error("late start failure"));
  await expect(first).rejects.toThrow("late start failure");
  expect(await (await entry.fetch(new Request("http://app/"))).text()).toBe("2 /");
});

test("a reload or a prune before any request has no command to stop", async () => {
  const { server, entry, control } = await devServer();
  const ssr = server.environments.ssr;
  const [module] = ssr.moduleGraph.getModulesByFile(join(baseDir, "lib/dev-server.mjs"));

  ssr.hot.send({ type: "prune", paths: [module.url] });
  ssr.hot.send({ type: "full-reload" });

  control.run = serving(control);
  await expect.poll(async () => (await entry.fetch(new Request("http://app/"))).status).toBe(200);
});

test("a prune of the dev entry stops its command", async () => {
  const { server, entry, control, exits } = await devServer();
  control.run = serving(control);
  await entry.fetch(new Request("http://app/"));
  const ssr = server.environments.ssr;
  const [module] = ssr.moduleGraph.getModulesByFile(join(baseDir, "lib/dev-server.mjs"));

  ssr.hot.send({ type: "prune", paths: [module.url] });

  await expect.poll(() => control.calls[0].signal.aborted).toBe(true);
  expect(exits).toEqual([]);
});

test("with HMR off the dev entry still serves", async () => {
  const { entry, control } = await devServer({ hmr: false });
  control.run = serving(control);

  const reply = await entry.fetch(new Request("http://app/"));

  expect(await reply.text()).toBe("1 /");
});
