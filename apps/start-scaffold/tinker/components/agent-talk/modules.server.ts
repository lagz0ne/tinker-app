import { resource } from "@tinker/core";

/** The Claude Agent SDK; apps also build their MCP servers with its `createSdkMcpServer` and `tool`. */
export const agentSdk = resource({
  label: "module:@anthropic-ai/claude-agent-sdk",
  target: "scope",
  factory: () => import("@anthropic-ai/claude-agent-sdk"),
});

/** Makes Claude Code's temp folder before the first query. */
export const agentFiles = resource({
  label: "module:node:fs/promises",
  target: "scope",
  factory: () => import("node:fs/promises"),
});
