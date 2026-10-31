import { resource } from "@tinker/core";

export const sdkServerModule = resource({
  label: "module:@modelcontextprotocol/sdk/server/index.js",
  target: "scope",
  factory: () => import("@modelcontextprotocol/sdk/server/index.js"),
});

export const sdkTransportModule = resource({
  label: "module:@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
  target: "scope",
  factory: () => import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
});

export const sdkTypesModule = resource({
  label: "module:@modelcontextprotocol/sdk/types.js",
  target: "scope",
  factory: () => import("@modelcontextprotocol/sdk/types.js"),
});
