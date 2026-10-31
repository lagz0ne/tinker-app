import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createScope, operation, tag } from "@tinker/core";
import type { Observe, Tag } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { z } from "zod";

import { raise } from "~/components/errors";
import { handleMcp, mcpRuns, mcpServer, mcpTools } from "~/components/mcp/index.server";
import type { McpTool } from "~/components/mcp/index.server";

const who = tag<string>({ label: "who" });

const greetInput = z.object({ name: z.string().max(40).describe("Who to greet.") });

const greet = operation({
  label: "tool.greet",
  input: greetInput,
  run: (_, { input }) => ({ text: `Hello ${input.name}.` }),
});

const countInput = z.object({ n: z.number() });

const counted = { parses: 0 };

const countedInput = z.object({
  n: z.number().transform((n) => {
    counted.parses += 1;

    return n;
  }),
});

const total = operation({
  label: "tool.total",
  input: countInput,
  run: (_, { input }) => ({ text: `Total ${input.n}.`, data: { total: input.n } }),
});

const once = operation({
  label: "tool.once",
  input: countedInput,
  run: (_, { input }) => `Seen ${input.n}.`,
});

const empty = z.object({});

const refuse = operation({
  label: "tool.refuse",
  input: empty,
  run: () => raise("Refused", { message: "x" }),
});

const boom = operation({
  label: "tool.boom",
  input: empty,
  run: () => {
    throw new Error("secret detail");
  },
});

const whoami = operation({
  label: "tool.whoami",
  input: empty,
  depends: { who },
  run: ({ who }) => who,
});

const waits = { aborted: false, started: Promise.withResolvers<void>() };

const slow = operation({
  label: "tool.slow",
  input: empty,
  run: (_, { signal }) => {
    waits.started.resolve();

    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        waits.aborted = true;
        reject(signal.reason);
      });
    });
  },
});

const tools = mcpTools([
  {
    name: "greet",
    title: "Greet",
    description: "Say hello.",
    hints: { readOnlyHint: true },
    input: greetInput,
    run: greet,
  },
  { name: "total", title: "Total", description: "Add up.", input: countInput, run: total },
  { name: "once", title: "Once", description: "Parse once.", input: countedInput, run: once },
  { name: "refuse", title: "Refuse", description: "Say no.", input: empty, run: refuse },
  { name: "boom", title: "Boom", description: "Break.", input: empty, run: boom },
  { name: "whoami", title: "Who am I", description: "Name the caller.", input: empty, run: whoami },
  { name: "slow", title: "Slow", description: "Wait for a cancel.", input: empty, run: slow },
]);

const server = mcpServer({ name: "test-app", version: "1.0.0", instructions: "Test tools." });

/** A root with the MCP extension, recording spans and log lines. */
async function root() {
  const spans: Observe.Span[] = [];
  const lines: Observe.Log[] = [];
  const scope = createScope({
    extensions: [mcpRuns],
    tags: [server, tools],
    observe: { export: (span) => spans.push(span), log: (line) => lines.push(line) },
  });

  await scope.ready;

  return { scope, spans, lines };
}

type Root = Awaited<ReturnType<typeof root>>;

/** The real SDK client; its fetch runs handleMcp in the root, with no socket. */
async function connect({ scope }: Root, tags: Tag.Bindings = []) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://app.test/mcp"), {
    fetch: async (url, init) => {
      const request = new Request(url, init);

      return await scope.run(handleMcp, { input: request, tags, signal: request.signal });
    },
  });

  await client.connect(transport);

  return client;
}

/** One raw JSON-RPC POST, as a client with no initialize state sends it. */
function post(body: unknown, signal?: AbortSignal) {
  return new Request("http://app.test/mcp", {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

test("M1: tools/list shows every tool in tag order with its zod input and hints", async () => {
  const app = await root();
  const client = await connect(app);

  const { tools: listed } = await client.listTools();

  expect(listed.map((tool) => tool.name)).toEqual([
    "greet",
    "total",
    "once",
    "refuse",
    "boom",
    "whoami",
    "slow",
  ]);
  expect(listed[0]).toMatchObject({
    name: "greet",
    title: "Greet",
    description: "Say hello.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", maxLength: 40, description: "Who to greet." } },
      required: ["name"],
    },
    annotations: { title: "Greet", readOnlyHint: true },
  });
  expect(listed[1].annotations).toEqual({ title: "Total" });

  await client.close();
  await app.scope.close();
});

test("M2: a call returns the tool's text with no isError", async () => {
  const app = await root();
  const client = await connect(app);

  const reply = await client.callTool({ name: "greet", arguments: { name: "Ada" } });

  expect(reply).toEqual({ content: [{ type: "text", text: "Hello Ada." }] });

  await client.close();
  await app.scope.close();
});

test("M3: a tool's data becomes structuredContent beside its text", async () => {
  const app = await root();
  const client = await connect(app);

  const reply = await client.callTool({ name: "total", arguments: { n: 3 } });

  expect(reply).toEqual({
    content: [{ type: "text", text: "Total 3." }],
    structuredContent: { total: 3 },
  });

  await client.close();
  await app.scope.close();
});

test("M4: bad input names the field and the tool never runs", async () => {
  const app = await root();
  const client = await connect(app);

  for (const args of [{ name: 5 }, {}, { name: "a".repeat(41) }]) {
    const reply = await client.callTool({ name: "greet", arguments: args });

    expect(reply.isError).toBe(true);
    expect(reply.content).toEqual([
      { type: "text", text: expect.stringMatching(/^Not done: name: /) },
    ]);
  }
  expect(app.spans.filter((span) => span.name === "tool.greet").map((span) => span.status)).toEqual(
    ["failed", "failed", "failed"],
  );

  await client.close();
  await app.scope.close();
});

test("M5: the tool's input is parsed once", async () => {
  const app = await root();
  const client = await connect(app);

  counted.parses = 0;
  const reply = await client.callTool({ name: "once", arguments: { n: 2 } });

  expect(reply).toEqual({ content: [{ type: "text", text: "Seen 2." }] });
  expect(counted.parses).toBe(1);

  await client.close();
  await app.scope.close();
});

test("M6: each tool call is one run span inside the handleMcp run", async () => {
  const app = await root();
  const client = await connect(app);

  await client.callTool({ name: "greet", arguments: { name: "Ada" } });
  await client.callTool({ name: "greet", arguments: { name: "Bo" } });

  const runs = app.spans.filter((span) => span.name === "tool.greet");

  expect(runs).toHaveLength(2);

  for (const run of runs) {
    expect(run.kind).toBe("operation");

    const call = app.spans.find((span) => span.id === run.parentId);

    expect(call?.name).toBe("mcp.tool");
    expect(app.spans.find((span) => span.id === call?.parentId)?.name).toBe("handleMcp");
  }
  expect(new Set(runs.map((run) => run.parentId)).size).toBe(2);

  await client.close();
  await app.scope.close();
});

test("M7: a Refused error is the reply's reason", async () => {
  const app = await root();
  const client = await connect(app);

  const reply = await client.callTool({ name: "refuse", arguments: {} });

  expect(reply).toEqual({ isError: true, content: [{ type: "text", text: "Not done: x" }] });

  await client.close();
  await app.scope.close();
});

test("M8: any other failure says the tool failed, hides detail, and logs the tool once", async () => {
  const app = await root();
  const client = await connect(app);

  const reply = await client.callTool({ name: "boom", arguments: {} });

  expect(reply).toEqual({
    isError: true,
    content: [{ type: "text", text: "Not done: the tool failed." }],
  });
  expect(JSON.stringify(reply)).not.toContain("secret");
  expect(app.lines.filter((line) => line.attributes.tool === "boom")).toHaveLength(1);

  await client.close();
  await app.scope.close();
});

test("M9: an unknown tool name is a reply, not a protocol error", async () => {
  const app = await root();
  const client = await connect(app);

  const reply = await client.callTool({ name: "nope", arguments: {} });

  expect(reply).toEqual({
    isError: true,
    content: [{ type: "text", text: 'Not done: there is no tool "nope".' }],
  });

  await client.close();
  await app.scope.close();
});

test("M10: the caller's tags on the handleMcp call reach the tool", async () => {
  const app = await root();
  const signedIn = await connect(app, [who("U")]);

  expect(await signedIn.callTool({ name: "whoami", arguments: {} })).toEqual({
    content: [{ type: "text", text: "U" }],
  });

  const anonymous = await connect(app);

  expect(await anonymous.callTool({ name: "whoami", arguments: {} })).toEqual({
    isError: true,
    content: [{ type: "text", text: "Not done: the tool failed." }],
  });

  await signedIn.close();
  await anonymous.close();
  await app.scope.close();
});

test("M11: GET and DELETE get 405 with Allow: POST", async () => {
  const app = await root();

  for (const method of ["GET", "DELETE"]) {
    const reply = await app.scope.run(handleMcp, {
      input: new Request("http://app.test/mcp", { method }),
    });

    expect(reply.status).toBe(405);
    expect(reply.headers.get("allow")).toBe("POST");
  }

  await app.scope.close();
});

test("M12: the server keeps no session between requests", async () => {
  const app = await root();
  const first = await connect(app);

  await first.listTools();

  const fresh = await app.scope.run(handleMcp, {
    input: post({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  expect(fresh.status).toBe(200);
  expect(fresh.headers.get("mcp-session-id")).toBeNull();
  expect((await fresh.json()).result.tools).toHaveLength(7);

  const second = await connect(app);

  expect((await second.listTools()).tools).toHaveLength(7);

  const builds = app.spans.filter((span) => span.kind === "resource").map((span) => span.name);

  expect(builds.toSorted()).toEqual([
    "module:@modelcontextprotocol/sdk/server/index.js",
    "module:@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
    "module:@modelcontextprotocol/sdk/types.js",
  ]);

  await first.close();
  await second.close();
  await app.scope.close();
});

test("M13: a duplicate or bad tool name fails the tag parse at bind, naming the tool", () => {
  const row = { title: "T", description: "D", input: empty, run: refuse };

  const cases: [McpTool[], string][] = [
    [
      [
        { ...row, name: "twice" },
        { ...row, name: "twice" },
      ],
      '"twice"',
    ],
    [[{ ...row, name: "Bad-Name" }], '"Bad-Name"'],
  ];

  for (const [rows, named] of cases) {
    expect(() => mcpTools(rows)).toThrow(
      expect.objectContaining({
        kind: "DataValidationFailed",
        payload: expect.objectContaining({
          label: "mcp.tools",
          cause: expect.objectContaining({
            payload: {
              issues: [expect.objectContaining({ message: expect.stringContaining(named) })],
            },
          }),
        }),
      }),
    );
  }
});

test("M14: a cancelled request aborts the tool and settles handleMcp", async () => {
  const app = await root();
  const stop = new AbortController();

  waits.aborted = false;
  waits.started = Promise.withResolvers<void>();

  const running = app.scope.settle(handleMcp, {
    input: post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {} } },
      stop.signal,
    ),
    signal: stop.signal,
  });

  await waits.started.promise;
  stop.abort();

  expect((await running).status).toBe("cancelled");
  expect(waits.aborted).toBe(true);

  await app.scope.close();
});
