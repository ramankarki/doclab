/**
 * HTTP server — routes and handlers for doclab daemon.
 *
 * Routes:
 *  GET  /health   — health check + status
 *  POST /search   — hybrid search
 *  GET  /sources  — list all sources
 *  POST /add      — add + fetch + index source
 *  POST /remove   — remove source
 *  POST /pull     — re-fetch sources
 *  POST /rebuild  — full re-index
 */

import type { Database } from "bun:sqlite";
import type {
  DlConfig,
  SearchRequest,
  SearchResponse,
  HealthResponse,
  ErrorResponse,
  SourceMeta,
} from "./types";
import { Embedder } from "./lib/embedder";
import { hybridSearch } from "./lib/search";
import { fetchUrl, FetchError } from "./lib/fetcher";
import { htmlToMarkdown } from "./lib/html-to-md";
import { extractContent } from "./lib/readability-extract";
import { chunkMarkdown } from "./lib/chunker";
import { chunkHash } from "./lib/fetcher";
import {
  getDb,
  getDimensions,
  upsertSource,
  listSources,
  deleteSource,
  insertChunk,
  insertEmbedding,
  deleteChunksForSource,
  getChunkCount,
  ensureVecTable,
  dropAllChunks,
} from "./db";
import {
  loadConfig,
  saveConfig,
  addSourceToConfig,
  removeSourceFromConfig,
} from "./config";

export interface ServerState {
  config: DlConfig;
  embedder: Embedder | null;
  startTime: number;
  isWriting: boolean;
  indexingInProgress: boolean;
  ollamaStatus: "connected" | "unreachable" | "not-configured";
  embeddingModel?: string;
  embeddingDims?: number;
}

export function createServer(
  state: ServerState,
  onRequest?: () => void
) {
  const db = getDb();

  const server = Bun.serve({
    port: state.config.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      // Notify daemon of activity (resets idle timer)
      if (onRequest) onRequest();

      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      try {
        if (path === "/health" && method === "GET") {
          return handleHealth(state);
        }

        if (path === "/search" && method === "POST") {
          return handleSearch(req, state);
        }

        if (path === "/sources" && method === "GET") {
          return handleListSources();
        }

        if (path === "/add" && method === "POST") {
          return handleAdd(req, state);
        }

        if (path === "/remove" && method === "POST") {
          return handleRemove(req, state);
        }

        if (path === "/pull" && method === "POST") {
          return handlePull(req, state);
        }

        if (path === "/rebuild" && method === "POST") {
          return handleRebuild(state);
        }

        return json(
          { error: "Not found", code: "NOT_FOUND" },
          404
        );
      } catch (e: any) {
        console.error(`[doclab] Error handling ${method} ${path}:`, e.message);
        return json(
          {
            error: e.message ?? "Internal server error",
            code: "INTERNAL",
          },
          500
        );
      }
    },
  });

  return server;
}

// ─── Handlers ───

function handleHealth(state: ServerState): Response {
  const uptime = Math.floor((Date.now() - state.startTime) / 1000);
  const status = state.indexingInProgress ? "indexing" : "ok";

  const body: HealthResponse = {
    status,
    chunks: getChunkCount(getDb()),
    sources: listSources(getDb()).length,
    ollama: state.ollamaStatus,
    uptime,
    embeddingModel: state.embeddingModel,
    embeddingDims: state.embeddingDims,
  };

  return json(body);
}

async function handleSearch(
  req: Request,
  state: ServerState
): Promise<Response> {
  if (state.indexingInProgress) {
    return json(
      {
        error: "Indexing in progress, retry in a few seconds",
        code: "NOT_READY",
        hint: "Wait for /health to return status: ok",
      },
      503
    );
  }

  let body: SearchRequest;
  try {
    body = await req.json();
  } catch {
    return json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      400
    );
  }

  if (!body.query || body.query.trim() === "") {
    return json(
      { error: "Missing 'query' field", code: "BAD_REQUEST" },
      400
    );
  }

  const topK = body.topK ?? state.config.maxChunksPerQuery;
  const db = getDb();
  const dims = getDimensions();

  // Get query embedding if embedder available
  let queryEmbedding: Float32Array | null = null;
  if (state.embedder) {
    try {
      const embeddings = await state.embedder.embedBatch([body.query]);
      queryEmbedding = embeddings[0];
    } catch (e: any) {
      console.error("[doclab] Embedding failed:", e.message);
      // Degraded mode — keyword only
    }
  }

  const response: SearchResponse = hybridSearch(
    db,
    queryEmbedding,
    body.query,
    topK,
    dims ?? undefined,
    body.source,
    body.kind
  );

  return json(response);
}

function handleListSources(): Response {
  try {
    const sources = listSources(getDb());
    return json(sources);
  } catch {
    return json([]);
  }
}

async function handleAdd(
  req: Request,
  state: ServerState
): Promise<Response> {
  if (state.isWriting) {
    return json(
      {
        error: "Another operation in progress",
        code: "WRITE_IN_PROGRESS",
      },
      409
    );
  }

  let body: { url: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      400
    );
  }

  if (!body.url) {
    return json(
      { error: "Missing 'url' field", code: "BAD_REQUEST" },
      400
    );
  }

  state.isWriting = true;
  try {
    const result = await addSource(body.url, body.name, state);
    return json(result);
  } catch (e: any) {
    if (e instanceof FetchError) {
      return json(
        {
          error: e.message,
          code: e.code,
          hint: "Check the URL and try again",
        },
        400
      );
    }
    return json(
      { error: e.message, code: "INTERNAL" },
      500
    );
  } finally {
    state.isWriting = false;
  }
}

async function handleRemove(
  req: Request,
  state: ServerState
): Promise<Response> {
  if (state.isWriting) {
    return json(
      { error: "Another operation in progress", code: "WRITE_IN_PROGRESS" },
      409
    );
  }

  let body: { name: string };
  try {
    body = await req.json();
  } catch {
    return json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      400
    );
  }

  if (!body.name) {
    return json(
      { error: "Missing 'name' field", code: "BAD_REQUEST" },
      400
    );
  }

  state.isWriting = true;
  try {
    const db = getDb();
    deleteSource(db, body.name);
    removeSourceFromConfig(body.name);
    // Reload config
    const { config } = loadConfig();
    state.config = config;
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: e.message, code: "INTERNAL" }, 500);
  } finally {
    state.isWriting = false;
  }
}

async function handlePull(
  req: Request,
  state: ServerState
): Promise<Response> {
  if (state.isWriting) {
    return json(
      { error: "Another operation in progress", code: "WRITE_IN_PROGRESS" },
      409
    );
  }

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  state.isWriting = true;
  try {
    const updated = await pullSources(body.name, state);
    return json({ updated });
  } catch (e: any) {
    return json({ error: e.message, code: "INTERNAL" }, 500);
  } finally {
    state.isWriting = false;
  }
}

async function handleRebuild(state: ServerState): Promise<Response> {
  if (state.isWriting) {
    return json(
      { error: "Another operation in progress", code: "WRITE_IN_PROGRESS" },
      409
    );
  }

  state.isWriting = true;
  try {
    const db = getDb();
    const dims = getDimensions();
    dropAllChunks(db, dims ?? undefined);

    // Reload config
    const { config: freshConfig } = loadConfig();
    state.config = freshConfig;

    // Re-index all sources
    for (const src of freshConfig.sources) {
      try {
        await addSource(src.url, src.name, state);
      } catch (e: any) {
        console.error(`[doclab] Rebuild failed for ${src.name}:`, e.message);
      }
    }

    return json({ ok: true });
  } catch (e: any) {
    return json({ error: e.message, code: "INTERNAL" }, 500);
  } finally {
    state.isWriting = false;
  }
}

// ─── Core operations ───

async function addSource(
  url: string,
  nameOverride: string | undefined,
  state: ServerState
): Promise<SourceMeta> {
  const db = getDb();

  // Fetch
  const fetched = await fetchUrl(url, state.config.jinaApiKey);

  // Convert HTML to markdown if needed
  let mdContent = fetched.content;
  if (fetched.isHtml && !fetched.isMarkdown) {
    // Extract main content first (strips nav/ads/boilerplate)
    const cleanedHtml = extractContent(fetched.content);
    mdContent = htmlToMarkdown(cleanedHtml);
  }

  // Generate name
  const name =
    nameOverride ??
    generatedName(url, fetched.meta.title ?? "");

  // Chunk
  const chunks = chunkMarkdown(mdContent, name);

  // Build metadata
  const now = new Date().toISOString();
  const meta: SourceMeta = {
    name,
    url,
    title: fetched.meta.title ?? name,
    fetchedAt: now,
    contentHash: fetched.hash,
    chunkCount: chunks.length,
    version: fetched.meta.version,
    author: fetched.meta.author,
    publishedAt: fetched.meta.publishedAt,
    domain: fetched.meta.domain ?? new URL(url).hostname,
    kind: fetched.meta.kind ?? "unknown",
  };

  // Delete existing chunks for this source
  deleteChunksForSource(db, name);

  // Insert source
  upsertSource(db, meta);

  // Add to config
  addSourceToConfig({ name, url });
  const { config } = loadConfig();
  state.config = config;

  // Insert chunks + embed
  if (state.embedder && chunks.length > 0) {
    try {
      const dims = await state.embedder.getDimensions();
      ensureVecTable(db, dims);
      state.embeddingDims = dims;

      // Build embedding texts: header + content
      const embedTexts = chunks.map(
        (c) => `${c.header}\n\n${c.content}`
      );

      const embeddings = await state.embedder!.embedBatch(embedTexts);

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const hash = chunkHash(name, c.sectionPath);
        const rowid = insertChunk(db, {
          hash,
          source: name,
          sectionPath: c.sectionPath,
          header: c.header,
          content: c.content,
          hasCodeBlocks: c.hasCodeBlocks,
        });

        if (embeddings[i]) {
          insertEmbedding(db, rowid, embeddings[i], dims);
        }
      }
    } catch (e: any) {
      console.error(
        `[doclab] Embedding failed for ${name}: ${e.message}. Chunks stored without embeddings.`
      );
    }
  } else if (chunks.length > 0) {
    // No embedder — store chunks only (keyword search works)
    for (const c of chunks) {
      const hash = chunkHash(name, c.sectionPath);
      insertChunk(db, {
        hash,
        source: name,
        sectionPath: c.sectionPath,
        header: c.header,
        content: c.content,
        hasCodeBlocks: c.hasCodeBlocks,
      });
    }
  }

  return meta;
}

async function pullSources(
  nameFilter: string | undefined,
  state: ServerState
): Promise<string[]> {
  const { config } = loadConfig();
  state.config = config;

  const sources = nameFilter
    ? config.sources.filter((s) => s.name === nameFilter)
    : config.sources;

  const updated: string[] = [];

  for (const src of sources) {
    try {
      const db = getDb();
      const existing = db
        .prepare("SELECT content_hash FROM sources WHERE name = ?")
        .get(src.name) as any;

      const fetched = await fetchUrl(src.url, state.config.jinaApiKey);

      if (existing && existing.content_hash === fetched.hash) {
        // Unchanged — update fetched_at
        db.prepare(
          "UPDATE sources SET fetched_at = ? WHERE name = ?"
        ).run(new Date().toISOString(), src.name);
        continue;
      }

      // Changed — re-index
      await addSource(src.url, src.name, state);
      updated.push(src.name);
    } catch (e: any) {
      if (e instanceof FetchError && e.status === 404) {
        // Dead URL — remove
        console.log(`[doclab] ⚠ ${src.name}: URL returned 404. Source removed.`);
        const db = getDb();
        deleteSource(db, src.name);
        removeSourceFromConfig(src.name);
      } else {
        // Connection error — increment failures
        const db = getDb();
        const row = db
          .prepare(
            "SELECT consecutive_failures FROM sources WHERE name = ?"
          )
          .get(src.name) as any;
        const failures = (row?.consecutive_failures ?? 0) + 1;

        if (failures >= 3) {
          console.log(
            `[doclab] ⚠ ${src.name}: unreachable ${failures} times. Source removed.`
          );
          deleteSource(db, src.name);
          removeSourceFromConfig(src.name);
        } else {
          db.prepare(
            "UPDATE sources SET consecutive_failures = ? WHERE name = ?"
          ).run(failures, src.name);
          console.log(
            `[doclab] ⚠ ${src.name}: fetch failed (${failures}/3). Retrying next cycle.`
          );
        }
      }
    }
  }

  const { config: freshConfig } = loadConfig();
  state.config = freshConfig;
  return updated;
}

// ─── Helpers ───

function generatedName(url: string, title: string): string {
  try {
    const u = new URL(url);

    // For llms-full.txt URLs, use subdomain or path segment
    if (url.includes("llms-full.txt") || url.includes("llms.txt")) {
      // Extract meaningful part: hono.dev → hono
      const hostParts = u.hostname.split(".");
      if (hostParts.length >= 2 && hostParts[hostParts.length - 2] !== "www") {
        return hostParts[hostParts.length - 2];
      }
      return hostParts[0];
    }

    // For blog posts, use slug from path
    const pathParts = u.pathname.split("/").filter(Boolean);
    if (pathParts.length > 0) {
      const last = pathParts[pathParts.length - 1]
        .replace(/\.[^.]+$/, "") // remove extension
        .replace(/[^a-zA-Z0-9-]/g, "-") // sanitize
        .replace(/-+/g, "-") // collapse dashes
        .replace(/^-|-$/g, "") // trim dashes
        .slice(0, 50);

      if (last.length > 2) return last;
    }

    // Fallback: domain-based
    return u.hostname.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-]/g, "-");
  } catch {
    return "source";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
