# AGENTS.md — doclab Development Guide

## Project

Local knowledge server for coding agents. Fetches any URL, converts HTML to markdown, semantically chunks, embeds, indexes in SQLite, and serves via hybrid search (vector + keyword + RRF).

## Architecture

```
fetchUrl → turndown + GFM (HTML→MD) → chunkMarkdown (h2→h3→h4, fence-safe) → embed → SQLite + sqlite-vec
                                                                                        ↓
                                                                              hybridSearch (vector + FTS5/BM25 + RRF)
```

## Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP server, add/search/remove/pull/rebuild handlers |
| `src/server-daemon.ts` | Background daemon lifecycle, idle timer, auto-rebuild |
| `src/cli.ts` | CLI entry (thin HTTP client + daemon lifecycle) |
| `src/db.ts` | SQLite schema, vec0 setup, FTS5 triggers, CRUD operations |
| `src/config.ts` | dlconfig.json load/save, source management |
| `src/lib/fetcher.ts` | Fetch URL (direct + Jina fallback), SPA detection, npm registry |
| `src/lib/html-to-md.ts` | HTML→Markdown via turndown + GFM + custom Tab rule |
| `src/lib/chunker.ts` | Recursive markdown chunking on headers, paragraph fallback |
| `src/lib/search.ts` | Hybrid search: vector ANN + FTS5/BM25 + RRF fusion |
| `src/lib/embedder.ts` | Ollama/OpenAI/Voyage embedding abstraction |
| `src/lib/ollama.ts` | Ollama API client (health check, batch embed) |
| `src/lib/colors.ts` | Semantic ANSI color design tokens (zero dependencies) |
| `src/lib/agent-instructions.ts` | AGENTS.md snippet generation (`doclab init`) |

## Commands

```bash
bun test              # 73 tests, 0 fail target
bun run typecheck     # tsc --noEmit
bun run build         # Bundle CLI + daemon to dist/
bun run format        # Prettier format
bun run src/cli.ts    # Run local CLI (not global doclab)
```

## Rules

- **Test before commit.** pre-commit hook runs `bun test`.
- **Conventional Commits.** `feat:`, `fix:`, `perf:`, `docs:`, `chore:`.
- **Surgical changes.** Touch only what the task requires. Don't refactor adjacent code.
- **Read docs first.** `docs/HOW_IT_WORKS.md` for beginners. `docs/DOCLAB_SPEC.md` for full design. `README.md` for user-facing docs.
- **Test local daemon.** Always test with `bun run src/cli.ts`, not global `doclab`. Bun runs TS directly.
