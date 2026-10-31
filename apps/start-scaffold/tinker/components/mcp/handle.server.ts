import { extension, isError as isCoreError, operation, parse } from "@tinker/core";
import { z } from "zod";

import { isError, raise } from "~/components/errors";

import { sdkServerModule, sdkTransportModule, sdkTypesModule } from "./modules";
import { mcpServer, mcpTools } from "./tools.server";
import type { McpReply } from "./tools.server";

/** How one tool call ended: its reply, Core's cancel, or the reason the reply gives. */
type ToolEnd =
  | { status: "success"; value: McpReply }
  | { status: "cancelled"; reason: unknown }
  | { status: "notDone"; why: string };

const toolCall = z.object({ name: z.string(), arguments: z.unknown() });

/**
 * One tool call. An operation body cannot run an operation it picks at run time, so the
 * `mcpRuns` extension answers this call: it runs the tool in the caller's layer, with the
 * caller's tags, and says how the run ended. Without the extension this body says so.
 */
const callTool = operation({
  label: "mcp.tool",
  input: toolCall,
  run: async (): Promise<ToolEnd> => raise("McpNotInstalled", {}),
});

/**
 * Runs each `mcp.tool` call as one Core run of the tool's operation. The raw `arguments` go in
 * as `rawInput`, so the operation's own input parse is the only parse. A managed `Refused` and
 * bad input become the reply's reason; any other failure is logged once and hides its detail.
 * Startup checks the server and tool tags before ready.
 */
export const mcpRuns = extension({
  label: "mcp.runs",
  hooks: {
    async start({ resolve, next }) {
      resolve(mcpServer);
      resolve(mcpTools);
      await next();
    },
    run(event) {
      if (event.op !== callTool) return event.next();

      const call = parse(toolCall, event.call?.input);
      const tool = event.resolve(mcpTools).find((entry) => entry.name === call.name);
      if (tool === undefined) return { status: "notDone", why: `there is no tool "${call.name}".` };

      const settled = event.settle(tool.run, { rawInput: call.arguments, signal: event.signal });

      return Promise.resolve(settled).then((result): ToolEnd => {
        if (result.status !== "failed") return result;

        const { error } = result;
        if (isError(error, "Refused")) return { status: "notDone", why: error.payload.message };

        const cause = isCoreError(error, "DataValidationFailed") ? error.payload : undefined;
        if (cause?.label === tool.run.label && isCoreError(cause.cause, "SchemaRejected")) {
          const issues = cause.cause.payload.issues.map(({ path = [], message }) => {
            const field = path.map((key) => String(typeof key === "object" ? key.key : key));

            return `${field.join(".") || "arguments"}: ${message}`;
          });

          return { status: "notDone", why: issues.join("; ") };
        }

        event.log.error("mcp tool failed", { tool: call.name });

        return { status: "notDone", why: "the tool failed." };
      });
    },
  },
});

/**
 * ADR 0103's named protocol exception, as `handleAuth`: the MCP SDK owns the Streamable HTTP
 * contract, so this operation hands it the whole request and returns its reply. The app has
 * already checked the caller and bound the caller's tags on this call. Stateless, as obelisk:
 * a new SDK server and transport per request, both closed when the reply is done.
 */
export const handleMcp = operation({
  label: "handleMcp",
  input: z.instanceof(Request),
  depends: {
    info: mcpServer,
    tools: mcpTools,
    callTool,
    sdk: sdkServerModule,
    web: sdkTransportModule,
    types: sdkTypesModule,
  },
  run: async ({ info, tools, callTool, sdk, web, types }, { input, signal }) => {
    if (input.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }

    signal.throwIfAborted();

    const server = new sdk.Server(
      { name: info.name, version: info.version },
      { capabilities: { tools: {} }, instructions: info.instructions },
    );
    const transport = new web.WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    server.setRequestHandler(types.ListToolsRequestSchema, () => ({
      tools: tools.map(({ name, title, description, hints, input }) => ({
        name,
        title,
        description,
        inputSchema: { ...z.toJSONSchema(input, { io: "input" }), type: "object" as const },
        annotations: { title, ...hints },
      })),
    }));

    server.setRequestHandler(types.CallToolRequestSchema, async ({ params }) => {
      const end = await callTool.run({
        input: { name: params.name, arguments: params.arguments },
      });

      if (end.status === "cancelled") throw end.reason;

      if (end.status === "notDone") {
        return { isError: true, content: [{ type: "text", text: `Not done: ${end.why}` }] };
      }

      const reply = typeof end.value === "string" ? { text: end.value } : end.value;

      return {
        content: [{ type: "text", text: reply.text }],
        ...(reply.data === undefined ? {} : { structuredContent: reply.data }),
      };
    });

    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(signal.reason);

    signal.addEventListener("abort", abort, { once: true });

    try {
      await server.connect(transport);

      return await Promise.race([transport.handleRequest(input), aborted.promise]);
    } finally {
      signal.removeEventListener("abort", abort);

      await transport.close();
      await server.close();
    }
  },
});
