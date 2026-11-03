#!/usr/bin/env node
// PreToolUse(Bash): stop destructive or secret-leaking commands; ask before risky ones.
import { ask, block, readInput } from "./lib.mjs";

const raw = String(readInput().tool_input?.command ?? "");

// Ignore heredoc bodies (file contents being written) and quoted commit messages when checking.
const withoutHeredocs = raw.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\2(?=\s|$)/g, "<<HEREDOC");
const cmd = withoutHeredocs.replace(/(-m|-F)\s+("[^"]*"|'[^']*')/g, "$1 MSG");
// Individual commands, split on ; && || | and newlines.
const segments = cmd.split(/\n|;|&&|\|\||\|/).map((s) => s.trim()).filter(Boolean);
const any = (re) => segments.some((s) => re.test(s));

const deny = [
  [/^git\s+push\b.*\s(--force(?!-with-lease)|-f)(\s|$)/, "Force-pushing is not allowed. Use a new commit (or --force-with-lease on your own branch only if the user asked)."],
  [/^git\s+push\b.*\s(\S+:)?(main|master)(\s|$)/, "Pushing to main/master is not allowed; push the session's feature branch."],
  [/^(cat|less|more|head|tail|bat|grep|rg|sed|awk|cp|scp|base64|xxd)\b.*(^|[\s/'"])\.env(\.local|\.production)?(\s|$|['"])/, "Reading .env is not allowed (secrets). Use .env.example for variable names."],
  [/^(printenv|env)\s*$/, "Dumping the environment can leak secrets; print a specific non-secret variable instead."],
  [/\bdrizzle-kit\s+push\b/, "drizzle-kit push bypasses migrations. Use `npm run db:generate` then `npm run db:migrate`."],
  [/\b(dropdb\b|DROP\s+DATABASE\b)/i, "Dropping databases is not allowed from the agent."],
];
for (const [re, why] of deny) if (any(re)) block(`Blocked: ${why}\nCommand: ${raw.slice(0, 300)}`);

// TRUNCATE / DELETE without WHERE is only fine on test or e2e databases.
if (/\b(TRUNCATE\b|DELETE\s+FROM\s+\w+\s*(;|$|"))/i.test(cmd) && !/_(test|e2e)\b/.test(cmd)) {
  ask("This wipes table data and doesn't target a *_test or *_e2e database. Confirm it's intended.");
}
if (any(/^git\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|restore\s+\.)/)) {
  ask("This discards uncommitted work. Confirm nothing unsaved will be lost.");
}
if (any(/^rm\s+-[a-z]*r/) && !any(/^rm\s+-[a-z]*r[a-z]*\s+(\.next|coverage|node_modules\/\.cache|\/tmp\/\S+)(\s|$)/)) {
  ask("Recursive delete. Confirm the target is correct.");
}
