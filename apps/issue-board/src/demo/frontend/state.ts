import { data } from "@tinker/core";

import type { Sync } from "~/components/sync";

import type { Team } from "@/contracts/board";
import type { Issue } from "@/contracts/issues";
import type { Profile } from "@/demo/contracts/profile-contract";
import type { Todos } from "@/demo/contracts/todos-contract";

export const profile = data<Profile.Value | null>({
  label: "profile",
  initial: null,
});

export const nameDraft = data<string | undefined>({ label: "nameDraft", initial: undefined });
export const pending = data({ label: "pending", initial: false });
export const notice = data({ label: "notice", initial: "" });
export const authMode = data<"signup" | "signin">({ label: "authMode", initial: "signup" });
export const todos = data<Todos.Row[]>({ label: "todos", initial: [] });
export const counter = data({ label: "counter", initial: 0 });

export const profileResult = data<{ executionId: string; result: Sync.Result } | null>({
  label: "profile.result",
  initial: null,
});

export const teams = data<Team[]>({ label: "teams", initial: [] });

export const issues = data<Issue[]>({ label: "issues", initial: [] });
