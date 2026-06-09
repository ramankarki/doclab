/**
 * doclab daemon — Background process entry point.
 *
 * Spawned by `doclab start` via Bun.spawn.
 * Runs HTTP server, handles lifecycle: idle timeout, auto-rebuild timer, graceful shutdown.
 * Writes port/PID files to ~/.doclab/.
 */

import { join } from "node:path";
import { writeFileSync, unlinkSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { createServer } from "./server";
import type { ServerState } from "./server";
import { Embedder } from "./lib/embedder";
import { loadConfig, parseInterval, getDoclabDir } from "./config";
import { initDb, closeDb, getDb, isVecLoaded } from "./db";
import type { DlConfig } from "./types";
import { c } from "./lib/colors";

const DOCLAB_DIR = getDoclabDir();
const LOGS_DIR = join(DOCLAB_DIR, "logs");
const LOG_FILE = join(LOGS_DIR, "daemon.log");
const PORT_FILE = join(DOCLAB_DIR, "port");
const PID_FILE = join(DOCLAB_DIR, "pid");

// ── Logging ──

function log(message: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  console.log(message);
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line, "utf-8");
  } catch {
    // Log file write failed — continue without it
  }
}

let idleTimer: Timer | null = null;
let rebuildTimer: Timer | null = null;
let state: ServerState | null = null;
let shutdownSignal = false;

async function main() {
  // ── Load config ──
  const { config, errors } = loadConfig();
  for (const err of errors) log(`${c.warn}[WARN]${c.reset} ${err}`);

  // ── Initialize embedder ──
  let embedder: Embedder | null = null;
  let ollamaStatus: ServerState["ollamaStatus"] = "not-configured";
  let embeddingModel: string | undefined;
  let embeddingDims: number | undefined;

  if (config.embedding.provider === "ollama") {
    const e = new Embedder(config.embedding);
    embeddingModel = e.model;
    try {
      const info = await e.detect();
      if (info.reachable) {
        embedder = e;
        ollamaStatus = "connected";
        embeddingDims = info.dimensions;
        log(`${c.success}[OK]${c.reset} Ollama: connected (${info.model}, ${info.dimensions}d)`);
      } else {
        ollamaStatus = "unreachable";
        log(`${c.warn}[WARN]${c.reset} Ollama unreachable. Install: brew install ollama && ollama pull ${info.model}`);
        log(`  Running in degraded mode (keyword search only).`);
      }
    } catch (e: any) {
      ollamaStatus = "unreachable";
      log(`${c.warn}[WARN]${c.reset} Ollama check failed: ${e.message}`);
    }
  } else if (config.embedding.provider === "openai" || config.embedding.provider === "voyage") {
    const e = new Embedder(config.embedding);
    embeddingModel = e.model;
    try {
      const info = await e.detect();
      if (info.reachable) {
        embedder = e;
        ollamaStatus = "connected";
        embeddingDims = info.dimensions;
        log(`${c.success}[OK]${c.reset} ${config.embedding.provider}: connected (${info.model}, ${info.dimensions}d)`);
      } else {
        ollamaStatus = "unreachable";
        log(`${c.warn}[WARN]${c.reset} ${config.embedding.provider}: API key not set. Embedding disabled.`);
      }
    } catch (e: any) {
      ollamaStatus = "unreachable";
      log(`${c.warn}[WARN]${c.reset} ${config.embedding.provider}: ${e.message}`);
    }
  }

  // ── Initialize SQLite ──
  const dims = embeddingDims;
  if (dims) await initDb(dims);
  else await initDb();

  if (isVecLoaded()) {
    log(`${c.success}[OK]${c.reset} sqlite-vec: loaded`);
  } else {
    log(`${c.warn}[WARN]${c.reset} sqlite-vec not loaded — vector search disabled`);
  }

  // ── Build state ──
  state = {
    config,
    embedder,
    startTime: Date.now(),
    isWriting: false,
    indexingInProgress: false,
    ollamaStatus,
    embeddingModel,
    embeddingDims,
  };

  // ── Start server with request tracking ──
  const server = createServer(state, () => resetIdleTimer(config));

  const port = server.port;
  writeFileSync(PORT_FILE, String(port));
  writeFileSync(PID_FILE, String(process.pid));

  log(`${c.success}[OK]${c.reset} Ready on http://127.0.0.1:${port}`);

  // ── Start idle timer ──
  resetIdleTimer(config);

  // ── Run overdue rebuild if daemon was shut down ──
  runOverdueRebuild(config);

  // ── Start auto-rebuild timer ──
  startRebuildTimer(config);

  // ── Print setup hint ──
  if (config.sources.length === 0) {
    log(`${c.warn}[WARN]${c.reset} No sources configured. Add some:`);
    log(`  ${c.cmd}doclab add${c.reset} https://hono.dev/llms-full.txt`);
  }

  // ── Graceful shutdown ──
  const shutdown = async () => {
    if (shutdownSignal) return;
    shutdownSignal = true;

    log(`${c.info}[doclab]${c.reset} Shutting down...`);
    if (idleTimer) clearTimeout(idleTimer);
    if (rebuildTimer) clearInterval(rebuildTimer);

    server.stop(true);
    closeDb();

    try { unlinkSync(PORT_FILE); } catch {}
    try { unlinkSync(PID_FILE); } catch {}

    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ── Idle timeout ──

function resetIdleTimer(config: DlConfig) {
  if (idleTimer) clearTimeout(idleTimer);

  const timeoutMs = parseInterval(config.idleTimeout);
  if (timeoutMs === 0) return; // 'never'

  idleTimer = setTimeout(() => {
    log(`${c.info}[doclab]${c.reset} Idle timeout (${config.idleTimeout}). Shutting down.`);
    process.kill(process.pid, "SIGTERM");
  }, timeoutMs);
}

// ── Auto-rebuild timer ──

async function runOverdueRebuild(config: DlConfig) {
  const intervalMs = parseInterval(config.rebuildInterval);
  if (intervalMs === 0) return;

  const db = getDb();
  const sources = db.prepare(
    "SELECT name, fetched_at FROM sources WHERE fetched_at IS NOT NULL"
  ).all() as { name: string; fetched_at: string }[];

  if (sources.length === 0) return;

  const now = Date.now();
  const overdue = sources.filter(
    (s) => now - new Date(s.fetched_at).getTime() > intervalMs
  );

  if (overdue.length > 0) {
    const names = overdue.map((s) => s.name).join(", ");
    log(`${c.info}[doclab]${c.reset} Rebuild overdue for ${overdue.length} source(s): ${names}. Running pull...`);

    const port = readPort();
    if (!port) return;

    try {
      await fetch(`http://127.0.0.1:${port}/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      log(`${c.success}[doclab]${c.reset} Overdue rebuild complete.`);
    } catch (e: any) {
      log(`${c.error}[doclab]${c.reset} Overdue rebuild error: ${e.message}`);
    }
  }
}

function startRebuildTimer(config: DlConfig) {
  const intervalMs = parseInterval(config.rebuildInterval);
  if (intervalMs === 0) return; // 'never'

  log(`${c.dim}Auto-rebuild: every ${config.rebuildInterval}${c.reset}`);

  rebuildTimer = setInterval(async () => {
    if (!state) return;
    log(`${c.info}[doclab]${c.reset} Auto-rebuild: checking ${state.config.sources.length} source(s)...`);

    // Call pullSources via HTTP to use the same pipeline
    const port = readPort();
    if (!port) return;

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.updated?.length > 0) {
          log(`${c.success}[doclab]${c.reset} Auto-rebuild: updated ${data.updated.join(", ")}`);
        }
      }
    } catch (e: any) {
      log(`${c.error}[doclab]${c.reset} Auto-rebuild error: ${e.message}`);
    }
  }, intervalMs);
}

function readPort(): number | null {
  try {
    const { readFileSync } = require("node:fs");
    return parseInt(readFileSync(PORT_FILE, "utf-8").trim()) || null;
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error(`[doclab] Fatal error:`, e);
  process.exit(1);
});
