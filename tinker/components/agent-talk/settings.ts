import { tag } from "@tinker/core";
import { z } from "zod";

/** One Claude credential, an OAuth token or an API key; unbound means not signed in. */
export const agentCredentials = tag<{ oauthToken: string } | { apiKey: string }>({
  label: "agentTalk.credentials",
  parse: z.union([
    z.strictObject({ oauthToken: z.string().min(1) }),
    z.strictObject({ apiKey: z.string().min(1) }),
  ]),
});

/** Claude Code's HOME and config dir; its temp files go in `tmp` inside it. */
export const agentConfigDir = tag<string>({
  label: "agentTalk.configDir",
  parse: z.string().min(1),
});

/** The PATH Claude Code runs with; the server's own PATH never goes through. */
export const agentPath = tag<string>({
  label: "agentTalk.path",
  default: "/usr/local/bin:/usr/bin:/bin",
  parse: z.string().min(1),
});

/** Most queries at once, runs and pings together; the rest wait in call order. */
export const agentMaxRunning = tag<number>({
  label: "agentTalk.maxRunning",
  default: 3,
  parse: z.number().int().positive(),
});
