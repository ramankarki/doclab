#!/usr/bin/env bun
/**
 * doclab CLI — Thin HTTP client + daemon lifecycle management.
 *
 * Commands:
 *   start           Start global daemon (idempotent)
 *   stop            Stop daemon
 *   status          Daemon status
 *   add <url>       Add source: fetch → chunk → embed → config
 *   remove | rm <name>   Remove source
 *   list            List all sources with freshness
 *   pull [name]     Re-fetch sources
 *   search <query>  Hybrid search
 *   rebuild         Drop DB, re-index from scratch
 *   init            Generate AGENTS.md snippet
 */

import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getDoclabDir, loadConfig, isValidUrl } from './config';
import type {
  SearchResponse,
  HealthResponse,
  SourceMeta,
  ErrorResponse,
} from './types';
import { generateAgentInstructions } from './lib/agent-instructions';
import { c } from './lib/colors';

const DOCLAB_DIR = getDoclabDir();
const PORT_FILE = join(DOCLAB_DIR, 'port');
const PID_FILE = join(DOCLAB_DIR, 'pid');

// ─── Main ───

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    printHelp();
    return;
  }

  switch (command) {
    case 'start':
      await cmdStart();
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'add':
      await cmdAdd(args.slice(1));
      break;
    case 'remove':
    case 'rm':
      await cmdRemove(args.slice(1));
      break;
    case 'list':
      await cmdList();
      break;
    case 'pull':
      await cmdPull(args.slice(1));
      break;
    case 'search':
      await cmdSearch(args.slice(1));
      break;
    case 'rebuild':
      await cmdRebuild();
      break;
    case 'init':
      await cmdInit();
      break;
    case 'mem':
    case 'memory':
      await cmdMem();
      break;
    default:
      console.log(`${c.red}Unknown command:${c.reset} ${command}`);
      console.log(`Run ${c.cyan}doclab help${c.reset} for usage.`);
      process.exit(1);
  }
}

// ─── Commands ───

async function cmdStart() {
  const existingPort = readPort();
  if (existingPort && (await isDaemonRunning(existingPort))) {
    console.log(`${c.success}Already running on http://127.0.0.1:${existingPort}${c.reset}`);
    return;
  }

  // Clean up stale files
  if (existingPort) {
    cleanupStaleFiles();
  }

  console.log('Starting doclab daemon...');

  // Find bun executable
  const bunExe = process.execPath;

  // Ensure config exists
  const { config } = loadConfig();

  // Determine daemon script path
  const daemonPath = findDaemonScript();

  // Spawn daemon
  const child = spawn(bunExe, [daemonPath], {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env },
  });

  child.unref();

  // Wait for daemon to be ready
  const port = await waitForDaemon(10000);
  if (port) {
    console.log(`${c.success}Ready on http://127.0.0.1:${port}${c.reset}`);
  } else {
    console.error(`${c.error}Daemon failed to start. Check logs.${c.reset}`);
    process.exit(1);
  }
}

async function cmdStop() {
  const port = readPort();
  if (!port) {
    console.log(`${c.warn}Daemon is not running.${c.reset}`);
    return;
  }

  const pid = readPid();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`${c.dim}Stopping daemon (pid: ${pid})...${c.reset}`);
      await waitForShutdown(pid, 5000);
      console.log(`${c.success}Daemon stopped.${c.reset}`);
    } catch {
      console.log('Daemon already stopped.');
    }
  }

  cleanupStaleFiles();
}

async function cmdStatus() {
  const port = readPort();
  if (!port || !(await isDaemonRunning(port))) {
    console.log(`${c.yellow}Daemon is not running.${c.reset}`);
    console.log(`  Start with: ${c.cyan}doclab start${c.reset}`);
    return;
  }

  const health = await apiGet<HealthResponse>(port, '/health');
  if (!health) {
    console.log(
      `${c.yellow}Daemon is unreachable${c.reset} (port file exists but server not responding).`,
    );
    return;
  }

  const { config } = loadConfig();
  const uptime = formatUptime(health.uptime);

  console.log(`${c.label}Daemon:${c.reset}      http://127.0.0.1:${port} (pid: ${readPid()})`);
  console.log(
    `${c.label}Ollama:${c.reset}      ${health.ollama === 'connected' ? `${c.success}connected${c.reset} (${health.embeddingModel}, ${health.embeddingDims}d)` : health.ollama}`,
  );
  console.log(`${c.label}Uptime:${c.reset}      ${uptime}`);
  console.log(`${c.label}Sources:${c.reset}     ${health.sources} (${health.chunks} chunks total)`);

  // Show last pull time
  if (health.sources > 0) {
    const sources = await apiGet<SourceMeta[]>(port, '/sources');
    if (sources && sources.length > 0) {
      const latestFetch = sources
        .filter((s) => s.fetchedAt)
        .sort(
          (a, b) =>
            new Date(b.fetchedAt).getTime() - new Date(a.fetchedAt).getTime(),
        )[0];

      if (latestFetch) {
        const ago = timeAgo(new Date(latestFetch.fetchedAt));
        console.log(
          `${c.label}Last pull:${c.reset}   ${latestFetch.fetchedAt.replace('T', ' ').slice(0, 19)} UTC (${ago})`,
        );
      }
    }
  }

  const intervalMs = parseIntervalStr(config.rebuildInterval);
  if (intervalMs > 0) {
    console.log(`${c.label}Next pull:${c.reset}   in ${formatDuration(intervalMs)}`);
  }

  console.log(`${c.label}Idle timeout:${c.reset} ${config.idleTimeout} (auto-shutdown)`);
}

async function cmdAdd(args: string[]) {
  let url = '';
  let name: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && i + 1 < args.length) {
      name = args[++i];
    } else if (!args[i].startsWith('--')) {
      url = args[i];
    }
  }

  if (!url) {
    console.error(`${c.error}Usage:${c.reset} doclab add <url> [--name <name>]`);
    process.exit(1);
  }

  if (!isValidUrl(url)) {
    console.error(`${c.error}Invalid URL:${c.reset} ${url}`);
    process.exit(1);
  }

  const port = await ensureDaemon();

  console.log('Fetching...');
  try {
    const result = await apiPost<SourceMeta>(port, '/add', { url, name });
    if (result) {
      console.log(
        `${c.green}Added "${result.name}" — ${result.chunkCount} chunks indexed${c.reset}`,
      );
    } else {
      console.error(`${c.red}Failed to add source${c.reset}`);
      process.exit(1);
    }
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

async function cmdRemove(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error(`${c.error}Usage:${c.reset} doclab remove <name>`);
    process.exit(1);
  }

  const port = await ensureDaemon();

  try {
    await apiPost(port, '/remove', { name });
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

async function cmdList() {
  const port = await ensureDaemon();

  const sources = await apiGet<SourceMeta[]>(port, '/sources');
  if (!sources || sources.length === 0) {
    console.log('No sources configured. Add some:');
    console.log('  doclab add https://hono.dev/llms-full.txt');
    return;
  }

  const { config } = loadConfig();
  const intervalMs = parseIntervalStr(config.rebuildInterval);

  // Build rows
  const rows = sources.map((src) => {
    const version = src.version ? `v${src.version}` : '—';
    const fetchedAgo = src.fetchedAt
      ? timeAgo(new Date(src.fetchedAt))
      : 'never';
    const isStale =
      intervalMs > 0 &&
      src.fetchedAt &&
      Date.now() - new Date(src.fetchedAt).getTime() > intervalMs;
    return {
      name: src.name,
      url: src.url,
      version,
      chunks: String(src.chunkCount),
      fetched: isStale ? `${fetchedAgo} ⚠` : fetchedAgo,
    };
  });

  // Calculate column widths (cap URL width to avoid table blowout)
  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const urlMax = Math.max(4, ...rows.map((r) => r.url.length));
  const urlW = Math.min(urlMax, 50);
  const verW = Math.max(7, ...rows.map((r) => r.version.length));
  const chunksW = Math.max(6, ...rows.map((r) => r.chunks.length));
  const fetchedW = Math.max(7, ...rows.map((r) => r.fetched.length));

  // Header
  const nameH = 'NAME'.padEnd(nameW);
  const urlH = 'URL'.padEnd(urlW);
  const verH = 'VERSION'.padEnd(verW);
  const chunksH = 'CHUNKS'.padStart(chunksW);
  const fetchedH = 'FETCHED'.padEnd(fetchedW);
  const sep = '─'.repeat(nameW + urlW + verW + chunksW + fetchedW + 8);

  console.log(`${c.bold}${c.cyan}${nameH}  ${urlH}  ${verH}  ${chunksH}  ${fetchedH}${c.reset}`);
  console.log(`${c.dim}${sep}${c.reset}`);
  for (const row of rows) {
    const urlTrunc =
      row.url.length > urlW ? row.url.slice(0, urlW - 1) + '…' : row.url;
    const rawFetched = row.fetched.padEnd(fetchedW);
    const fetchedDisplay = rawFetched.replace('⚠', `${c.yellow}⚠${c.reset}`);
    console.log(
      `${row.name.padEnd(nameW)}  ${urlTrunc.padEnd(urlW)}  ${row.version.padEnd(verW)}  ${row.chunks.padStart(chunksW)}  ${fetchedDisplay}`,
    );
  }
  console.log();
  console.log(`${c.dim}total: ${sources.length}${c.reset}`);
}

async function cmdPull(args: string[]) {
  const name = args[0];
  const port = await ensureDaemon();

  console.log('Pulling...');
  try {
    const result = await apiPost<{ updated: string[] }>(port, '/pull', {
      name,
    });
    if (result && result.updated.length > 0) {
      console.log(
        `${c.green}Updated ${result.updated.length} source(s): ${result.updated.join(', ')}${c.reset}`,
      );
    } else {
      console.log(`${c.green}All sources up to date${c.reset}`);
    }
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

async function cmdSearch(args: string[]) {
  let query = '';
  let source: string | undefined;
  let kind: string | undefined;
  let topK: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && i + 1 < args.length) {
      source = args[++i];
    } else if (args[i] === '--kind' && i + 1 < args.length) {
      kind = args[++i];
    } else if (args[i] === '--topK' && i + 1 < args.length) {
      topK = parseInt(args[++i]);
    } else if (!args[i].startsWith('--')) {
      query += (query ? ' ' : '') + args[i];
    }
  }

  if (!query) {
    console.error(
      `${c.error}Usage:${c.reset} doclab search <query> [--source <name>] [--kind <kind>] [--topK <n>]`
    );
    process.exit(1);
  }

  const port = await ensureDaemon();

  try {
    const result = await apiPost<SearchResponse>(port, '/search', {
      query,
      source,
      kind: kind as any,
      topK,
    });

    if (!result || result.results.length === 0) {
      console.log(`${c.bold}Search:${c.reset} "${query}" (0 results)`);
      console.log('No results found.');
      return;
    }

    const degradedNote = result.degraded ? ' [degraded — keyword only]' : '';

    console.log(
      `${c.bold}Search:${c.reset} "${query}" (${result.results.length} results, ${result.queryTimeMs}ms${degradedNote})\n`,
    );

    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      const domain = r.sourceDomain ?? 'unknown';
      const kind = r.sourceKind ?? 'unknown';

      const distanceStr =
        r.distance != null ? `distance: ${r.distance.toFixed(2)}` : '';
      const fusionStr =
        r.fusionScore != null ? `fusion: ${r.fusionScore.toFixed(3)}` : '';
      const scoreStr = [distanceStr, fusionStr].filter(Boolean).join(', ');

      console.log(
        `${c.cyan}${i + 1}.${c.reset} ${domain} — ${r.sectionPath} (${scoreStr}) [${kind}]`,
      );

      // Show content preview (first 300 chars)
      const preview = r.content.slice(0, 300).replace(/\n/g, ' ');
      console.log(`   ${preview}${r.content.length > 300 ? '...' : ''}`);

      // Source info
      const versionStr = r.sourceVersion ? `v${r.sourceVersion}, ` : '';
      const fetchedStr = r.fetchedAt
        ? `fetched ${r.fetchedAt.slice(0, 10)}`
        : '';
      console.log(`   ${c.dim}${versionStr}${fetchedStr}${c.reset}`);

      console.log();
    }
  } catch (e: any) {
    console.error(`${c.error}Search failed:${c.reset} ${e.message}`);
    process.exit(1);
  }
}

async function cmdRebuild() {
  const port = await ensureDaemon();

  console.log('Rebuilding...');
  try {
    await apiPost(port, '/rebuild', {});
    console.log(`${c.green}Rebuild complete${c.reset}`);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

async function cmdInit() {
  console.log(generateAgentInstructions());
  console.log(
    '\n# Append the above to your AGENTS.md or project instructions file.',
  );
}

async function cmdMem() {
  const pid = readPid();
  const dbPath = join(DOCLAB_DIR, 'doclab.db');
  const logsDir = join(DOCLAB_DIR, 'logs');

  // Daemon memory (via ps)
  if (pid) {
    try {
      const proc = spawn('ps', ['-o', 'rss=', '-p', String(pid)], {
        stdio: 'pipe',
      });
      const out = await new Promise<string>((resolve) => {
        let data = '';
        proc.stdout.on('data', (chunk: Buffer) => (data += chunk.toString()));
        proc.stdout.on('end', () => resolve(data));
      });
      const rssKB = parseInt(out.trim()) || 0;
      if (rssKB > 0) {
        console.log(`${c.heading}Daemon (pid: ${pid})${c.reset}`);
        console.log(`${c.label}RSS:${c.reset}  ${formatKB(rssKB)}`);
      }
    } catch {
      console.log(`${c.warn}Daemon not running${c.reset}`);
    }
  } else {
    console.log(`${c.warn}Daemon not running (no pid file)${c.reset}`);
  }

  // CLI process memory
  const cliMem = process.memoryUsage();
  console.log(`${c.heading}CLI (pid: ${process.pid})${c.reset}`);
  console.log(`${c.label}RSS:${c.reset}  ${formatBytes(cliMem.rss)}`);
  console.log(`${c.label}Heap:${c.reset} ${formatBytes(cliMem.heapUsed)} / ${formatBytes(cliMem.heapTotal)}`);

  // Database file size
  if (existsSync(dbPath)) {
    const { size } = await Bun.file(dbPath).stat();
    console.log(`${c.heading}Database${c.reset}`);
    console.log(`${c.label}DB:${c.reset}    ${formatBytes(size)} ${c.dim}(${dbPath})${c.reset}`);
  }

  // Logs directory size
  if (existsSync(logsDir)) {
    const logSize = await dirSize(logsDir);
    if (logSize > 0) {
      console.log(`${c.label}Logs:${c.reset}   ${formatBytes(logSize)} ${c.dim}(${logsDir})${c.reset}`);
    }
  }

  // Ollama / vector index estimate
  const port = readPort();
  if (port && (await isDaemonRunning(port))) {
    const health = await apiGet<HealthResponse>(port, '/health');
    if (health?.embeddingDims && health.chunks) {
      const vecBytes = health.embeddingDims * 4 * health.chunks;
      console.log(`${c.label}Vec idx:${c.reset} ${formatBytes(vecBytes)} ${c.dim}(${health.embeddingDims}d × ${health.chunks} chunks)${c.reset}`);
    }
  }

  console.log();
  console.log(`${c.dim}${'─'.repeat(40)}${c.reset}`);
  const daemonRSS = pid ? await getDaemonRSS(pid) : 0;
  const totalRSS = daemonRSS + cliMem.rss;
  const label = pid ? `${c.dim}(daemon + CLI)${c.reset}` : `${c.dim}(CLI only)${c.reset}`;
  console.log(`${c.bold}Total RSS:${c.reset} ${formatBytes(totalRSS)} ${label}`);
}

// ─── Daemon helpers ───

function readPort(): number | null {
  try {
    const raw = readFileSync(PORT_FILE, 'utf-8').trim();
    return parseInt(raw) || null;
  } catch {
    return null;
  }
}

function readPid(): number | null {
  try {
    const raw = readFileSync(PID_FILE, 'utf-8').trim();
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
  console.log('Starting doclab daemon...');
  await cmdStart();

  const newPort = readPort();
  if (!newPort || !(await isDaemonRunning(newPort))) {
    console.error(`${c.error}Failed to start daemon${c.reset}`);
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
  try {
    unlinkSync(PORT_FILE);
  } catch {}
  try {
    unlinkSync(PID_FILE);
  } catch {}
}

function findDaemonScript(): string {
  // In dev: src/server-daemon.ts
  // In production: dist/server-daemon.js (relative to cli.js)
  const devPath = join(import.meta.dir, 'server-daemon.ts');
  if (existsSync(devPath)) {
    return devPath;
  }

  const distPath = join(import.meta.dir, 'server-daemon.js');
  if (existsSync(distPath)) {
    return distPath;
  }

  // Fallback: try relative to cwd
  const cwdDev = join(process.cwd(), 'src', 'server-daemon.ts');
  if (existsSync(cwdDev)) {
    return cwdDev;
  }

  const cwdDist = join(process.cwd(), 'dist', 'server-daemon.js');
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
  body: unknown,
): Promise<T | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const errBody = (await response.json()) as ErrorResponse;
      throw new Error(errBody.error ?? `HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  } catch (e: any) {
    if (e.message && !e.message.includes('fetch')) {
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

function formatKB(kb: number): string {
  return formatBytes(kb * 1024);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function getDaemonRSS(pid: number): Promise<number> {
  try {
    const proc = spawn('ps', ['-o', 'rss=', '-p', String(pid)], {
      stdio: 'pipe',
    });
    const out = await new Promise<string>((resolve) => {
      let data = '';
      proc.stdout.on('data', (chunk: Buffer) => (data += chunk.toString()));
      proc.stdout.on('end', () => resolve(data));
    });
    return (parseInt(out.trim()) || 0) * 1024;
  } catch {
    return 0;
  }
}

async function dirSize(dirPath: string): Promise<number> {
  try {
    const entries = readdirSync(dirPath);
    let total = 0;
    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      try {
        const s = statSync(fullPath);
        if (s.isFile()) total += s.size;
        else if (s.isDirectory()) total += await dirSize(fullPath);
      } catch {}
    }
    return total;
  } catch {
    return 0;
  }
}

function parseIntervalStr(interval: string): number {
  if (interval === 'never') return 0;
  const match = interval.match(/^(\d+)(h|m|d)$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'h':
      return value * 60 * 60 * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForShutdown(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // signal 0 = check existence
      await sleep(100);
    } catch {
      return; // process is gone
    }
  }
  // timeout — process still alive, force kill
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

function printHelp() {
  console.log(`${c.bold}doclab${c.reset} ${c.dim}— Local knowledge server for coding agents${c.reset}
`);
  console.log(`${c.dim}Usage:${c.reset} ${c.bold}doclab${c.reset} ${c.dim}<command>${c.reset} ${c.dim}[...flags]${c.reset} ${c.dim}[...args]${c.reset}
`);
  console.log(`${c.bold}Commands:${c.reset}`);
  console.log(`  ${c.cyan}help${c.reset}                       ${c.dim}Show this help${c.reset}`);
  console.log(`  ${c.cyan}start${c.reset}                     ${c.dim}Start global daemon (idempotent)${c.reset}`);
  console.log(`  ${c.cyan}stop${c.reset}                      ${c.dim}Stop daemon${c.reset}`);
  console.log(`  ${c.cyan}status${c.reset}                    ${c.dim}Daemon status${c.reset}`);
  console.log(`  ${c.cyan}mem | memory${c.reset}              ${c.dim}Real-time memory usage${c.reset}`);
  console.log(`  ${c.cyan}add${c.reset} ${c.dim}<url>${c.reset} ${c.dim}[--name <n>]${c.reset}    ${c.dim}Add source: fetch → chunk → embed${c.reset}`);
  console.log(`  ${c.cyan}remove | rm${c.reset} ${c.dim}<name>${c.reset}         ${c.dim}Remove source${c.reset}`);
  console.log(`  ${c.cyan}list${c.reset}                      ${c.dim}List all sources with freshness${c.reset}`);
  console.log(`  ${c.cyan}pull${c.reset} ${c.dim}[name]${c.reset}               ${c.dim}Re-fetch sources${c.reset}`);
  console.log(`  ${c.cyan}search${c.reset} ${c.dim}<query>${c.reset} ${c.dim}[...]${c.reset}      ${c.dim}Hybrid search${c.reset}`);
  console.log(`  ${c.cyan}rebuild${c.reset}                   ${c.dim}Drop DB, re-index all from scratch${c.reset}`);
  console.log(`  ${c.cyan}init${c.reset}                      ${c.dim}Generate AGENTS.md snippet${c.reset}`);
  console.log();
  console.log(`${c.bold}Search options:${c.reset}`);
  console.log(`  ${c.cyan}--source${c.reset} ${c.dim}<name>${c.reset}   ${c.dim}Filter by source${c.reset}`);
  console.log(`  ${c.cyan}--kind${c.reset} ${c.dim}<kind>${c.reset}     ${c.dim}Filter by kind (docs, article, tutorial, reference)${c.reset}`);
  console.log(`  ${c.cyan}--topK${c.reset} ${c.dim}<n>${c.reset}         ${c.dim}Max results (default: 5)${c.reset}`);
  console.log();
  console.log(`${c.bold}Examples:${c.reset}`);
  console.log(`  ${c.dim}$ ${c.reset}doclab add ${c.dim}https://hono.dev/llms-full.txt${c.reset}`);
  console.log(`  ${c.dim}$ ${c.reset}doclab search ${c.dim}"hono cors middleware"${c.reset}`);
  console.log(`  ${c.dim}$ ${c.reset}doclab search ${c.dim}"hooks" --source react-docs --kind article${c.reset}`);
  console.log(`  ${c.dim}$ ${c.reset}doclab pull${c.reset}`);
  console.log(`  ${c.dim}$ ${c.reset}doclab init >> AGENTS.md${c.reset}`);
}

// ─── Run ───

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
