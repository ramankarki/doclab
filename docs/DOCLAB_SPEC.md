# doclab — Local Knowledge Server for Coding Agents

> **Status:** Design Document v1.0 — Final. Ready for implementation.

> **Philosophy:** Agents write stale code because their training data is old. doclab gives them fresh documentation, articles, and technical references on demand — local, private, fast.

---

## Table of Contents

1. [What is doclab?](#1-what-is-doclab)
2. [Architecture Overview](#2-architecture-overview)
3. [Developer Experience](#3-developer-experience)
4. [Source Model](#4-source-model)
5. [Chunking Strategy](#5-chunking-strategy)
6. [Embeddings & Vector Search](#6-embeddings--vector-search)
7. [Hybrid Retrieval](#7-hybrid-retrieval)
8. [Agent Integration](#8-agent-integration)
9. [Data Model](#9-data-model)
10. [Freshness & Source Lifecycle](#10-freshness--source-lifecycle)
11. [Comparison Matrix](#11-comparison-matrix)
12. [File Structure](#12-file-structure)
13. [Package & Build Config](#13-package--build-config)
14. [Testing Strategy](#14-testing-strategy)
15. [Scope (v1)](#15-scope-v1)

**Appendices:** [A: Why No LlamaIndex](#appendix-a-why-no-llamaindex) · [B: Why Global Server](#appendix-b-why-global-server) · [C: Competitive Landscape](#appendix-c-competitive-landscape)

---

## 1. What is doclab?

A **local knowledge server** that gives coding agents fresh technical content on demand. Not just package docs — any URL: framework guides, blog posts, tutorials, API references, migration notes, "how to" articles.

Agents query it before writing code. They get real, current information instead of guessing from stale training data.

### The Problem

```
Agent: "I'll add CORS middleware in Hono."
Agent writes: app.use(cors())              ← Hono v3 API
Reality: Hono v4 requires app.use('*', cors())  ← Agent doesn't know
```

### The Flow

```
Agent starts task "add Stripe webhook handler"
  │
  ├─ doclab search "stripe webhook verify signature"
  │   → Returns exact docs from Stripe's reference page
  │   → Shows: stripe.webhooks.constructEvent(payload, sig, secret)
  │   → Agent writes correct code, first try
  │
Agent asks "how to use Bun with Drizzle ORM"
  │
  ├─ doclab search "bun drizzle setup connection"
  │   → Returns: Drizzle docs section + blog post about Bun+Drizzle stack
  │   → Agent sees both official API and real-world usage
  │
  └─ No hallucination. No guessing. Real sources.
```

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                    Agent                         │
│  (Pi / Claude Code / Cline / custom)            │
└──────────┬───────────────────────────────────────┘
           │ HTTP
           ▼
┌──────────────────────────────────────────────────┐
│  doclab daemon (global, one per machine)         │
│  Bun.serve on auto-assigned port                 │
│                                                  │
│  ┌────────────────────┐  ┌────────────────────┐  │
│  │ Content Fetcher    │  │ HTML → Markdown    │  │
│  │ (URL → raw bytes)  │  │ (preserves fences, │  │
│  │ ETag, hash diff    │  │  headings, links)  │  │
│  └────────┬───────────┘  └────────┬───────────┘  │
│           │                       │              │
│           ▼                       ▼              │
│  ┌────────────────────────────────────────────┐  │
│  │ Markdown Chunker                           │  │
│  │ Splits on h2, preserves code fences        │  │
│  │ No max chunk size — semantic unit atomic   │  │
│  └────────────────────┬───────────────────────┘  │
│                       │                          │
│                       ▼                          │
│  ┌────────────────────┐  ┌────────────────────┐  │
│  │ Embedding Engine   │  │ Hybrid Search      │  │
│  │ (Ollama / OpenAI / │  │ (vector + keyword  │  │
│  │  Voyage)           │  │  + RRF fusion)     │  │
│  └────────┬───────────┘  └────────┬───────────┘  │
│           │                       │              │
│           ▼                       ▼              │
│  ┌────────────────────────────────────────────┐  │
│  │  SQLite + sqlite-vec                       │  │
│  │  - chunks (text + metadata)                │  │
│  │  - embeddings (vec0 ANN index)             │  │
│  │  - source registry + freshness             │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision                           | Why                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Single global daemon**           | One server serves all agents, all projects. Knowledge is project-agnostic.                                 |
| **Any URL, not just llms.txt**     | Framework docs, blog posts, tutorials, migration guides — all same pipeline.                               |
| **HTML → Markdown conversion**     | Preserves headings, code blocks, links. Non-markdown URLs handled automatically.                           |
| **sqlite-vec**                     | Proven in codeview. WAL, transactions, concurrent reads. Zero infra.                                       |
| **turndown + GFM for HTML→MD**      | Battle-tested library. Handles tables, code fences, nested lists, all edge cases. Replaces custom regex converter. |
| **Custom semantic chunker**         | Splits on h2→h3→h4 headers, preserves code fences, targets 2500 chars. Paragraph fallback with fence-safe merging. No LlamaIndex. |
| **No generation in v1**            | Agents are LLMs. They synthesize answers from raw chunks better than small local models.                   |
| **Ollama default, multi-provider** | Same embedding abstraction as codeview. Free local, or paid API.                                           |
| **Scheduled rebuilds**             | Content doesn't change while you code. 24h default.                                                        |
| **Hybrid search**                  | Vector + FTS5/BM25 keyword + RRF. Pure vector misses exact API names. BM25 catches them with statistical ranking. |
| **URL death = cleanup**            | Source returns 404/410/connection failure → chunks removed. Dead links = dead knowledge.                   |
| **Resource minimal**               | ~350MB total (nomic-embed-text + Bun + SQLite). Less than a Chrome tab.                                    |

### Resource Profile

| Component                   | RAM         |
| --------------------------- | ----------- |
| `nomic-embed-text` (Ollama) | ~270 MB     |
| Bun runtime                 | ~30 MB      |
| SQLite + vec0 index         | ~50 MB      |
| **Total**                   | **~350 MB** |

### Degraded Mode

If no embedding engine is configured or reachable:

- `search` falls back to keyword-only (case-insensitive substring + token overlap)
- Response includes `degraded: true`
- Server prints hint: `Install ollama: brew install ollama && ollama pull nomic-embed-text`

---

## 3. Developer Experience

### 3.1 Data Storage

```
~/.doclab/
├── doclab.db           # SQLite (chunks + vec0 embeddings + source registry)
├── port                # "8475" — agent reads this to find server
├── pid                 # process ID for health checks
└── dlconfig.json       # source registry + settings
```

Global. One per machine. Not in any project.

### 3.2 Package Model

```bash
bun add -g doclab
doclab start
```

Global install. One daemon, all projects share it.

### 3.3 Getting Started

```
$ doclab start                          # first run: no config yet
[OK] sqlite-vec: loaded
[OK] Ollama: connected (nomic-embed-text, 768d)
[WARN] No sources configured. Add some:
  doclab add https://hono.dev/llms-full.txt
  doclab add https://orm.drizzle.team/llms-full.txt
  doclab add https://some-blog.com/react-patterns
[OK] Ready on http://127.0.0.1:8475

$ doclab add https://hono.dev/llms-full.txt
queued: https://hono.dev/llms-full.txt
check status: doclab log

$ doclab add https://overreacted.io/why-do-hooks-rely-on-call-order/
queued: https://overreacted.io/why-do-hooks-rely-on-call-order
check status: doclab log

$ doclab search "react hooks call order"
1. overreacted-why-do-hooks (distance: 0.08)
   "Why Do Hooks Rely on Call Order?" — Dan Abramov
   ...
```

### 3.4 Source Management CLI

```
doclab add <url> [--name <name>]    # queue source for background processing
doclab log                          # attach to live worker log (real-time progress)
doclab queue                        # show queued and processing jobs
doclab remove <name>                # queue source removal
doclab list                         # all sources with freshness
doclab pull [name]                  # queue re-fetch
doclab rebuild                      # queue full re-index
```

**`doclab add`:** Queues URL for background processing. The worker fetches, converts HTML to markdown, chunks, and embeds. Name auto-generated from URL if not provided. Check progress with `doclab log`.

**`doclab log`:** Attaches to the daemon's live worker stream. Shows real-time fetch, chunk, and embed progress with timestamps. Detach with Ctrl+C.

**`doclab list`:**

```
$ doclab list
NAME                    URL                                          CHUNKS  FETCHED
──────────────────────────────────────────────────────────────────────────────────
hono                    https://hono.dev/llms-full.txt                   312  3h ago
drizzle                 https://orm.drizzle.team/llms-full.txt          421  3h ago
better-auth             https://better-auth.dev/llms-full.txt           204  1d ago ⚠
overreacted-why-do-hooks  https://overreacted.io/why-do-hooks-rely...    8  3h ago

total: 4
```

### 3.5 CLI Surface (Full)

```
doclab start                    # start global daemon (idempotent)
doclab stop                     # stop daemon
doclab status                   # daemon status, chunk count, ollama status
doclab add <url> [--name <n>]   # queue source (worker processes in background)
doclab log                      # attach to live worker log
doclab queue                    # show queued and processing jobs
doclab remove <name>            # queue source removal
doclab list                     # all sources with freshness
doclab pull [name]              # queue re-fetch sources
doclab rebuild                  # queue full re-index
doclab search <query> [--source <n>] [--topK <k>]  # hybrid search
doclab init                     # generate AGENTS.md snippet
doclab -v | --version           # print version
doclab mem                       # real-time memory usage (daemon, CLI, DB, logs, vec idx)
doclab memory                    # alias for doclab mem
```

### 3.6 CLI Output Style

doclab uses a semantic color design system (zero dependencies, ANSI escape codes).

**Design tokens** (`src/lib/colors.ts`):

| Token         | Color     | Usage                                  |
| ------------- | --------- | -------------------------------------- |
| `c.heading`   | bold cyan | Table headers, section titles          |
| `c.cmd`       | cyan      | Command names, executable references   |
| `c.arg`       | dim       | Argument placeholders in help          |
| `c.success`   | green     | OK, Ready, Added, Updated, Complete    |
| `c.error`     | red       | Failed, errors, fatal                  |
| `c.warn`      | yellow    | Warnings, stale indicator, unreachable |
| `c.dim`       | dim       | Separators, total line, secondary info |
| `c.info`      | cyan      | Daemon lifecycle (rebuild, shutdown)   |
| `c.label`     | dim       | Status labels (Daemon:, Ollama:, etc.) |
| `c.highlight` | bold      | Important values, Search: label        |
| `c.muted`     | gray      | De-emphasized text                     |

**Rules:**

- NO_COLOR env or non-TTY → all codes stripped (clean in CI/pipes)
- Log files are always plain text (no ANSI codes written to disk)
- Errors route to stderr (`console.error`) with `c.error` styling
- Success messages use `c.success`, warnings use `c.warn`
- Server logs prefix with `[OK]` (green) or `[WARN]` (yellow)

**`list` command table format:**

```
NAME             URL                              VERSION   CHUNKS  FETCHED
───────────────────────────────────────────────────────────────────────────
react-docs       https://react.dev/reference/...  v19.0         42  2h ago
hono             https://hono.dev/llms-full.txt   —             15  never
svelte-kit       https://kit.svelte.dev/docs/...  v4.5           8  3d ago ⚠

total: 3
```

Columns auto-sized. URL capped at 50 chars with … truncation. Stale rows (fetched > rebuildInterval) show yellow ⚠.

### 3.7 `doclab mem` Output

```
$ doclab mem
Daemon (pid: 48291)
RSS:  156.5 MB

CLI (pid: 58321)
RSS:  64.2 MB
Heap: 28.1 MB / 32.8 MB

Database
DB:     1.8 MB (~/.doclab/doclab.db)
Logs:    0.5 MB (~/.doclab/logs)

Vec idx: 24.5 MB (768d × 8356 chunks)

────────────────────────────────────────
Total RSS: 220.7 MB (daemon + CLI)
```

### 3.8 `doclab status` Output

```
$ doclab status
Daemon:      running on http://127.0.0.1:8475 (pid: 48291)
Ollama:      connected (nomic-embed-text, 768d)
Uptime:      3h 12m
Sources:     4 (1,247 chunks total)
Last pull:   2026-06-08 09:32 UTC (3 hours ago)
Next pull:   2026-06-09 09:32 UTC (in 21 hours)
Idle timeout: 30m (last request 2m ago)
```

When daemon not running:

```
$ doclab status
Daemon: not running
  Start with: doclab start
```

### 3.9 Auto-Start

```
$ doclab search "hono cors"          # daemon not running? auto-starts
Starting doclab daemon...
Ready on http://127.0.0.1:8475
[search results...]
```

Any query command auto-starts the daemon if it's not running.

### 3.10 Stop

```
doclab stop
```

Server also auto-shuts down after 30 minutes idle (configurable in `dlconfig.json`).

### 3.10 Startup Sequence

When `doclab start` is called:

```
1. Check if daemon already running
   → Read ~/.doclab/port and ~/.doclab/pid
   → If port file exists AND process alive: Already running on :8475 (exit 0)
   → If port file exists but process dead: clean up stale files, continue

2. Config validation
   → Load ~/.doclab/dlconfig.json
   → Validate sources, embedding config, intervals (see §3.11)
   → If invalid: print error, exit 1
   → If config missing (first run): create empty config, print setup hint, continue

3. SQLite setup
   → Open/create ~/.doclab/doclab.db
   → Load sqlite-vec extension
   → macOS: set custom SQLite path if needed (Homebrew)
   → Run migrations: create tables if not exist
   → If sqlite-vec fails: print error with install instructions, exit 1

4. Ollama check
   → Ping http://localhost:11434/api/tags
   → If reachable AND embedding model found: [OK] Ollama: connected (model, dims)
   → If reachable but model not pulled: warn, print pull command, degraded mode
   → If unreachable: warn, degraded mode (keyword search only)
   → If embedding provider is openai/voyage: check API key, warn if missing

5. Spawn daemon child process
   → Bun.spawn(['bun', 'dist/server-daemon.js'], { detached: true })
   → Child writes port to ~/.doclab/port
   → Child writes pid to ~/.doclab/pid
   → Child starts Bun.serve on auto-assigned port (or config port)

6. Parent waits for child to bind
   → Poll http://127.0.0.1:{port}/health (max 10s, 200ms intervals)
   → On success: Ready on http://127.0.0.1:8475
   → On timeout: Daemon failed to start, check logs
   → Parent exits, child runs in background

7. Daemon indexes unbuilt sources (background)
   → On startup, daemon checks: are there sources in config with chunk_count = 0?
   → If yes: index them in background (non-blocking)
   → /health returns { status: "indexing" } until complete
   → Searches return 503 NOT_READY while first index is running
   → Once complete: /health returns { status: "ok" }
   → Sources added via `doclab add` during indexing: queued, indexed after current batch
```

**Subsequent starts:** All steps are idempotent. Step 1 catches existing daemon, exits immediately.

### 3.11 Config Validation

On startup, `~/.doclab/dlconfig.json` is validated:

| Check                                                | Action                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| File missing (first run)                             | Warn: "No config yet. Add sources with: doclab add <url>". Create empty config. Continue.               |
| Invalid JSON                                         | Error: "dlconfig.json: Invalid JSON at line {n}." Exit 1.                                               |
| `sources` not an array                               | Error: "dlconfig.json: 'sources' must be an array." Exit 1.                                             |
| `sources[].url` missing or empty                     | Error: "dlconfig.json: Source '{name}' missing 'url'." Exit 1.                                          |
| `sources[].url` not a valid URL                      | Error: "dlconfig.json: '{url}' is not a valid URL." Exit 1.                                             |
| Duplicate source name                                | Error: "dlconfig.json: Duplicate source name '{name}'." Exit 1.                                         |
| `embedding.provider` not in [ollama, openai, voyage] | Error: "dlconfig.json: Unknown embedding provider '{provider}'. Valid: ollama, openai, voyage." Exit 1. |
| `embedding.apiKey` resolves to empty (openai/voyage) | Warn: "API key not set. Embedding disabled." Enter degraded mode.                                       |
| `rebuildInterval` unparseable                        | Warn: "Invalid rebuildInterval. Using default: 24h."                                                    |
| `idleTimeout` unparseable                            | Warn: "Invalid idleTimeout. Using default: 30m."                                                        |
| `port` specified but in use                          | Error: "Port {port} is in use. Pick another or remove 'port' from config." Exit 1.                      |

**Error format:**

```
dlconfig.json: Source 'missing-docs' has no 'url' field.
  Fix: Add a 'url' field or remove the source with 'doclab remove missing-docs'.
```

Validation runs on startup AND on `doclab add` (before committing to config). Invalid `add` is rejected before any fetch.

### 3.12 Concurrency & Queue

SQLite in WAL mode handles concurrent reads natively. Writes are serialized through a DB-backed FIFO queue.

| Scenario                               | Handling                                                      |
| -------------------------------------- | ------------------------------------------------------------- |
| Multiple `search` calls simultaneously | ✅ WAL mode. Concurrent reads, safe.                          |
| `search` while write is running        | ✅ Reads see old data until write commits. WAL isolation.     |
| Two `add` calls simultaneously         | ✅ Second add enqueued, processed after first completes.      |
| Two `pull` calls simultaneously        | ✅ Second pull enqueued. No 409 errors.                       |

**Queue system:** All write operations (add, remove, pull, rebuild) are enqueued to a `write_queue` table in SQLite. A single worker loop picks jobs FIFO, processes them sequentially, and broadcasts progress to `/log` subscribers. The queue survives daemon crashes — unfinished jobs are resumed on restart via `startWorker`, which maintains a `workerRunning` mutex ensuring only one worker runs at a time.

**Source visibility rule:** A source becomes visible in `doclab list` only after ALL processing completes — fetch, chunk, embed, and vector store. `upsertSource` and `addSourceToConfig` are deferred until after embedding finishes. No gap between "source appears in list" and "queue job removed" — both happen atomically.

**Write lock:** An in-memory `isWriting` flag tracks whether a write is in progress (used by `/health` and idle timeout to avoid mid-job shutdown). HTTP handlers that enqueue with a callback will receive the result when their job completes.

### 3.13 Daemon Lifecycle

```
Daemon started (Bun.spawn child process)
  │
  ├─ Writes ~/.doclab/pid (its own process.pid)
  ├─ Starts Bun.serve → writes port to ~/.doclab/port
  ├─ Starts idle timer (configurable, default 30 min)
  │
  ├─ On SIGTERM / SIGINT:
  │   ├─ Close HTTP server (stop accepting new connections)
  │   ├─ Complete in-flight requests (drain, max 5s)
  │   ├─ Close SQLite database
  │   ├─ Remove ~/.doclab/pid and ~/.doclab/port
  │   └─ process.exit(0)
  │
  ├─ On idle timeout (30 min no requests):
  │   └─ Same graceful shutdown as above
  │
  ├─ On crash (unhandled error):
  │   ├─ PID file may persist (stale)
  │   ├─ Next `doclab start` detects stale PID → cleans up → restarts
  │   └─ SQLite WAL auto-recovers on next open
  │
  └─ Stale detection:
      └─ `doclab start` reads PID file → process_exists(pid)?
          → No: clean up PID + port, start fresh
          → Yes: "Already running"
```

**Crash recovery:** SQLite WAL mode auto-recovers. No data loss from crash. PID file is only mechanism that can go stale — `doclab start` handles this by checking process existence.

---

## 4. Source Model

### 4.1 Any URL

doclab accepts any URL with technical content:

| Type             | Examples                                               | Format   |
| ---------------- | ------------------------------------------------------ | -------- |
| Package docs     | `hono.dev/llms-full.txt`, `drizzle.team/llms-full.txt` | Markdown |
| Framework guides | `nextjs.org/docs/app/building-your-application`        | HTML     |
| Blog posts       | `overreacted.io/why-do-hooks-rely-on-call-order`       | HTML     |
| Tutorials        | `dev.to/...`, `freecodecamp.org/...`                   | HTML     |
| API references   | `stripe.com/docs/api`                                  | HTML     |
| Migration guides | `react.dev/blog/...`                                   | HTML     |
| Readme pages     | `github.com/user/repo#readme`                          | Markdown |
| Raw markdown     | Any URL returning `text/markdown` or `text/plain`      | Markdown |

### 4.2 Content Format Detection

```
Fetch URL
  → Check Content-Type header
  → If text/markdown or text/plain → treat as markdown
  → If text/html → convert to markdown, then chunk
  → Everything else → error: "Unsupported content type: ..."
```

### 4.2.1 llms.txt Expansion

[llms.txt](https://llmstxt.org/) files are curated tables of contents — link directories pointing to sub-pages with the actual documentation. doclab detects these automatically and expands them into full documentation.

**Detection:** Any URL whose pathname ends with `/llms.txt` triggers expansion. Query parameters and hash fragments are ignored.

**Expansion flow:**
```
1. Fetch llms.txt → extract all relative markdown links [label](/path/to/page.md)
2. Resolve links to absolute URLs (same domain only, skip external/anchor-only)
3. Fetch every sub-page (concurrency: 5), convert HTML to markdown
4. Concatenate all sub-pages into one document (llms-full.txt equivalent)
5. Chunk the concatenated document normally (h2/h3 → semantic chunks)
```

**Partial failures:** If some sub-pages fail to fetch (404, timeout), a warning is logged and successful pages are indexed. Only when ALL sub-pages fail is the source rejected entirely.

**Retry:** Each sub-page fetch retries up to 3 times with exponential backoff (1s, 2s) on transient errors (429, 502, 503, connection refused). Jina AI fallback after retries exhausted for eligible status codes.

**CLI prompt:** After adding a non-llms.txt URL, doclab probes the domain for `llms-full.txt` and `llms.txt`. If found, it prompts: "Found full docs at <url>. Add them too? (y/N)"

**Result:** Adding `https://better-auth.com/llms.txt` indexes ~1800+ chunks of real documentation — identical in result to adding an `llms-full.txt` file, just with more HTTP requests.

### 4.3 HTML → Markdown Conversion

Purpose: normalize to markdown so chunking works uniformly.

Rules:

- `<h1>`-`<h6>` → `#`-`######`
- `<pre><code>` → fenced code block (detect language from class)
- `<code>` (inline) → backtick-wrapped
- `<a href>` → `[text](href)` if relevant, stripped if nav/boilerplate
- `<img>` → stripped (alt text kept if meaningful)
- `<ul>/<ol>` → markdown lists
- `<strong>/<em>` → `**text**` / `*text*`
- `<table>` → markdown table if simple, stripped if complex
- `<nav>`, `<footer>`, `<script>`, `<style>`, `<aside>` → removed
- `<article>`, `<main>` → content extracted from these if present

**turndown + GFM plugin.** HTML → Markdown conversion uses the battle-tested turndown library with GitHub Flavored Markdown plugin for table support. Custom rule preserves framework-specific `<Tab>` component labels. Navigation, footers, and scripts are stripped before conversion.

### 4.4 Config: `~/.doclab/dlconfig.json`

```json
{
  "sources": [
    {
      "name": "hono",
      "url": "https://hono.dev/llms-full.txt"
    },
    {
      "name": "drizzle",
      "url": "https://orm.drizzle.team/llms-full.txt"
    },
    {
      "name": "overreacted-why-hooks",
      "url": "https://overreacted.io/why-do-hooks-rely-on-call-order/"
    }
  ],
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "ollamaUrl": "http://localhost:11434"
  },
  "rebuildInterval": "24h",
  "maxChunksPerQuery": 10,
  "idleTimeout": "30m"
}
```

**Config fields:**

| Field                 | Type   | Default                    | Description                                     |
| --------------------- | ------ | -------------------------- | ----------------------------------------------- |
| `sources[].name`      | string | auto                       | Short name. Auto-generated from URL if omitted. |
| `sources[].url`       | string | —                          | URL to fetch. Any technical content.            |
| `embedding.provider`  | string | `"ollama"`                 | `ollama` / `openai` / `voyage`                  |
| `embedding.model`     | string | auto                       | Model override                                  |
| `embedding.ollamaUrl` | string | `"http://localhost:11434"` | Custom Ollama host                              |
| `embedding.apiKey`    | string | —                          | API key. Supports `$ENV_VAR`.                   |
| `rebuildInterval`     | string | `"24h"`                    | Auto-rebuild: `"12h"`, `"7d"`, `"never"`        |
| `maxChunksPerQuery`   | number | `10`                       | Top K chunks per search                         |
| `idleTimeout`         | string | `"30m"`                    | Auto-shutdown after idle                        |

### 4.5 Source Metadata

Extracted during fetch:

```typescript
interface SourceMeta {
  name: string // from config or auto-generated
  url: string // fetch URL
  title: string // from <title> or first h1
  fetchedAt: string // ISO 8601
  contentHash: string // SHA256 of raw content
  chunkCount: number
  version?: string // detected from docs (e.g. "v4.6.5")
  author?: string // from <meta name="author"> if present
  publishedAt?: string // from <meta property="article:published_time"> if present
  domain: string // extracted from URL (e.g. "hono.dev")
  kind: 'docs' | 'article' | 'tutorial' | 'reference' | 'unknown'
}
```

**Kind detection:**

- URL path contains `/docs/`, `/reference/`, `/api/` → `docs` or `reference`
- URL is `llms-full.txt` → `docs`
- Page has `<article>` with `published_time` → `article`
- Domain is `dev.to`, `freecodecamp.org`, `medium.com` → `article`/`tutorial`
- Fallback: `unknown`

**Version detection:** Scan first 5000 chars for patterns like `v4.6.5`, `Version: 1.2.0`, `### v2.0.0`.

### 4.6 Source Lifecycle

```
doclab add <url>
  → Fetch → Chunk → Embed → Add to dlconfig.json
  → Source is now "active"

On rebuild schedule (every 24h):
  → For each source in config:
    → Fetch URL
    → If 200 + content changed → re-chunk, re-embed, update metadata
    → If 200 + unchanged → skip, update fetchedAt
    → If 404/410 → source is dead → delete chunks, remove from config
      print: "hono: URL returned 404. Source removed."
    → If connection error → mark stale, retry next cycle
      after 3 consecutive failures → remove
      print: "some-blog: unreachable 3 times. Source removed."

doclab remove <name>
  → Delete chunks → Remove from config
  → Manual cleanup. Immediate.
```

**Key rule:** Source exists in our system exactly as long as the URL exists. Dead URL → dead source. No zombies.

---

## 5. Chunking Strategy

### 5.1 Why Custom

Markdown chunking splits on h2→h3→h4 headers, targets 2500 chars, preserves code fences. Paragraph fallback uses fence-safe merging with accurate position tracking. No LlamaIndex needed.

### 5.2 Core Algorithm

Recursive splitting: each level splits chunks that exceed the target size, descending into finer headers.

````
TARGET_CHUNK_SIZE = 2500  // chars (~400 tokens). Fits embedding window + agent context.
MIN_CHUNK_SIZE = 100      // skip near-empty sections

function chunk(text: string, level: HeaderLevel, parentPath: string): Chunk[] {

  // 1. Pick split pattern for this header level
  const pattern = level === 'h2' ? /^## /gm
                : level === 'h3' ? /^### /gm
                : level === 'h1' ? /^# /gm
                : null  // no headers → paragraph split

  // 2. Split on headers at this level
  const sections = pattern ? splitPreservingFences(text, pattern) : [text]

  // 3. Process each section
  for each section:
    a. Extract header text → update breadcrumb path
    b. Skip if section length < MIN_CHUNK_SIZE
    c. If section.length > TARGET_CHUNK_SIZE:
       → Try splitting at next deeper header level (h2→h3, h3→h4, etc.)
       → If no deeper headers available AND still too large:
          → Split on paragraph breaks (\n\n+)
          → BUT never split inside a ``` fence
          → Merge adjacent fragments < 200 chars
          → If a code block alone exceeds TARGET_CHUNK_SIZE: keep whole
    d. Else: keep as one chunk

  // 4. Return all chunks with metadata
}
````

**Splitting with fence awareness:**

````typescript
function splitPreservingFences(text: string, pattern: RegExp): string[] {
  // 1. Find all code fence spans (``` pairs)
  // 2. Split text by pattern
  // 3. If a split point falls inside a fence span → don't split there
  //    Instead, shift split to before the fence opens or after it closes
  // 4. Return safe split points
}
````

### 5.3 Critical Rules

| Rule                               | Reason                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------- |
| **NEVER split inside code fences** | A code block is one semantic unit. Splitting mid-function destroys value.  |
| **Target chunk: 2500 chars**       | ~400 tokens. Best balance for embedding precision + agent context.         |
| **No hard max**                    | A 5000-char code block stays whole. Fence preservation beats size limit.   |
| **Min chunk: 100 chars**           | Skip near-empty sections ("### See Also" with one link, TOC entries).      |
| **Merge adjacent small chunks**    | After paragraph split, merge fragments < 200 chars into neighbors.         |
| **Preserve all whitespace**        | Code indentation matters. Don't normalize.                                 |
| **Recursive descending**           | h2 too big → try h3. h3 too big → try h4. No magic thresholds — just size. |
| **Breadcrumb inheritance**         | Each split level inherits parent path: "Hono > Middleware > CORS".         |

### 5.4 Fallback Cascade

```
Page with h2 headers (most content):
  → Split on ##
  → Sections > 2500 chars → split on ###
  → Sections still > 2500 → paragraph breaks (fence-aware)
  → Result: tight, semantic chunks

Page with only h1 (single-page article):
  → Split on # (one h1 section)
  → If > 2500: split on ## (if any) or ### (if any)
  → If still > 2500: paragraph breaks
  → Keeps code blocks intact

Page with no headers at all (rare, bad HTML):
  → Split on paragraph breaks (\n\n+)
  → Merge adjacent fragments < 200 chars
  → Code fences stay whole
  → Warn: "no headers found — paragraph-level chunking, search precision may vary"
```

### 5.5 Chunk Data Structure

```typescript
interface DocChunk {
  id: number // autoincrement = vec0 rowid
  hash: string // SHA256(source + sectionPath)[:16]
  source: string // source name
  sectionPath: string // "Hono > Middleware > CORS" or article title
  header: string // raw header text "## CORS Middleware"
  content: string // full section including code fences
  hasCodeBlocks: boolean // quick filter for code-heavy sections
  createdAt: string // ISO 8601, set on insert
  updatedAt: string // ISO 8601, updated on re-index
}
```

### 5.6 Example: Blog Post Chunking

Input (has h2 headers — standard article structure):

```markdown
# Why Do React Hooks Rely on Call Order?

React hooks rely on call order because...

## How useState Works Internally

The Fiber architecture stores hooks as a linked list...

<long code block: 80 lines>

## The Rules of Hooks

Only call hooks at the top level...

<another code block: 40 lines>

## Conclusion

Hooks are not magic...
```

Output:

```
Chunk 1: "Why Do Hooks Rely on Call Order?" (intro section, no code)
Chunk 2: "How useState Works Internally" (explanation + 80-line code block — kept whole)
Chunk 3: "The Rules of Hooks" (explanation + 40-line code block — kept whole)
Chunk 4: "Conclusion" (summary, no code)
```

**No-headers example** (article with only h1, no h2/h3):

````markdown
# Quick Tip: Bun with Drizzle

Setting up Drizzle ORM with Bun is straightforward.

First, install the dependencies:

```bash
bun add drizzle-orm
bun add -D drizzle-kit
```
````

Then create your schema file. Drizzle uses TypeScript for schema definition — no SQL files needed.

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  name: text('name')
})
```

Finally, run the migration. Drizzle-kit generates SQL from your TypeScript schema automatically.

```

Algorithm: 0 h2 headers → 0 h3 headers → fallback to paragraph breaks. The code fences are preserved, and adjacent short paragraphs are merged.

Output:
```

Chunk 1: "Quick Tip: Bun with Drizzle" (intro + install instructions, ~200 chars)
Chunk 2: "Then create your schema file..." (explanation + 10-line code block, ~500 chars)
Chunk 3: "Finally, run the migration..." (closing paragraph, ~100 chars)

````

Warning printed: "weak chunk boundaries — search quality may vary"

### 5.7 Example: Recursive h2 → h3 Splitting

Input (h2 section exceeds 2500 chars):
```markdown
# Hono Documentation

## Middleware

Hono provides built-in middleware for common tasks including CORS, rate limiting,
logging, compression, authentication, caching, and more. Each middleware is imported
from its own submodule and applied globally or per-route.

### CORS

```ts
import { cors } from 'hono/cors'
const app = new Hono()
app.use('*', cors({ origin: 'https://example.com', allowMethods: ['GET', 'POST'] }))
````

### Rate Limiting

```ts
import { rateLimiter } from 'hono/rate-limiter'
app.use('*', rateLimiter({ windowMs: 60000, max: 100 }))
```

### Logging

```ts
import { logger } from 'hono/logger'
app.use('*', logger())
```

### Compression

```ts
import { compress } from 'hono/compress'
app.use('*', compress())
```

```

Algorithm: Split on `## Middleware` → 2800+ chars → exceeds 2500 target → has `###` children → split on `###`.

Output:
```

Chunk 1: "Hono > Middleware > CORS" (~400 chars)
Chunk 2: "Hono > Middleware > Rate Limiting" (~300 chars)
Chunk 3: "Hono > Middleware > Logging" (~200 chars)
Chunk 4: "Hono > Middleware > Compression" (~200 chars)

````

The h2 intro text ("Hono provides built-in middleware...") is kept before the first h3 chunk so no content is lost.

### 5.8 Example: Small h2 Section (No Further Split)

Input (h2 section under 2500 chars):
```markdown
## Installation

Install Hono via npm:

```bash
npm install hono
````

Or with Bun:

```bash
bun add hono
```

```

Section is ~200 chars, well under 2500. Output:
```

Chunk 1: "Installation" (one chunk, h2 boundary)
content: full section text with code blocks

```

No recursion needed — chunk fits the target size.

---

## 6. Embeddings & Vector Search

### 6.1 Embedding Providers

Same multi-provider abstraction as codeview:

| Provider | Model | Dimensions | Requires | Cost |
|----------|-------|------------|----------|------|
| Ollama | `nomic-embed-text` (default) | 768 | Ollama running locally | Free |
| Ollama | `mxbai-embed-large` | 1024 | Ollama running locally | Free |
| OpenAI | `text-embedding-3-small` | 1536 | API key | ~$0.02/1M tokens |
| Voyage | `voyage-3-lite` | 512 | API key | ~$0.02/1M tokens |

Default: Ollama with `nomic-embed-text`. Recommended for quality + privacy + cost.

### 6.2 Embedding Pipeline

```

For each chunk:

1. Build embedding text: `${chunk.sectionPath}\n${chunk.header}\n\n${chunk.content}`
   Include section path + header in embedding text — improves retrieval relevance
2. Call embedding API → Float32Array
3. Store in SQLite:
   - INSERT chunk → get id
   - INSERT INTO chunk_embeddings_{dim}d (rowid, embedding) VALUES (chunk.id, vec_f32(embedding))

````

**Batch embedding (Ollama):** Send up to 256 texts per request. Reduces HTTP overhead.

**Batch embedding (OpenAI/Voyage):** Send up to 2048 inputs per request.

**Failure:** Retry 3× with exponential backoff (1s, 2s, 4s). After 3 failures, skip chunk and continue. Chunks inserted before embedding — remain searchable via keyword.

### 6.3 SQLite + sqlite-vec Schema

```sql
CREATE TABLE sources (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  fetched_at TEXT,
  content_hash TEXT,
  version TEXT,
  author TEXT,
  published_at TEXT,
  domain TEXT,
  kind TEXT DEFAULT 'unknown',
  chunk_count INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE NOT NULL,              -- SHA256(source + sectionPath)[:16]
  source TEXT NOT NULL REFERENCES sources(name),
  section_path TEXT NOT NULL,
  header TEXT NOT NULL,
  content TEXT NOT NULL,
  has_code_blocks INTEGER DEFAULT 0,
  stale INTEGER DEFAULT 0
);

CREATE INDEX idx_chunks_source ON chunks(source);
CREATE INDEX idx_chunks_section ON chunks(section_path);

-- vec0 virtual table, dimension in table name
CREATE VIRTUAL TABLE chunk_embeddings_{dim}d USING vec0(
  embedding float[{dim}]
);
````

### 6.4 ANN Search

```typescript
function searchChunks(queryEmbedding: Float32Array, topK: number, source?: string) {
  const table = `chunk_embeddings_${queryEmbedding.length}d`

  let sql = `
    SELECT c.id, c.hash, c.source, c.section_path, c.header, c.content,
           c.has_code_blocks, s.title, s.domain, s.kind, s.fetched_at, s.version,
           v.distance
    FROM ${table} v
    JOIN chunks c ON c.id = v.rowid
    JOIN sources s ON c.source = s.name
    WHERE v.embedding MATCH ?
      AND c.stale = 0
  `
  if (source) sql += ` AND c.source = ?`
  sql += ` ORDER BY v.distance LIMIT ?`

  return db
    .prepare(sql)
    .all(new Float32Array(queryEmbedding), ...(source ? [source, topK] : [topK]))
}
```

---

## 7. Hybrid Retrieval

### 7.1 Query Flow

```
User query → "hono cors middleware setup"
  ↓
Embed query text → vector
  ↓
Two parallel paths:
  ┌──────────────────────┐  ┌──────────────────────┐
  │ 1. Semantic (ANN)    │  │ 2. Keyword (FTS5)    │
  │ vec0 MATCH query     │  │ BM25 ranking on      │
  │ Top K × 2            │  │ content/header/path  │
  └────────┬─────────────┘  └──────────┬───────────┘
           │                           │
           └──────────┬────────────────┘
                      ▼
            Reciprocal Rank Fusion
            RRF(score) = Σ 1/(60 + rank_i)
            Merge, re-rank by fusion score
                      │
                      ▼
            Apply source filter (if --source)
            Take top maxChunksPerQuery
                      │
                      ▼
            Format as result set
```

### 7.2 Reciprocal Rank Fusion

```typescript
function rrf(resultsA: ScoredResult[], resultsB: ScoredResult[], k = 60) {
  const scores = new Map<string, number>()
  resultsA.forEach((r, i) => scores.set(r.hash, (scores.get(r.hash) ?? 0) + 1 / (k + i + 1)))
  resultsB.forEach((r, i) => scores.set(r.hash, (scores.get(r.hash) ?? 0) + 1 / (k + i + 1)))
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
}
```

### 7.3 Keyword Search (FTS5 + BM25)

Runs alongside vector search for RRF fusion. Uses SQLite FTS5 full-text search with BM25 statistical ranking:

```sql
SELECT *, bm25(chunks_fts, 1.0, 0.5, 0.25) AS rank
FROM chunks_fts
WHERE chunks_fts MATCH 'cors OR middleware OR configuration'
ORDER BY rank
```

**BM25 formula:** `score = term_frequency × inverse_doc_frequency ÷ document_length`

Column weights (`1.0, 0.5, 0.25`): matches in `content` count fully, `header` at half weight, `section_path` at quarter weight.

FTS5 index kept in sync via triggers on `chunks` table (INSERT/UPDATE/DELETE).

Fast. No embedding needed. Works in degraded mode.

### 7.4 Search Output

````
$ doclab search "hono cors middleware"

Search: "hono cors middleware" (3 results, 42ms)

1. hono.dev — Hono > Middleware > CORS (distance: 0.12, fusion: 0.042) [docs]
   ```ts
   import { cors } from 'hono/cors'
   const app = new Hono()
   app.use('*', cors({
     origin: 'https://example.com',
     allowMethods: ['GET', 'POST'],
   }))
````

hono v4.6.5, fetched 2026-06-08

2. hono.dev — Hono > Middleware > Access Control (distance: 0.18, fusion: 0.028) [docs]
   Access control headers and CORS configuration options for Hono applications.
   hono v4.6.5, fetched 2026-06-08

3. dev.to — CORS in Modern Web Frameworks (distance: 0.22, fusion: 0.019) [article]
   Comparing CORS setup across Hono, Express, and Fastify...
   dev.to, fetched 2026-06-07

```

### 7.5 Source Filtering

```

doclab search "cors" --source hono # only hono docs
doclab search "hooks" --kind article # only blog posts / articles

````

---

## 8. Agent Integration

### 8.1 AGENTS.md Snippet

`doclab init` outputs:

```markdown
## Documentation lookup (doclab)

Before writing code with any framework or library, query doclab for current docs:

```bash
doclab search "<framework> <topic>"
````

This returns documentation snippets with exact code examples from the latest sources.

Tips:

- Include framework name: "hono cors middleware"
- Filter: doclab search "migrations" --source drizzle
- Add sources: doclab add https://docs.example.com/guide
- List sources: doclab list
- Check freshness: doclab status
- Re-fetch: doclab pull

doclab runs on http://127.0.0.1:{port}. Auto-starts on first search.

````

### 8.2 HTTP API

**Base URL:** `http://127.0.0.1:{port}`

**Endpoints:**

| Method | Path | Body/Params | Returns | Description |
|--------|------|-------------|---------|-------------|
| `GET` | `/health` | — | `HealthResponse` | Health check |
| `POST` | `/search` | `SearchRequest` | `SearchResponse` | Hybrid search |
| `GET` | `/sources` | — | `SourceMeta[]` | List sources |
| `POST` | `/add` | `{ url, name? }` | `SourceMeta` | Queue add + fetch + index |
| `POST` | `/remove` | `{ name }` | `{ ok }` | Queue remove source |
| `POST` | `/pull` | `{ name? }` | `{ updated[] }` | Queue re-fetch sources |
| `POST` | `/rebuild` | — | `{ ok }` | Queue full re-index |
| `GET` | `/queue` | — | `QueueStatus` | List queued jobs |
| `GET` | `/log` | — | NDJSON stream | Live worker events |

**Response types:**

```typescript
interface SearchRequest {
  query: string;
  source?: string;
  kind?: "docs" | "article" | "tutorial" | "reference";
  topK?: number;
}

interface SearchResponse {
  results: ChunkResult[];
  degraded: boolean;
  queryTimeMs: number;
}

interface ChunkResult {
  hash: string;
  source: string;
  sectionPath: string;
  header: string;
  content: string;
  hasCodeBlocks: boolean;
  distance?: number;
  fusionScore?: number;
  sourceTitle?: string;
  sourceDomain?: string;
  sourceKind?: string;
  sourceVersion?: string;
  fetchedAt: string;
}

interface HealthResponse {
  status: "ok" | "degraded";
  chunks: number;
  sources: number;
  ollama: "connected" | "unreachable" | "not-configured";
  uptime: number;
}
````

**Error responses:**

All errors follow this format:

```typescript
interface ErrorResponse {
  error: string // Human-readable message
  code: string // Machine-readable error code
  hint?: string // Optional: how to fix
}
```

| Status | Code                | When                                                                  |
| ------ | ------------------- | --------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`       | Missing required field (`"Missing 'query' field"`)                    |
| 400    | `INVALID_SOURCE`    | Source name not found (`"Source 'react' not found"`)                  |
| 400    | `INVALID_URL`       | URL malformed (`"Invalid URL: 'not-a-url'"`)                          |
| 500    | `INTERNAL`          | Unexpected server error (`"Failed to connect to Ollama"`)             |
| 503    | `NOT_READY`         | Server starting up (`"Indexing in progress, retry in a few seconds"`) |

**Example:**

```json
{
  "error": "Source 'nonexistent' not found",
  "code": "INVALID_SOURCE",
  "hint": "List sources: GET /sources"
}
```

**Security:** Server binds to `127.0.0.1` only. No external network access. No authentication required — local machine trust boundary. CORS not needed (same-origin).

### 8.3 Agent Usage Pattern

```
Agent starts task
  │
  ├─ Check: curl http://127.0.0.1:8475/health → running? ollama?
  ├─ If NOT running: doclab start (or auto-starts on search)
  │
  ├─ Identify frameworks needed → doclab list → already have docs?
  ├─ If missing: doclab add https://new-framework.dev/llms-full.txt
  │
  ├─ doclab search "stripe webhook verify signature" → real APIs
  ├─ Reads chunk content + code examples
  ├─ Writes correct code, first try
  │
  └─ (Before deploying) doclab pull → refresh all docs
```

---

## 9. Data Model

### 9.1 SQLite Tables

```sql
CREATE TABLE sources (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  fetched_at TEXT,
  content_hash TEXT,
  version TEXT,
  author TEXT,
  published_at TEXT,
  domain TEXT,
  kind TEXT DEFAULT 'unknown',
  chunk_count INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL REFERENCES sources(name),
  section_path TEXT NOT NULL,
  header TEXT NOT NULL,
  content TEXT NOT NULL,
  has_code_blocks INTEGER DEFAULT 0,
  stale INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_chunks_source ON chunks(source);
CREATE INDEX idx_chunks_section ON chunks(section_path);
CREATE INDEX idx_chunks_stale ON chunks(stale);

CREATE VIRTUAL TABLE chunk_embeddings_{dim}d USING vec0(
  embedding float[{dim}]
);
```

### 9.2 Relationships

```
sources 1 ──── * chunks          (source.name = chunks.source)
chunks  1 ──── 1 embeddings      (chunks.id = vec0 rowid)
```

No edges table. Documentation doesn't have import graphs.

### 9.3 Hash Stability

```typescript
function chunkHash(source: string, sectionPath: string): string {
  return sha256(`${source}:${sectionPath}`).slice(0, 16)
}
```

Stable across rebuilds. Same source + same section path = same hash. Enables:

- Detecting unchanged chunks on re-pull (hash matches → skip)
- Deduplication within same source
- Cache busting on content change (hash changes → delete old, insert new)

### 9.4 Cascade Delete

```
REMOVE source "hono"
  → DELETE FROM chunks WHERE source = 'hono'
  → vec0 rows auto-cascade (rowid gone → embedding gone)
  → SQLite reclaims space on next VACUUM
```

---

## 10. Freshness & Source Lifecycle

### 10.1 Scheduled Rebuilds

Timer-based. Configurable:

```json
{ "rebuildInterval": "24h" }   // default
{ "rebuildInterval": "12h" }
{ "rebuildInterval": "7d" }
{ "rebuildInterval": "never" } // manual only
```

On interval:

1. For each source, fetch URL
2. If 200 + hash changed → re-chunk, re-embed
3. If 200 + unchanged → skip, update `fetched_at`
4. If 404/410 → **remove source** (URL dead → delete chunks, remove from config)
5. If connection error → increment `consecutive_failures`. At 3, remove source.

### 10.2 Source Lifecycle States

```
Added ──────────→ Active ──────────→ Removed
  │                 │
  │                 ├─ Fetch fails 1-2× → Active (consecutive_failures++)
  │                 ├─ Fetch fails 3×   → Removed (URL dead)
  │                 ├─ HTTP 404/410     → Removed (URL gone)
  │                 └─ User removes     → Removed (manual)
  │
  └─ Never fetched (error on add) → Not added, print error
```

### 10.3 Manual Actions

```
doclab pull           # re-fetch all, update changed
doclab pull hono      # re-fetch one
doclab rebuild        # drop everything, re-index from scratch
doclab add <url>      # queue new source (processed in background)
doclab remove <name>  # delete source immediately
```

### 10.4 Staleness Visibility

```
$ doclab list
NAME                    URL                                          CHUNKS  FETCHED
──────────────────────────────────────────────────────────────────────────────────
hono                    https://hono.dev/llms-full.txt                   312  3h ago
drizzle                 https://orm.drizzle.team/llms-full.txt          421  3h ago
better-auth             https://better-auth.dev/llms-full.txt           204  30h ago ⚠

total: 3
```

overreacted-hooks — 8 chunks fetched 3h ago article

```

`⚠` when `fetched_at` exceeds `rebuildInterval`.

---

## 11. Comparison Matrix

### 11.1 vs codeview

| | codeview | doclab |
|---|---|---|
| Domain | Codebase structure | Technical documentation + articles |
| Data source | Local source files (ts-morph AST) | Any URL (markdown + HTML) |
| Server model | Per-project | Global (one per machine) |
| Chunking | AST functions/classes/types | Markdown h2 sections |
| Graph | Import graph + PageRank | No graph |
| Freshness | fs.watch + stale marks | Scheduled rebuilds + fetch diff |
| Config | `<project>/cvconfig.json` | `~/.doclab/dlconfig.json` |
| HTML handling | N/A | HTML → Markdown conversion |
| Generation | N/A | None in v1 |
| Resource | ~400MB | ~350MB |

### 11.2 vs LlamaIndex-based RAG

| | LlamaIndex approach | doclab |
|---|---|---|
| Dependencies | ~20 | 2 (Bun + sqlite-vec) |
| Vector store | JSON files or external DB | SQLite + sqlite-vec |
| Chunking | MarkdownNodeParser (black box) | Custom 100-line splitter |
| Content types | Markdown only | Markdown + HTML (auto-convert) |
| Server model | Per-project | Global |
| Source management | Manual scripts | CLI + config driven |
| Freshness | None | Timestamps + auto-rebuild |
| Embedding providers | Ollama only | Ollama + OpenAI + Voyage |
| Degraded mode | No | Yes (keyword search) |

### 11.3 vs Web Search

| | Web search | doclab |
|---|---|---|
| Latency | ~500ms-2s | ~50ms (vector search) |
| Privacy | Query leaves machine | 100% local |
| Quality | SEO-biased, forum posts | Curated sources, structured |
| Code examples | Buried in blog posts | Exact, in context |
| Offline | No | Yes (cached content) |
| API cost | ~$0.01/query | Free (Ollama) |

---

## 12. File Structure

```

doclab/
├── src/
│ ├── cli.ts # CLI entry (thin HTTP client + lifecycle)
│ ├── server-daemon.ts # Background daemon (Bun.spawn)
│ ├── server.ts # HTTP server (routes, handlers)
│ ├── config.ts # dlconfig.json loading + validation
│ ├── types.ts # Shared TypeScript types
│ ├── db.ts # SQLite setup, migrations, queries
│ └── lib/
│ ├── fetcher.ts # URL fetch + hash diff + format detection
│ ├── html-to-md.ts # HTML → Markdown (turndown + GFM)
│ ├── chunker.ts # Recursive markdown chunking (h2→h3→paragraph, fence-aware)
│ ├── embedder.ts # Multi-provider embedding (ollama, openai, voyage)
│ ├── search.ts # Hybrid search (vector + FTS5/BM25 + RRF)
│ ├── ollama.ts # Ollama API client
│ ├── colors.ts # Semantic ANSI color design tokens
│ └── agent-instructions.ts # AGENTS.md snippet generation
├── test/
│ ├── fixtures/
│ │ ├── basic.md # Simple markdown
│ │ ├── with-code.md # Markdown with multiple code fences
│ │ ├── blog-post.md # Blog-style article
│ │ ├── no-headers.md # Markdown without any headers
│ │ ├── empty-sections.md # Sections under 100 chars
│ │ ├── dense-docs.md # Many h3s under one h2
│ │ └── sample.html # HTML page for conversion test
│ ├── chunker.test.ts
│ ├── html-to-md.test.ts
│ ├── search.test.ts
│ ├── fetcher.test.ts
│ ├── embedder.test.ts
│ ├── server.test.ts
│ ├── ollama.test.ts
│ └── config.test.ts
├── docs/
│ └── DOCLAB_SPEC.md
├── dlconfig.example.json
├── package.json
├── tsconfig.json
├── README.md
└── .gitignore

````

---

## 13. Package & Build Config

### 13.1 package.json

```json
{
  "name": "doclab",
  "version": "1.5.0",
  "description": "Local knowledge server for coding agents — fresh docs and articles on demand via HTTP",
  "type": "module",
  "license": "MIT",
  "bin": { "doclab": "./dist/cli.js" },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "bun build src/cli.ts --outdir dist --target bun && bun build src/server-daemon.ts --outdir dist --target bun",
    "prepublishOnly": "bun run typecheck && bun test && bun run build",
    "prepare": "bun .husky/install.mjs",
    "dev": "bun run --watch src/server.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write ."
  },
  "dependencies": {
    "sqlite-vec": "^0.1",
    "turndown": "^7.2.4",
    "turndown-plugin-gfm": "^1.0.2"
  },
  "devDependencies": {
    "@commitlint/cli": "^21.0.2",
    "@commitlint/config-conventional": "^21.0.2",
    "@types/bun": "latest",
    "husky": "^9.1.7",
    "prettier": "^3.8.4",
    "typescript": "^5.7.0"
  },
  "engines": { "bun": ">=1.1.0" }
}
````

### 13.2 Dependencies

Exactly **3** runtime deps:

| Package                | Why                            |
| ---------------------- | ------------------------------ |
| `sqlite-vec`           | Vector search in SQLite        |
| `turndown`             | HTML → Markdown conversion     |
| `turndown-plugin-gfm`  | GFM tables, strikethrough, etc |

Everything else: Bun built-ins (`Bun.serve`, `bun:sqlite`, `fetch`, `Bun.spawn`, `fs`).

No LlamaIndex. No vector DB server. No heavy ML frameworks.

---

## 14. Testing Strategy

### 14.1 Test Categories

| Category      | Tests | What                                                                                                                                                                                                                          |
| ------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chunker`     | 9     | recursive h2→h3→paragraph splitting, target 2500 chars, code fence preservation, breadcrumb inheritance, min chunk (100), no-headers fallback, dense docs, content hash stability                                              |
| `html-to-md`  | 11    | turndown + GFM: headings, code blocks, inline code, links, lists, emphasis, tables, HTML entities, nav/footer removal, Tab component labels, empty anchor stripping                                                            |
| `search`      | 5     | FTS5 + BM25 keyword search, RRF fusion, tokenization, empty query, short token filtering                                                                                                                                       |
| `fetcher`     | 26    | fetchAndConcat (empty, partial failure, all fail, order-preserving), isLlmsTxtUrl (12 cases), extractRelativeLinks (9 cases), chunkHash, hashContent, FetchError, invalid URL                                                  |
| `server`      | 6     | health endpoint, sources listing, keyword search via SQL, source filter, delete cascade, stale chunk exclusion                                                                                                                 |
| `config`      | 7     | dlconfig.json load, defaults, validation, persistence round-trip, add, update, remove                                                                                                                                          |
| `embedder`    | 7     | Provider create (ollama/openai/voyage), default model, dimension caching, detect unreachable, empty batch                                                                                                                      |
| `ollama`      | 2     | Unreachable port, default URL connectivity                                                                                                                                                                                     |
| **Total**     | **73** | **8 test files**                                                                                                                                                                                                              |

### 14.2 Test Fixtures

```
test/fixtures/
├── basic.md              # Minimal: h1, 2 h2s, plain text
├── with-code.md          # h2s with code fences (ts, json, bash)
├── blog-post.md          # Article: h2s, paragraphs, code blocks
├── no-headers.md         # No markdown headers at all
├── empty-sections.md     # h2s with <100 char content (should be skipped)
├── dense-docs.md         # h2 with 8 h3 sub-sections (test h3 overflow split)
└── sample.html           # Realistic HTML page for conversion test
```

### 14.3 Mock Strategy

- **Ollama API:** Test connectivity via non-existent port. Embedding tests use OpenAI provider for deterministic dimension checks.
- **Fetch:** Test with real `Bun.serve` on random ports for HTTP fetch + concat behavior.
- **sqlite-vec:** In-memory SQLite (`:memory:`) with FTS5. vec0 tested indirectly via daemon integration.
- **Bun.serve:** Real HTTP server for fetcher tests and endpoint logic tests.

---

## 15. Scope (v1)

Everything in this spec ships as v1.0. Single release.

**Daemon & CLI:**

- [x] Single global daemon (Bun.serve), auto-start on any command
- [x] Idempotent startup: detect existing daemon via PID file, clean stale files
- [x] Startup validation: sqlite-vec load, Ollama reachability, config parse
- [x] `~/.doclab/dlconfig.json` config file with validation on startup and `doclab add`
- [x] `doclab add <url> [--name]` / `doclab remove <name>` / `doclab list` source management
- [x] CLI: `start`, `stop`, `status`, `add`, `remove`, `list`, `pull`, `search`, `rebuild`, `init`, `mem`
- [x] Idle auto-shutdown (configurable, default 30m)
- [x] Graceful shutdown: SIGTERM → drain connections → close DB → remove PID/port files
- [x] Crash recovery: stale PID detection on next start
- [x] Port auto-assignment with `~/.doclab/port` file

**Content Pipeline:**

- [x] Fetch any URL, auto-detect format (markdown / HTML) via Content-Type header
- [x] HTML → Markdown conversion using turndown + GFM (replaces custom regex converter + Mozilla Readability)
- [x] Jina AI fallback for Cloudflare-protected pages (Medium, etc.) — auto-proxy, API key optional
- [x] Recursive chunking: h2 → h3 → paragraph breaks, target 2500 chars
- [x] Code fence preservation — never split inside ```
- [x] Min chunk: 100 chars. No max chunk size. Path deduplication for repeated headers.
- [x] Source metadata extraction: title, author, date, domain, kind, version
- [x] Auto-name from `<title>` tag for HTML sources when `--name` not provided

**Embedding & Search:**

- [x] Multi-provider embeddings: Ollama (default), OpenAI, Voyage
- [x] SQLite + sqlite-vec vector store with dimension-encoded table names
- [x] Hybrid search: vector ANN + FTS5/BM25 keyword + RRF fusion
- [x] Source filtering (`--source`) and kind filtering (`--kind`)
- [x] Degraded mode: keyword-only search when no embedding engine available

**Freshness & Lifecycle:**

- [x] Freshness tracking: `fetched_at`, `content_hash`, version detection
- [x] Scheduled auto-rebuild (configurable interval, default 24h) + overdue check on startup (handles daemon idle-shutdown gap)
- [x] Source lifecycle: URL 404/410 → remove; 3 consecutive fetch failures → remove
- [x] Log file: `~/.doclab/logs/daemon.log` with timestamps for crons and lifecycle events

**HTTP API:**

- [x] `GET /health`, `POST /search`, `GET /sources`, `POST /add`, `POST /remove`, `POST /pull`, `POST /rebuild`
- [x] Standard error response format: `{ error, code, hint? }`
- [x] Write lock: 409 Conflict for concurrent write operations
- [x] Bind to `127.0.0.1` only (local trust boundary, no auth needed)
- [x] `doclab init` — AGENTS.md snippet generation

**Testing:**

- [x] 73 tests across 8 test files (chunker, html-to-md, fetcher, search, config, server, embedder, ollama)

---

## Appendix A: Why No LlamaIndex

| Concern           | LlamaIndex                              | doclab                                                       |
| ----------------- | --------------------------------------- | ------------------------------------------------------------ |
| Dependencies      | ~20+                                    | 3 (sqlite-vec, turndown, turndown-plugin-gfm)                |
| Bundle size       | ~5MB+                                   | ~590KB (bundled daemon)                                       |
| API surface       | Giant. Settings, decorators, callbacks. | 5 functions: `fetch`, `htmlToMd`, `chunk`, `embed`, `search` |
| Debugging         | Framework internals                     | Your code. ~600 lines total.                                 |
| Version stability | LlamaIndex TS is young, APIs break      | No framework to break                                        |
| Learning curve    | Read LlamaIndex docs                    | Read 600 lines of TS                                         |
| Customization     | Hope framework supports it              | Edit the code                                                |

doclab crosses the complexity threshold only with sqlite-vec (ANN index, C extension). Everything else is standard library.

---

## Appendix B: Why Global Server

Documents, articles, and tutorials are project-agnostic. Hono's CORS middleware works the same in any project. One index shared by all agents.

|                   | Per-project          | Global              |
| ----------------- | -------------------- | ------------------- |
| Servers           | N                    | 1                   |
| RAM               | N × 350MB            | 350MB               |
| Sources           | Duplicated configs   | Curated once        |
| Freshness         | Some projects stale  | One source of truth |
| Agent integration | Discover per-project | Know one URL        |

---

## Appendix C: Competitive Landscape

### Existing Solutions

Three tools partially overlap with doclab's problem space. None solve it fully.

#### Context7 (Upstash)

**What it does:** Fetches version-specific library documentation and injects it into agent prompts via MCP. Uses `llms.txt` as data source.

**Where it falls short:**
| Gap | Detail |
|-----|--------|
| Cloud-only | Requires API key. Queries leave machine. No offline mode. |
| Library catalog | Curated set of libraries. Can't add arbitrary blog post or article. |
| MCP-only | Only works in MCP-compatible agents (Cursor, Claude, etc.). No HTTP API for custom agents. |
| No freshness control | Cloud-managed. User can't trigger rebuild or see when docs were pulled. |
| Dependency | Service can go down, change pricing, or shut down. |

**Good at:** Library docs for MCP agents. **Not for:** arbitrary URLs, privacy-sensitive work, offline use, custom agent pipelines.

#### mcp-local-rag (shinpr)

**What it does:** Local RAG server via MCP or CLI. Semantic + keyword search over local files. Zero setup.

**Where it falls short:**
| Gap | Detail |
|-----|--------|
| File-based only | Indexes local files (PDF, DOCX, TXT, MD). Must download docs manually first. |
| No URL ingestion | Can't point at a URL and have it fetched automatically. |
| No HTTP daemon | MCP or CLI per-invocation. No persistent server for multiple agents. |
| No source lifecycle | Add files once. No auto-rebuild, no freshness tracking, no dead source cleanup. |
| Per-invocation latency | Cold start on every query. No warm index. |

**Good at:** searching a local docs folder via MCP. **Not for:** dynamic URL-based knowledge base, persistent global daemon, agent-agnostic HTTP API.

#### DevDocs.io (freeCodeCamp)

**What it does:** Offline documentation browser. Combines 100+ API docs in one searchable web UI.

**Where it falls short:**
| Gap | Detail |
|-----|--------|
| Pre-bundled only | Docs curated by maintainers. Can't add your own sources. |
| Human UI, not agent API | Browser-based search. No HTTP endpoint for agents. |
| No embeddings | Keyword search only. No semantic understanding. |
| Manual downloads | User must download doc sets explicitly. No auto-fetch. |
| No embedding | No vector search. No hybrid retrieval. |

**Good at:** human browsing of common API docs offline. **Not for:** agent integration, custom sources, semantic search.

### Comparison Matrix

|                         | Context7           | mcp-local-rag         | DevDocs.io     | doclab                                      |
| ----------------------- | ------------------ | --------------------- | -------------- | ------------------------------------------- |
| **Local/private**       | ❌ Cloud + API key | ✅                    | ✅             | ✅                                          |
| **Any URL**             | ❌ Library catalog | ❌ Local files only   | ❌ Pre-bundled | ✅                                          |
| **HTTP API**            | ❌ MCP only        | ❌ MCP/CLI            | ❌ Web UI      | ✅                                          |
| **Global daemon**       | N/A (cloud)        | ❌ Per-invocation     | ❌ Browser     | ✅                                          |
| **Agent-agnostic**      | ❌ MCP-tied        | ❌ MCP-tied           | ❌ Browser     | ✅                                          |
| **Source lifecycle**    | ❌ No visibility   | ❌ No                 | ❌ Manual      | ✅ Auto-rebuild + cleanup                   |
| **Hybrid search**       | ❌ Semantic only   | ✅ Semantic + keyword | ❌ Keyword     | ✅ Vector + keyword + RRF                   |
| **HTML handling**       | ✅ (curated)       | ❌ File formats       | N/A            | ✅ Auto-convert                             |
| **Embedding providers** | ❌ Cloud           | ✅ Ollama             | ❌ None        | ✅ Ollama + OpenAI + Voyage                 |
| **Degraded mode**       | ❌                 | ❌                    | N/A            | ✅ Keyword fallback                         |
| **Open source**         | ✅ (server closed) | ✅                    | ✅             | ✅                                          |
| **Dependencies**        | Node + 20+         | Node + 20+            | Ruby/Rails     | Bun + 3 (sqlite-vec, turndown, turndown-plugin-gfm) |

### Unique Combination

No existing tool combines all of:

1. **Fetch arbitrary URL** — not just pre-approved libraries or local files
2. **Convert HTML → Markdown** — handle real web pages, not just pre-formatted docs
3. **Chunk semantically** — preserve code fences, respect markdown structure
4. **Embed locally** — zero API calls, fully private
5. **Serve via HTTP** — any agent, any IDE, any script can query
6. **Keep fresh automatically** — scheduled rebuilds, dead URL cleanup
7. **Run as global daemon** — one process, all projects, minimal resources

Each component exists somewhere. The combination doesn't. doclab fills that gap.
