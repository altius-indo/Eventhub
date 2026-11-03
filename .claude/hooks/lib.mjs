// Shared helpers for EventHub's Claude Code hooks (Node, no dependencies).
import { readFileSync } from "node:fs";
import path from "node:path";

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

export const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/** Path relative to the project root, with forward slashes. */
export function rel(file) {
  return path.relative(projectDir, path.resolve(projectDir, file || "")).split(path.sep).join("/");
}

/** Blocks the tool call (PreToolUse) or reports feedback to Claude (PostToolUse/Stop). */
export function block(message) {
  process.stderr.write(message.trim() + "\n");
  process.exit(2);
}

export function ask(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } }));
  process.exit(0);
}
