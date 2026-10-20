import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * A stand-in for the reviewer model, run in the app folder. It saves its argv and how much
 * stdin it got in `.loop/argv.json`, and the stdin in `.loop/stdin.txt`, then acts on
 * `.loop/reply.txt`: "sleep" starts a child that sleeps and waits, "exit N" exits N, and any
 * other text is printed as the report.
 */
const reply = existsSync(".loop/reply.txt") ? readFileSync(".loop/reply.txt", "utf8") : "";
const stdin = readFileSync(0, "utf8");

writeFileSync(
  ".loop/argv.json",
  JSON.stringify({ argv: process.argv.slice(2), stdin: stdin.length }),
);

writeFileSync(".loop/stdin.txt", stdin);

if (reply.startsWith("sleep")) {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  writeFileSync(".loop/sleeper.pid", String(child.pid));
  setTimeout(() => {}, 30000);
} else if (reply.startsWith("exit ")) {
  process.stderr.write("the fake reviewer failed\n");
  process.exitCode = Number(reply.slice(5));
} else process.stdout.write(reply);
