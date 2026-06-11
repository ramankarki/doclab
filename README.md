# doclab — Local Knowledge Server for Coding Agents

[![CI](https://github.com/ramankarki/doclab/actions/workflows/ci.yml/badge.svg)](https://github.com/ramankarki/doclab/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/doclab)](https://www.npmjs.com/package/doclab)
[![license](https://img.shields.io/npm/l/doclab)](https://github.com/ramankarki/doclab/blob/main/LICENSE)

Agents write stale code because their training data is old. **doclab** gives them fresh documentation, articles, and technical references on demand — local, private, fast. Any URL: framework docs, blog posts, tutorials, API references, migration guides.

## Quick Start

```bash
bun add -g doclab
doclab start

# Add docs via llms.txt (auto-expands to full documentation)
doclab add https://better-auth.com/llms.txt
doclab add https://hono.dev/llms-full.txt

# Or any URL — blog posts, guides, API references
doclab add https://orm.drizzle.team/llms-full.txt

doclab search "hono cors middleware setup"
```

**llms.txt vs llms-full.txt:** doclab automatically detects llms.txt (table of contents) files and expands them — it follows every linked sub-page, fetches them all, concatenates into one document, then chunks. You get the full documentation, not just a link list. No special flags needed.

No Ollama? No problem — keyword search works without it. Install Ollama for hybrid vector + keyword search.

## Requirements

- **Bun** ≥ 1.1.0
- **Ollama** (optional, for vector search): `brew install ollama && ollama pull nomic-embed-text`
- **macOS**: Homebrew SQLite recommended for sqlite-vec (`brew install sqlite3` — auto-detected)
- **Linux**: Works out of the box (Bun SQLite supports extension loading)
- **Windows**: Works out of the box

## Why doclab?

|                    | Web Search        | Context7           | DevDocs.io     | doclab                      |
| ------------------ | ----------------- | ------------------ | -------------- | --------------------------- |
| **Local/private**  | ❌                | ❌ Cloud + key     | ✅             | ✅                          |
| **Any URL**        | ✅                | ❌ Library catalog | ❌ Pre-bundled | ✅                          |
| **HTTP API**       | ❌                | ❌ MCP only        | ❌ Web UI      | ✅                          |
| **Global daemon**  | N/A               | N/A                | ❌ Browser     | ✅                          |
| **Agent-agnostic** | ❌                | ❌ MCP-tied        | ❌ Browser     | ✅                          |
| **Hybrid search**  | Keyword only      | Semantic only      | Keyword only   | ✅ Vector + keyword + RRF   |
| **Auto-freshness** | ✅ Real-time      | ❌ Cloud-managed   | ❌ Manual      | ✅ Auto-rebuild + cleanup   |
| **HTML handling**  | ✅                | ✅ (curated)       | N/A            | ✅ Auto-convert to markdown |
| **Offline**        | ❌                | ❌                 | ✅             | ✅                          |
| **Cost**           | Free (SEO-biased) | Free tier          | Free           | Free (Ollama)               |

doclab combines all of these — local, private, any URL, hybrid search, auto-updating — into a single background daemon that any coding agent can query via HTTP.

## How It Works

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

## Architecture

```
┌──────────┐     HTTP      ┌─────────────────────────────────────────┐
│  Agent   │──────────────▶│  doclab daemon (one per machine)        │
│ (Pi/Clau│               │                                         │
│ de/Cline)│               │  Fetch → Readability → HTML→MD → Chunk │
└──────────┘               │         ↓                               │
                           │  Embed (Ollama/OpenAI/Voyage) → SQLite  │
                           │         ↓                               │
                           │  Hybrid Search (vector + keyword + RRF) │
                           └─────────────────────────────────────────┘
```

- **Single global daemon** — one server, all projects, all agents
- **Fetch pipeline** — direct fetch → Mozilla Readability (content extraction) → custom HTML→MD converter → recursive chunker
- **Retry with backoff** — 3 attempts (1s, 2s) on transient fetch errors, Jina AI fallback after retries exhausted
- **Semantic chunking** — splits on h2→h3→h4 headers, preserves code fences, targets ~2500 chars
- **Hybrid search** — vector ANN + keyword token overlap + Reciprocal Rank Fusion
- **SQLite + sqlite-vec** — zero infrastructure, WAL mode, concurrent reads
- **Auto-rebuild** — configurable timer (default 24h) re-fetches sources, removes dead URLs

## Commands

| Command                         | Description                                                      |
| ------------------------------- | ---------------------------------------------------------------- |
| `doclab start`                  | Start background daemon (idempotent, auto-starts on any command) |
| `doclab stop`                   | Stop daemon                                                      |
| `doclab status`                 | Daemon health, chunk count, Ollama status, uptime                |
| `doclab mem \| memory`          | Real-time memory usage (RSS, heap, DB, logs, vector index)       |
| `doclab add <url> [--name <n>]` | Fetch → extract content → chunk → embed → index                  |
| `doclab remove <name>`          | Delete source and all chunks                                     |
| `doclab list`                   | All sources with chunk counts and freshness                      |
| `doclab pull [name]`            | Re-fetch all or one source, update changed content               |
| `doclab search <query> [...]`   | Hybrid search (vector + keyword + RRF fusion)                    |
| `doclab rebuild`                | Drop DB, re-index all sources from scratch                       |
| `doclab init`                   | Generate AGENTS.md snippet for your agent's system prompt        |

The daemon auto-shuts down after 30 minutes idle. It auto-starts on the next command.

### Search Options

```
doclab search "cors middleware" --source hono     # Filter by source
doclab search "hooks pattern" --kind article      # Filter by kind (docs/article/tutorial/reference)
doclab search "drizzle schema" --topK 10          # Return more results
```

## Config

`~/.doclab/dlconfig.json`:

```json
{
  "sources": [
    { "name": "hono", "url": "https://hono.dev/llms-full.txt" },
    { "name": "drizzle", "url": "https://orm.drizzle.team/llms-full.txt" },
    { "name": "react-patterns", "url": "https://overreacted.io/why-do-hooks-rely-on-call-order/" }
  ],
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "ollamaUrl": "http://localhost:11434"
  },
  "rebuildInterval": "24h",
  "maxChunksPerQuery": 5,
  "idleTimeout": "30m",
  "jinaApiKey": ""
}
```

| Field                | Default    | Description                                                                   |
| -------------------- | ---------- | ----------------------------------------------------------------------------- |
| `embedding.provider` | `"ollama"` | `ollama` / `openai` / `voyage`                                                |
| `embedding.model`    | auto       | Model override per provider                                                   |
| `embedding.apiKey`   | —          | API key. Supports `$ENV_VAR` syntax                                           |
| `rebuildInterval`    | `"24h"`    | `"12h"`, `"7d"`, `"never"`                                                    |
| `maxChunksPerQuery`  | `5`        | Top K results per search                                                      |
| `idleTimeout`        | `"30m"`    | Auto-shutdown timeout. `"never"` to disable                                   |
| `jinaApiKey`         | `""`       | Optional Jina AI API key for higher rate limits on Cloudflare-protected pages |

## Sources — Any URL

doclab accepts any URL with technical content:

| Type             | Example                                          | Format   |
| ---------------- | ------------------------------------------------ | -------- |
| Package docs     | `hono.dev/llms-full.txt`                         | Markdown |
| Framework guides | `nextjs.org/docs/app/building-your-application`  | HTML     |
| Blog posts       | `overreacted.io/why-do-hooks-rely-on-call-order` | HTML     |
| Tutorials        | `dev.to/...`, `freecodecamp.org/...`             | HTML     |
| API references   | `stripe.com/docs/api`                            | HTML     |
| Migration guides | `react.dev/blog/...`                             | HTML     |
| GitHub READMEs   | `github.com/user/repo#readme`                    | Markdown |

HTML pages are automatically converted to clean markdown. First through Mozilla's Readability (content extraction — strips nav, ads, sidebars), then through a custom markdown converter that preserves code fences, headings, and links.

If a page is Cloudflare-protected (Medium, some docs sites), doclab automatically falls back to Jina AI's reader proxy which returns clean markdown directly.

## Best Practices

### Choosing between llms.txt and llms-full.txt

| Format | Behavior | Use when |
|--------|----------|----------|
| `llms-full.txt` | Single file, chunked directly | Available. Preferred — faster, single fetch. |
| `llms.txt` | TOC → auto-follows all sub-pages → concatenates → chunks | `llms-full.txt` not available. Works identically after expansion. |
| Any URL | Fetched, HTML converted to markdown, chunked | Blog posts, guides, API references. |

**After adding an llms.txt source**, doclab prompts if `llms-full.txt` exists at the same domain — you can add it too for faster re-indexing.

### Writing effective search queries

```bash
# Include the framework/library name — narrows results
doclab search "hono cors middleware setup"

# Use --source filter when you know which docs to target
doclab search "drizzle adapter" --source better-auth
doclab search "accordion" --source shadcn

# Use --kind filter to exclude articles when looking for API docs
doclab search "hooks pattern" --kind docs

# Increase result count for broad searches
doclab search "deployment" --topK 10
```

### Source management

```bash
# Check freshness — stale sources show ⚠
doclab list

# Re-fetch all sources (pull changed content)
doclab pull

# Rebuild everything from scratch (if chunks seem wrong)
doclab rebuild

# Remove dead sources
doclab remove <name>
```

### Agent workflow

1. **Before coding:** `doclab search "<topic>"` — verify APIs exist
2. **Missing docs:** `doclab add <url>` — index new sources on the fly
3. **Stale docs:** `doclab pull` — refresh before deploying
4. **Source filter:** `--source <name>` — when cross-source overlap hides results

## Agent Integration

`doclab init` outputs an AGENTS.md snippet. Append it to your agent's system prompt, and your agent can query doclab before writing code:

```bash
doclab search "<framework> <topic>"
doclab search "migrations" --source drizzle
doclab list
doclab status
```

The daemon runs on `http://127.0.0.1:{port}` (bind to localhost only). No authentication needed — local machine trust boundary.

## HTTP API

| Method | Path       | Body                               | Description           |
| ------ | ---------- | ---------------------------------- | --------------------- |
| `GET`  | `/health`  | —                                  | Health check + status |
| `POST` | `/search`  | `{ query, source?, kind?, topK? }` | Hybrid search         |
| `GET`  | `/sources` | —                                  | List all sources      |
| `POST` | `/add`     | `{ url, name? }`                   | Add + fetch + index   |
| `POST` | `/remove`  | `{ name }`                         | Remove source         |
| `POST` | `/pull`    | `{ name? }`                        | Re-fetch sources      |
| `POST` | `/rebuild` | —                                  | Full re-index         |

## Resource Profile

| Component                   | RAM         |
| --------------------------- | ----------- |
| `nomic-embed-text` (Ollama) | ~270 MB     |
| Bun runtime                 | ~30 MB      |
| SQLite + vec0 index         | ~50 MB      |
| **Total**                   | **~350 MB** |

## Logs

Daemon logs are written to `~/.doclab/logs/daemon.log`:

```
[2026-06-09T11:00:00.000Z] Ollama: connected (nomic-embed-text, 768d)
[2026-06-09T11:00:00.100Z] sqlite-vec: loaded
[2026-06-09T11:00:00.200Z] Ready on http://127.0.0.1:8475
[2026-06-09T11:00:00.300Z] Auto-rebuild: every 24h
[2026-06-10T11:00:00.400Z] [doclab] Auto-rebuild: checking 5 sources...
[2026-06-10T11:00:45.500Z] [doclab] Auto-rebuild: updated hono
[2026-06-10T11:30:00.600Z] [doclab] Idle timeout (30m). Shutting down.
```

## Degraded Mode

If no embedding engine is reachable:

- `search` falls back to keyword-only (case-insensitive substring + token overlap)
- Response includes `degraded: true`
- Server prints hint: `Install ollama: brew install ollama && ollama pull nomic-embed-text`

Search still works — just without semantic understanding.

## Development

```bash
bun install
bun prepare
bun run build
bun test              # 73 tests (commitlint + husky enforced)
bun run typecheck
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). Enforced via `commitlint` hook on commit + CI check on push. Format: `feat:`, `fix:`, `perf:`, `docs:`, `chore:`.

## Contributing

Conventional Commits required. Pre-commit hook runs `bun test`.

```bash
git checkout -b feat/my-feature
# code... (pre-commit runs bun test)
git commit -m "feat: add my feature"
git push → open PR → CI runs (typecheck + test + build + commitlint)
```

## License

MIT
