#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit): fast feedback on the file just changed.
import { execFileSync } from "node:child_process";
import { block, projectDir, readInput, rel } from "./lib.mjs";

const file = rel(readInput().tool_input?.file_path ?? "");
const problems = [];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: projectDir, stdio: "pipe", timeout: 90_000 });
    return null;
  } catch (err) {
    return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().split("\n").slice(0, 40).join("\n");
  }
}

if (/^(src|tests|scripts)\/.+\.(ts|tsx|mts)$/.test(file)) {
  const out = run("npx", ["eslint", "--no-warn-ignored", file]);
  if (out) problems.push(`ESLint found problems in ${file}:\n${out}`);
}

if (/^src\/i18n\/messages\/(en|hi)\.ts$/.test(file)) {
  const out = run("npx", ["vitest", "run", "tests/i18n.test.ts", "--reporter=dot"]);
  if (out) problems.push(`English/Hindi catalogues are out of sync:\n${out}\nAdd the same keys and {placeholders} to both en.ts and hi.ts.`);
}

if (file === "src/db/schema.ts") {
  problems.push(
    "You changed src/db/schema.ts. When the schema change is complete, run `npm run db:generate -- --name <change>`, " +
      "`npm run db:migrate` and `npx tsx scripts/migrate.ts $TEST_DATABASE_URL`, and add new tables to the TRUNCATE in tests/helpers.ts.",
  );
}

if (problems.length) block(problems.join("\n\n"));
