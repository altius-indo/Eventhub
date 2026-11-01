#!/usr/bin/env node
// SessionStart: a short status line added to Claude's context.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { projectDir } from "./lib.mjs";

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: projectDir, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = path.join(projectDir, ".env");
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="));
  return line ? line.slice("DATABASE_URL=".length).trim() : null;
}

function reachable(url) {
  return new Promise((resolve) => {
    let host = "localhost";
    let port = 5432;
    try {
      const u = new URL(url);
      host = u.hostname || host;
      port = Number(u.port) || port;
    } catch {}
    const sock = net.connect({ host, port, timeout: 800 }, () => {
      sock.end();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
const url = dbUrl();
const dbUp = url ? await reachable(url) : false;
const lines = [
  `EventHub session: branch ${branch || "?"}, ${dirty} uncommitted file(s).`,
  url ? `PostgreSQL ${dbUp ? "is reachable" : "is NOT reachable — start it (docker compose up -d db, or service postgresql start)"}.` : "No DATABASE_URL: copy .env.example to .env.",
  existsSync(path.join(projectDir, "node_modules")) ? "" : "node_modules missing: run npm install.",
].filter(Boolean);
process.stdout.write(lines.join("\n") + "\n");
