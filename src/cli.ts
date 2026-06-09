#!/usr/bin/env bun
/**
 * doclab CLI — Thin HTTP client + daemon lifecycle management.
 *
 * Commands:
 *   start           Start global daemon (idempotent)
 *   stop            Stop daemon
 *   status          Daemon status
 *   add <url>       Add source: fetch → chunk → embed → config
 *   remove <name>   Remove source
 *   list            List all sources with freshness
 *   pull [name]     Re-fetch sources
 *   search <query>  Hybrid search
 *   rebuild         Drop DB, re-index from scratch
 *   init            Generate AGENTS.md snippet
 */

import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { getDoclabDir, loadConfig } from "./config";
import type { SearchResponse, HealthResponse, SourceMeta, ErrorResponse } from "./types";
import { generateAgentInstructions } from "./lib/agent-instructions";

const DOCLAB_DIR = getDoclabDir();
const PORT_FILE = join(DOCLAB_DIR, "port");
const PID_FILE = join(DOCLAB_DIR, "pid");

// ─── Main ───

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "start":
      await cmdStart();
      break;
    case "stop":
      await cmdStop();
      break;
    case "status":
      await cmdStatus();
      break;
    case "add":
      await cmdAdd(args.slice(1));
      break;
    case "remove":
      await cmdRemove(args.slice(1));
      break;
    case "list":
      await cmdList();
      break;
    case "pull":
      await cmdPull(args.slice(1));
      break;
    case "search":
      await cmdSearch(args.slice(1));
      break;
    case "rebuild":
      await cmdRebuild();
      break;
    case "init":
      await cmdInit();
      break;
    default:
      console.log(`Unknown command: ${command}`);
      console.log(`Run 'doclab help' for usage.`);
      process.exit(1);
  }
}

// ─── Commands ───

async function cmdStart() {
  const existingPort = readPort();
  if (existingPort && (await isDaemonRunning(existingPort))) {
    console.log(`✓ Already running on http://127.0.0.1:${existingPort}`);
    return;
  }

  // Clean up stale files
  if (existingPort) {
    cleanupStaleFiles();
  }

  console.log("Starting doclab daemon...");

  // Find bun executable
  const bunExe = process.execPath;

  // Ensure config exists
  const { config } = loadConfig();

  // Determine daemon script path
  const daemonPath = findDaemonScript();

  // Spawn daemon
  const child = spawn(bunExe, [daemonPath], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env },
  });

  child.unref();

  // Wait for daemon to be ready
  const port = await waitForDaemon(10000);
  if (port) {
    console.log(`✓ Ready on http://127.0.0.1:${port}`);
  } else {
    console.log("✗ Daemon failed to start. Check logs.");
    process.exit(1);
  }
}

async function cmdStop() {
  const port = readPort();
  if (!port) {
    console.log("Daemon: not running");
    return;
  }

  const pid = readPid();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      console.log("✓ Daemon stopped");
    } catch {
      console.log("Daemon already stopped");
    }
  }

  cleanupStaleFiles();
}

async function cmdStatus() {
  const port = readPort();
  if (!port || !(await isDaemonRunning(port))) {
    console.log("Daemon: not running");
    console.log("  Start with: doclab start");
    return;
  }

  const health = await apiGet<HealthResponse>(port, "/health");
  if (!health) {
    console.log("Daemon: unreachable (port file exists but server not responding)");
    return;
  }

  const { config } = loadConfig();
  const uptime = formatUptime(health.uptime);

  console.log(`Daemon:      running on http://127.0.0.1:${port} (pid: ${readPid()})`);
  console.log(
    `Ollama:      ${health.ollama === "connected" ? `connected (${health.embeddingModel}, ${health.embeddingDims}d)` : health.ollama}`
  );
  console.log(`Uptime:      ${uptime}`);
  console.log(`Sources:     ${health.sources} (${health.chunks} chunks total)`);

  // Show last pull time
  if (health.sources > 0) {
    const sources = await apiGet<SourceMeta[]>(port, "/sources");
    if (sources && sources.length > 0) {
      const latestFetch = sources
        .filter((s) => s.fetchedAt)
        .sort(
          (a, b) =>
            new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime()
        )[0];

      if (latestFetch) {
        const ago = timeAgo(new Date(latestFetch.fetchedAt));
        console.log(`Last pull:   ${latestFetch.fetchedAt.replace("T", " ").slice(0, 19)} UTC (${ago})`);
      }
    }
  }

  const intervalMs = parseIntervalStr(config.rebuildInterval);
  if (intervalMs > 0) {
    console.log(`Next pull:   in ${formatDuration(intervalMs)}`);
  }

  console.log(`Idle timeout: ${config.idleTimeout} (auto-shutdown)`);
}

async function cmdAdd(args: string[]) {
  let url = "";
  let name: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (!args[i].startsWith("--")) {
      url = args[i];
    }
  }

  if (!url) {
    console.log("Usage: doclab add <url> [--name <name>]");
    process.exit(1);
  }

  const port = await ensureDaemon();

  console.log("Fetching...");
  try {
    const result = await apiPost<SourceMeta>(port, "/add", { url, name });
    if (result) {
      console.log(`✓ Added "${result.name}" — ${result.chunkCount} chunks indexed`);
    } else {
      console.log("✗ Failed to add source");
      process.exit(1);
    }
  } catch (e: any) {
    console.log(`✗ ${e.message}`);
    process.exit(1);
  }
}

async function cmdRemove(args: string[]) {
  const name = args[0];
  if (!name) {
    console.log("Usage: doclab remove <name>");
    process.exit(1);
  }

  const port = await ensureDaemon();

  try {
    await apiPost(port, "/remove", { name });
    console.log(`✓ Removed "${name}"`);
  } catch (e: any) {
    console.log(`✗ ${e.message}`);
    process.exit(1);
  }
}

async function cmdList() {
  const port = await ensureDaemon();

  const sources = await apiGet<SourceMeta[]>(port, "/sources");
  if (!sources || sources.length === 0) {
    console.log("No sources configured. Add some:");
    console.log("  doclab add https://hono.dev/llms-full.txt");
    return;
  }

  console.log(`Sources (${sources.length}):`);

  const { config } = loadConfig();
  const intervalMs = parseIntervalStr(config.rebuildInterval);

  for (const src of sources) {
    const version = src.version ? `v${src.version}` : "—";
    const fetchedAgo = src.fetchedAt ? timeAgo(new Date(src.fetchedAt)) : "never";
    const isStale =
      intervalMs > 0 &&
      src.fetchedAt &&
      Date.now() - new Date(src.fetchedAt).getTime() > intervalMs;
    const staleMark = isStale ? " ⚠" : "";

    console.log(
      `  ${src.name.padEnd(25)} ${(version ?? "—").padEnd(10)} ${String(src.chunkCount).padEnd(4)} chunks  fetched ${fetchedAgo}${staleMark}  ${src.kind}`
    );
  }
}

async function cmdPull(args: string[]) {
  const name = args[0];
  const port = await ensureDaemon();

  console.log("Pulling...");
  try {
    const result = await apiPost<{ updated: string[] }>(port, "/pull", {
      name,
    });
    if (result && result.updated.length > 0) {
      console.log(
        `✓ Updated ${result.updated.length} source(s): ${result.updated.join(", ")}`
      );
    } else {
      console.log("✓ All sources up to date");
    }
  } catch (e: any) {
    console.log(`✗ ${e.message}`);
    process.exit(1);
  }
}

async function cmdSearch(args: string[]) {
  let query = "";
  let source: string | undefined;
  let kind: string | undefined;
  let topK: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && i + 1 < args.length) {
      source = args[++i];
    } else if (args[i] === "--kind" && i + 1 < args.length) {
      kind = args[++i];
    } else if (args[i] === "--topK" && i + 1 < args.length) {
      topK = parseInt(args[++i]);
    } else if (!args[i].startsWith("--")) {
      query += (query ? " " : "") + args[i];
    }
  }

  if (!query) {
    console.log("Usage: doclab search <query> [--source <name>] [--kind <kind>] [--topK <n>]");
    process.exit(1);
  }

  const port = await ensureDaemon();

  try {
    const result = await apiPost<SearchResponse>(port, "/search", {
      query,
      source,
      kind: kind as any,
      topK,
    });

    if (!result || result.results.length === 0) {
      console.log(`─── doclab search: "${query}" (0 results) ───`);
      console.log("No results found.");
      return;
    }

    const degradedNote = result.degraded
      ? " [degraded — keyword only]"
      : "";

    console.log(
      `─── doclab search: "${query}" (${result.results.length} results, ${result.queryTimeMs}ms${degradedNote}) ───\n`
    );

    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      const domain = r.sourceDomain ?? "unknown";
      const kind = r.sourceKind ?? "unknown";

      const distanceStr = r.distance != null ? `distance: ${r.distance.toFixed(2)}` : "";
      const fusionStr =
        r.fusionScore != null ? `fusion: ${r.fusionScore.toFixed(3)}` : "";
      const scoreStr = [distanceStr, fusionStr].filter(Boolean).join(", ");

      console.log(
        `${i + 1}. ${domain} — ${r.sectionPath} (${scoreStr}) [${kind}]`
      );

      // Show content preview (first 300 chars)
      const preview = r.content.slice(0, 300).replace(/\n/g, " ");
      console.log(`   ${preview}${r.content.length > 300 ? "..." : ""}`);

      // Source info
      const versionStr = r.sourceVersion
        ? `v${r.sourceVersion}, `
        : "";
      const fetchedStr = r.fetchedAt
        ? `fetched ${r.fetchedAt.slice(0, 10)}`
        : "";
      console.log(`   ► ${versionStr}${fetchedStr}`);

      console.log();
    }
  } catch (e: any) {
    console.log(`✗ Search failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdRebuild() {
  const port = await ensureDaemon();

  console.log("Rebuilding...");
  try {
    await apiPost(port, "/rebuild", {});
    console.log("✓ Rebuild complete");
  } catch (e: any) {
    console.log(`✗ ${e.message}`);
    process.exit(1);
  }
}

async function cmdInit() {
  console.log(generateAgentInstructions());
  console.log("\n# Append the above to your AGENTS.md or project instructions file.");
}

// ─── Daemon helpers ───

function readPort(): number | null {
  try {
    const raw = readFileSync(PORT_FILE, "utf-8").trim();
    return parseInt(raw) || null;
  } catch {
    return null;
  }
}

function readPid(): number | null {
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    return parseInt(raw) || null;
  } catch {
    return null;
  }
}

async function isDaemonRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<number> {
  const existingPort = readPort();
  if (existingPort && (await isDaemonRunning(existingPort))) {
    return existingPort;
  }

  // Auto-start
  console.log("Starting doclab daemon...");
  await cmdStart();

  const newPort = readPort();
  if (!newPort || !(await isDaemonRunning(newPort))) {
    console.log("✗ Failed to start daemon");
    process.exit(1);
  }

  return newPort;
}

async function waitForDaemon(timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  const interval = 200;

  while (Date.now() - start < timeoutMs) {
    const port = readPort();
    if (port && (await isDaemonRunning(port))) {
      return port;
    }
    await sleep(interval);
  }

  return null;
}

function cleanupStaleFiles() {
  try { unlinkSync(PORT_FILE); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
}

function findDaemonScript(): string {
  // In dev: src/server-daemon.ts
  // In production: dist/server-daemon.js (relative to cli.js)
  const devPath = join(import.meta.dir, "server-daemon.ts");
  if (existsSync(devPath)) {
    return devPath;
  }

  const distPath = join(import.meta.dir, "server-daemon.js");
  if (existsSync(distPath)) {
    return distPath;
  }

  // Fallback: try relative to cwd
  const cwdDev = join(process.cwd(), "src", "server-daemon.ts");
  if (existsSync(cwdDev)) {
    return cwdDev;
  }

  const cwdDist = join(process.cwd(), "dist", "server-daemon.js");
  if (existsSync(cwdDist)) {
    return cwdDist;
  }

  // Last resort
  return devPath;
}

// ─── HTTP helpers ───

async function apiGet<T>(port: number, path: string): Promise<T | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function apiPost<T>(
  port: number,
  path: string,
  body: unknown
): Promise<T | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const errBody = (await response.json()) as ErrorResponse;
      throw new Error(errBody.error ?? `HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  } catch (e: any) {
    if (e.message && !e.message.includes("fetch")) {
      throw e;
    }
    throw new Error(`Daemon unreachable on port ${port}`);
  }
}

// ─── Formatting ───

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(ms / 1000)}s`;
}

function parseIntervalStr(interval: string): number {
  if (interval === "never") return 0;
  const match = interval.match(/^(\d+)(h|m|d)$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "h": return value * 60 * 60 * 1000;
    case "m": return value * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`doclab — Local knowledge server for coding agents

Usage:
  doclab start                     Start global daemon (idempotent)
  doclab stop                      Stop daemon
  doclab status                    Daemon status
  doclab add <url> [--name <n>]    Add source: fetch → chunk → embed
  doclab remove <name>             Remove source
  doclab list                      List all sources with freshness
  doclab pull [name]               Re-fetch sources
  doclab search <query> [...]      Hybrid search
  doclab rebuild                   Drop DB, re-index all from scratch
  doclab init                      Generate AGENTS.md snippet

Search options:
  --source <name>   Filter by source
  --kind <kind>     Filter by kind (docs, article, tutorial, reference)
  --topK <n>         Max results (default: 5)

Examples:
  doclab add https://hono.dev/llms-full.txt
  doclab search "hono cors middleware"
  doclab search "hooks" --source react-docs --kind article
  doclab pull
  doclab init >> AGENTS.md
`);
}

// ─── Run ───

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
