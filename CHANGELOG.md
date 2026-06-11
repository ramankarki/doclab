# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [Unreleased](https://github.com/ramankarki/doclab/compare/v1.3.0...HEAD)

### Features

- **llms.txt expansion** — auto-detect, follow sub-page links, concatenate, chunk
- **fetch retry** — 3 attempts with exponential backoff for transient errors
- **partial failure tolerance** — index successful sub-pages, warn on failures
- **embed resilience** — chunks stored before embedding, survive Ollama failures
- **CLI prompt** — suggests llms-full.txt after adding non-llms.txt sources
- **Tab component** — `<Tab value="hono">` preserved in HTML→markdown conversion

### Performance

- **keyword search** — header match weight boosted 3→10

## [1.3.0](https://github.com/ramankarki/doclab/compare/v1.2.0...v1.3.0) — 2025-06-09

### Features

- `doclab mem` / `doclab memory` command — real-time memory usage
- Auto-rebuild timer + overdue check on startup
- Mozilla Readability for HTML content extraction
- Jina AI fallback for Cloudflare-protected pages
- npm package page support (registry API)
- Bot detection page handling

### Bug Fixes

- Idle timeout edge cases
- Port file cleanup on crash
- Hash deduplication for repeated section headers

## [1.2.0] — Initial Release
