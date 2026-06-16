# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [1.8.1](https://github.com/ramankarki/doclab/compare/doclab-v1.8.0...doclab-v1.8.1) (2026-06-16)


### Documentation

* add table of contents and tech stack section to README ([08f85b4](https://github.com/ramankarki/doclab/commit/08f85b4387c7c21a7fcca24dcc34c3a783adb566))

## [1.8.0](https://github.com/ramankarki/doclab/compare/doclab-v1.7.0...doclab-v1.8.0) (2026-06-16)


### Features

* add -v/--version flag to print version from package.json ([b322018](https://github.com/ramankarki/doclab/commit/b322018f33318ec2e755c5279eacd59ec8860299))

## [1.7.0](https://github.com/ramankarki/doclab/compare/doclab-v1.6.0...doclab-v1.7.0) (2026-06-16)


### Features

* **queue:** pub/sub queue system, /log stream, detach add, vec cascade fix ([ffbb083](https://github.com/ramankarki/doclab/commit/ffbb0830a9a007613ac3218666f014804443e4c7))


### Performance

* **add:** parallel embed with DB writes, batch inserts, transactions ([d7c7887](https://github.com/ramankarki/doclab/commit/d7c78872ed2e6f6a49b82d26c337c37f6d2ff4d6))


### Documentation

* update README and spec for queue system, log command, detach add ([94d2f6f](https://github.com/ramankarki/doclab/commit/94d2f6fc2a547c7cba1ca9db8d96e4c028582d1c))

## [1.6.0](https://github.com/ramankarki/doclab/compare/doclab-v1.5.0...doclab-v1.6.0) (2026-06-15)


### Features

* **cli:** streaming progress for add/pull/rebuild with crash recovery ([717bfd2](https://github.com/ramankarki/doclab/commit/717bfd2a1089202f998b816eeec4914d65b0aa8a))


### Bug Fixes

* clean expansion message, remove duplicate daemon-start log ([7e7aa9b](https://github.com/ramankarki/doclab/commit/7e7aa9bda54ca9cd00cfeb02dae61e37fe468a63))
* eliminate ReadableStream crash from async start + await ([aa3b3e4](https://github.com/ramankarki/doclab/commit/aa3b3e488d6a5839428185368793eceef74c92d6))
* indent stderr fetch progress to match CLI output ([a0540a3](https://github.com/ramankarki/doclab/commit/a0540a3ae0a30bf8e42ca27a9e7cf6b1e0ffc5ff))
* single-line fetch progress during llms.txt expansion ([8e7968d](https://github.com/ramankarki/doclab/commit/8e7968da128b0263890236dc1f880ca3643ce729))
* stream sub-page fetch progress instead of stderr ([5ae3372](https://github.com/ramankarki/doclab/commit/5ae33724076df91de65c4efcb0bf343dc292c56a))
* truncate subfetch progress lines, clear on completion ([f215d20](https://github.com/ramankarki/doclab/commit/f215d203f7eec360e04bd90a83c91657ba7575ad))


### Performance

* unify progress renderers, add embed progress, fix dead code ([489e2e6](https://github.com/ramankarki/doclab/commit/489e2e67998b1502be32b0524fcbe45fc20ff3f8))


### Documentation

* sync documentation with current codebase ([762dc1c](https://github.com/ramankarki/doclab/commit/762dc1c92dc9f4a0427be8182b10e6e983da05c2))

## [1.5.0](https://github.com/ramankarki/doclab/compare/doclab-v1.4.4...doclab-v1.5.0) (2026-06-15)


### Features

* auto-detect SPA pages and retry with Jina AI ([e158ab2](https://github.com/ramankarki/doclab/commit/e158ab2328006891606d6e780fbeda87de2b31b0))
* replace Readability + regex HTML-to-MD with turndown + GFM ([39fcbb6](https://github.com/ramankarki/doclab/commit/39fcbb666fd4ecf2267d779750734fafa5b647c7))
* simplify chunker, add FTS5 search, improve embeddings ([8e83463](https://github.com/ramankarki/doclab/commit/8e834630f2a0dacbbc28deb0cac03f98306139b3))


### Bug Fixes

* code fence splitting in chunker paragraph fallback ([a9c3c0b](https://github.com/ramankarki/doclab/commit/a9c3c0b614e6a100bc2917aa327e8f1f9e2afa89))
* empty headers inherit parent heading, clean trailing paths ([7f50c21](https://github.com/ramankarki/doclab/commit/7f50c21c1e389c00f49f923d075d9a485989ff39))
* strip empty anchor links, improve chunk merge granularity ([259f31b](https://github.com/ramankarki/doclab/commit/259f31bfd01b567f079dd4bc713c38ff24431bf3))


### Documentation

* update AGENTS.md with HOW_IT_WORKS reference and correct test command ([efecaaf](https://github.com/ramankarki/doclab/commit/efecaaf9a26377d372864258e82dc5761f0dd00c))
* update architecture and HOW_IT_WORKS for new pipeline ([17d72d5](https://github.com/ramankarki/doclab/commit/17d72d55634bf780b6edd726f0ab94a1fe6b7bc4))
* update architecture docs, changelog, and create AGENTS.md ([550c5ce](https://github.com/ramankarki/doclab/commit/550c5ce6d9d9cba0d218bd879aeb996630472b1a))
* use bun src/cli.ts directly (Bun runs TS natively) ([c600332](https://github.com/ramankarki/doclab/commit/c6003327ed349a3ee7f04e1a22a311738a44c90d))

## [Unreleased]

### Features

* replace Mozilla Readability + custom regex HTML-to-MD with turndown + GFM
* auto-detect SPA pages and retry with Jina AI for JavaScript rendering

### Bug Fixes

* fix code fence splitting in chunker paragraph fallback (position tracking drift)
* fix empty headers inheriting parent heading names, clean trailing paths
* strip empty anchor links (`[](#...)` noise from ReSpec self-links)
* improve chunk merge granularity (greedy pack up to 90% target size)

## [1.4.4](https://github.com/ramankarki/doclab/compare/doclab-v1.4.3...doclab-v1.4.4) (2026-06-13)


### Bug Fixes

* skip re-prompt for already-added llms-full.txt ([3f30dd7](https://github.com/ramankarki/doclab/commit/3f30dd70e10aa94ec28e1672b873c336ec364470))

## [1.4.3](https://github.com/ramankarki/doclab/compare/doclab-v1.4.2...doclab-v1.4.3) (2026-06-11)


### Bug Fixes

* npm publish ([f3baeb7](https://github.com/ramankarki/doclab/commit/f3baeb70820f4e9c8e217a8cfa2f4e2f0a8b05ae))

## [1.4.2](https://github.com/ramankarki/doclab/compare/doclab-v1.4.1...doclab-v1.4.2) (2026-06-11)


### Bug Fixes

* publish npm with bun ([14ed9c4](https://github.com/ramankarki/doclab/commit/14ed9c4123fe75ec185d99639f4f08ea40726777))

## [1.4.1](https://github.com/ramankarki/doclab/compare/doclab-v1.4.0...doclab-v1.4.1) (2026-06-11)


### Bug Fixes

* npm publish github workflow ([71355ad](https://github.com/ramankarki/doclab/commit/71355ad24ce598f1934967f0e367625a5df2758c))


### Documentation

* add contribution section in readme ([e063ac5](https://github.com/ramankarki/doclab/commit/e063ac584feb2e9eb541a8c7f322f409c36bf5b4))

## [1.4.0](https://github.com/ramankarki/doclab/compare/doclab-v1.3.1...doclab-v1.4.0) (2026-06-11)


### Features

* add mem/memory command for real-time memory usage ([0d2448d](https://github.com/ramankarki/doclab/commit/0d2448d372c28c12292082ff3b3ce48b0c11ab2a))
* **cli:** color design system, table output, URL validation, npm support ([23b2f4c](https://github.com/ramankarki/doclab/commit/23b2f4ce358ee71afba431a470e3de3a2db7cdb1))
* **cli:** suggest llms-full.txt/llms.txt after successful add ([eeed2fc](https://github.com/ramankarki/doclab/commit/eeed2fcdee8047d527f26a1b4482e1464d67a4dd))
* **fetcher:** add extractRelativeLinks for llms.txt TOC link extraction ([9e049a0](https://github.com/ramankarki/doclab/commit/9e049a0da474456de4647902ba84bf4ea709dd90))
* **fetcher:** add fetchAndConcat for batch llms.txt sub-page fetching ([d1a8dde](https://github.com/ramankarki/doclab/commit/d1a8dde91e47c4f1c2961dba5e9a7452c3119cbf))
* **fetcher:** add isLlmsTxtUrl detection + SourceMeta.isLlmsTxt type ([9f2fca2](https://github.com/ramankarki/doclab/commit/9f2fca2b47be64f164f61f3f27e7278fa54bd4c9))
* **html-to-md:** preserve &lt;Tab&gt; component labels before tag stripping ([53d23ad](https://github.com/ramankarki/doclab/commit/53d23adfe00c5342f77dca42fbb77e25b3252866))
* llms.txt expansion, retry, embed resilience + docs ([e3d0136](https://github.com/ramankarki/doclab/commit/e3d013679b524c732fbfc767998fdf6413c45c29))
* make AGENTS.md snippet mandatory and comprehensive ([913f818](https://github.com/ramankarki/doclab/commit/913f818e1c4aae472c91f6ccc49a106a1632d6d9))
* **server:** auto-expand llms.txt TOC links in addSource() ([8cafbf8](https://github.com/ramankarki/doclab/commit/8cafbf8f5cde81ba0b3eb5a1180d8aaf41dfdd83))


### Performance

* **search:** boost header keyword match weight 3→10 ([a3649e1](https://github.com/ramankarki/doclab/commit/a3649e19b1855b6e9a63980dfc63c63ed9e90406))


### Documentation

* document mem command in README and spec ([ec29b7e](https://github.com/ramankarki/doclab/commit/ec29b7ec3119bd003140fe60b420507efcdb26ff))
* remove duplicate mem command row in README table ([58347b9](https://github.com/ramankarki/doclab/commit/58347b9eafa062b53af192663be386410c5c46d4))

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
