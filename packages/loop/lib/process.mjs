import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/** A command with no `timeout` stops after 20 minutes. */
export const defaultTimeoutMs = 20 * 60 * 1000;

/** The longest timer Node can set; a longer one fires at once. */
const maxTimeoutMs = 2_147_483_647;

/** After SIGTERM, a stopped command's group has this long to end before SIGKILL. */
const killGraceMs = 5000;

/**
 * Why a loop.json `timeout` is not usable, or null when it is fine or left out.
 * @param {unknown} timeout - From loop.json; why: Node timers take whole ms up to 2^31 - 1.
 */
export function timeoutProblem(timeout) {
  if (timeout === undefined) return null;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    return "must be a positive whole number of milliseconds";
  }
  return timeout > maxTimeoutMs ? `must be at most ${maxTimeoutMs} ms, about 24 days` : null;
}

/**
 * Run one command in its own process group. Its stdin is the `input` file, or empty when
 * there is none. A string runs in a shell; an array runs as is, without a shell. On its timeout or on `signal`, the whole group gets
 * SIGTERM, then SIGKILL after 5 seconds, so no child of it lives on. Resolves null when it
 * exited 0, else how it ended.
 * @param {string} app - From a tool; why: the command's working folder.
 * @param {{ command: string | string[], timeout?: number, input?: string, out: string,
 *   err?: string }} job - From a tool; why: what to run, its timeout (20 minutes when none),
 *   the file for stdin, and the files for stdout and stderr (one file when `err` is left out).
 * @param {AbortSignal | undefined} signal - From main; why: a stop kills the command.
 */
export function runProcess(app, job, signal) {
  const input = job.input ? openSync(job.input, "r") : "ignore";
  const out = openSync(job.out, "w");
  const err = job.err ? openSync(job.err, "w") : out;
  const timeout = job.timeout ?? defaultTimeoutMs;

  return new Promise((resolve) => {
    let ending = null;
    let stopped;
    const options = { cwd: app, detached: true, stdio: [input, out, err] };
    const child = Array.isArray(job.command)
      ? spawn(job.command[0], job.command.slice(1), options)
      : spawn(job.command, { ...options, shell: true });
    const stop = (why) => {
      ending ??= why;
      stopped ??= stopGroup(child.pid);
    };
    const timer = setTimeout(() => stop(`timed out after ${timeout} ms`), timeout);
    const abort = () => stop("was stopped");
    signal?.addEventListener("abort", abort, { once: true });

    let finished = false;
    const done = async (end) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await stopped;
      closeSync(out);
      if (err !== out) closeSync(err);
      if (input !== "ignore") closeSync(input);
      resolve(ending ?? end);
    };
    child.once("error", (error) => void done(`could not start: ${error.message}`));
    child.once("close", (code, killed) => {
      if (code === 0) void done(null);
      else void done(killed ? `was stopped by ${killed}` : `exited with code ${code}`);
    });
  });
}

/**
 * SIGTERM the group, wait up to 5 seconds for it to end, then SIGKILL what is left and wait
 * for it to be gone.
 * @param {number | undefined} pid - From spawn; why: the group leader's pid names the group.
 */
async function stopGroup(pid) {
  signalGroup(pid, "SIGTERM");
  await groupGone(pid, killGraceMs);

  signalGroup(pid, "SIGKILL");
  await groupGone(pid, 1000);
}

/**
 * Wait until the group has ended, or until `limit` passes.
 * @param {number | undefined} pid - From spawn; why: the group leader's pid names the group.
 * @param {number} limit - From stopGroup; why: how long to wait.
 */
async function groupGone(pid, limit) {
  for (let waited = 0; waited < limit && signalGroup(pid, 0); waited += 50) await delay(50);
}

/**
 * Send `signal` to the group. Returns false when the group is gone.
 * @param {number | undefined} pid - From spawn; why: the group leader's pid names the group.
 * @param {string | number} signal - From stopGroup; why: 0 only asks if the group lives.
 */
function signalGroup(pid, signal) {
  try {
    if (pid) process.kill(-pid, signal);
    return Boolean(pid);
  } catch {
    return false;
  }
}
