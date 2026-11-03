#!/usr/bin/env node
// Stop: don't finish with TypeScript errors in changed code. Runs once per stop (no loops).
import { execFileSync } from "node:child_process";
import { block, projectDir, readInput } from "./lib.mjs";

const input = readInput();
if (input.stop_hook_active) process.exit(0);

let changed = "";
try {
  changed = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf8" });
} catch {
  process.exit(0);
}
if (!/\.(ts|tsx|mts)$/m.test(changed)) process.exit(0);

try {
  execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], { cwd: projectDir, stdio: "pipe", timeout: 150_000 });
} catch (err) {
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().split("\n").slice(0, 30).join("\n");
  block(`TypeScript errors remain (npm run typecheck). Fix them before finishing:\n${out}`);
}
