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

import type { Database } from 'bun:sqlite'
import type {
  DlConfig,
  SearchRequest,
  SearchResponse,
  HealthResponse,
  ErrorResponse,
  SourceMeta,
  ProgressEvent
} from './types'
import { Embedder } from './lib/embedder'
import { hybridSearch } from './lib/search'
import { fetchUrl, FetchError, isLlmsTxtUrl, extractRelativeLinks, fetchAndConcat } from './lib/fetcher'
import { htmlToMarkdown } from './lib/html-to-md'
import { chunkMarkdown } from './lib/chunker'
import { chunkHash } from './lib/fetcher'
import {
  getDb,
  getDimensions,
  upsertSource,
  listSources,
  deleteSource,
  insertChunk,
  insertEmbeddings,
  deleteChunksForSource,
  getChunkCount,
  ensureVecTable,
  dropAllChunks
} from './db'
import { loadConfig, saveConfig, addSourceToConfig, removeSourceFromConfig } from './config'
import { c } from './lib/colors'

export interface ServerState {
  config: DlConfig
  embedder: Embedder | null
  startTime: number
  isWriting: boolean
  indexingInProgress: boolean
  ollamaStatus: 'connected' | 'unreachable' | 'not-configured'
  embeddingModel?: string
  embeddingDims?: number
}

export function createServer(state: ServerState, onRequest?: () => void) {
  const db = getDb()

  const server = Bun.serve({
    port: state.config.port ?? 0,
    hostname: '127.0.0.1',
    idleTimeout: 255, // max allowed — long enough for streaming embed operations
    async fetch(req): Promise<Response> {
      // Notify daemon of activity (resets idle timer)
      if (onRequest) onRequest()

      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      try {
        if (path === '/health' && method === 'GET') {
          return handleHealth(state)
        }

        if (path === '/search' && method === 'POST') {
          return handleSearch(req, state)
        }

        if (path === '/sources' && method === 'GET') {
          return handleListSources()
        }

        if (path === '/add' && method === 'POST') {
          return url.searchParams.has('stream')
            ? handleAddStream(req, state)
            : handleAdd(req, state)
        }

        if (path === '/remove' && method === 'POST') {
          return handleRemove(req, state)
        }

        if (path === '/pull' && method === 'POST') {
          return url.searchParams.has('stream')
            ? handlePullStream(req, state)
            : handlePull(req, state)
        }

        if (path === '/rebuild' && method === 'POST') {
          return url.searchParams.has('stream')
            ? handleRebuildStream(state)
            : handleRebuild(state)
        }

        return json({ error: 'Not found', code: 'NOT_FOUND' }, 404)
      } catch (e: any) {
        console.error(`${c.error}[doclab]${c.reset} Error handling ${method} ${path}:`, e.message)
        return json(
          {
            error: e.message ?? 'Internal server error',
            code: 'INTERNAL'
          },
          500
        )
      }
    }
  })

  return server
}

// ─── Handlers ───

function handleHealth(state: ServerState): Response {
  const uptime = Math.floor((Date.now() - state.startTime) / 1000)
  const status = state.indexingInProgress ? 'indexing' : 'ok'

  const body: HealthResponse = {
    status,
    chunks: getChunkCount(getDb()),
    sources: listSources(getDb()).length,
    ollama: state.ollamaStatus,
    uptime,
    embeddingModel: state.embeddingModel,
    embeddingDims: state.embeddingDims
  }

  return json(body)
}

async function handleSearch(req: Request, state: ServerState): Promise<Response> {
  if (state.indexingInProgress) {
    return json(
      {
        error: 'Indexing in progress, retry in a few seconds',
        code: 'NOT_READY',
        hint: 'Wait for /health to return status: ok'
      },
      503
    )
  }

  let body: SearchRequest
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, 400)
  }

  if (!body.query || body.query.trim() === '') {
    return json({ error: "Missing 'query' field", code: 'BAD_REQUEST' }, 400)
  }

  const topK = body.topK ?? state.config.maxChunksPerQuery
  const db = getDb()
  const dims = getDimensions()

  // Get query embedding if embedder available
  let queryEmbedding: Float32Array | null = null
  if (state.embedder) {
    try {
      const embeddings = await state.embedder.embedBatch([body.query])
      queryEmbedding = embeddings[0]
    } catch (e: any) {
      console.error(`${c.error}[doclab]${c.reset} Embedding failed:`, e.message)
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
  )

  return json(response)
}

function handleListSources(): Response {
  try {
    const sources = listSources(getDb())
    return json(sources)
  } catch {
    return json([])
  }
}

async function handleAdd(req: Request, state: ServerState): Promise<Response> {
  if (state.isWriting) {
    return json(
      {
        error: 'Another operation in progress',
        code: 'WRITE_IN_PROGRESS'
      },
      409
    )
  }

  let body: { url: string; name?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, 400)
  }

  if (!body.url) {
    return json({ error: "Missing 'url' field", code: 'BAD_REQUEST' }, 400)
  }

  state.isWriting = true
  try {
    const result = await addSource(body.url, body.name, state)
    return json(result)
  } catch (e: any) {
    if (e instanceof FetchError) {
      return json(
        {
          error: e.message,
          code: e.code,
          hint: 'Check the URL and try again'
        },
        400
      )
    }
    return json({ error: e.message, code: 'INTERNAL' }, 500)
  } finally {
    state.isWriting = false
  }
}

async function handleRemove(req: Request, state: ServerState): Promise<Response> {
  if (state.isWriting) {
    return json({ error: 'Another operation in progress', code: 'WRITE_IN_PROGRESS' }, 409)
  }

  let body: { name: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, 400)
  }

  if (!body.name) {
    return json({ error: "Missing 'name' field", code: 'BAD_REQUEST' }, 400)
  }

  state.isWriting = true
  try {
    const db = getDb()
    deleteSource(db, body.name)
    removeSourceFromConfig(body.name)
    // Reload config
    const { config } = loadConfig()
    state.config = config
    return json({ ok: true })
  } catch (e: any) {
    return json({ error: e.message, code: 'INTERNAL' }, 500)
  } finally {
    state.isWriting = false
  }
}

async function handlePull(req: Request, state: ServerState): Promise<Response> {
  if (state.isWriting) {
    return json({ error: 'Another operation in progress', code: 'WRITE_IN_PROGRESS' }, 409)
  }

  let body: { name?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  state.isWriting = true
  try {
    const updated = await pullSources(body.name, state)
    return json({ updated })
  } catch (e: any) {
    return json({ error: e.message, code: 'INTERNAL' }, 500)
  } finally {
    state.isWriting = false
  }
}

async function handleRebuild(state: ServerState): Promise<Response> {
  if (state.isWriting) {
    return json({ error: 'Another operation in progress', code: 'WRITE_IN_PROGRESS' }, 409)
  }

  state.isWriting = true
  try {
    const db = getDb()
    const dims = getDimensions()
    dropAllChunks(db, dims ?? undefined)

    // Reload config
    const { config: freshConfig } = loadConfig()
    state.config = freshConfig

    // Re-index all sources
    for (const src of freshConfig.sources) {
      try {
        await addSource(src.url, src.name, state)
      } catch (e: any) {
        console.error(`${c.error}[doclab]${c.reset} Rebuild failed for ${src.name}:`, e.message)
      }
    }

    return json({ ok: true })
  } catch (e: any) {
    return json({ error: e.message, code: 'INTERNAL' }, 500)
  } finally {
    state.isWriting = false
  }
}

// ─── Streaming handlers ───

function streamResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson' }
  })
}

async function handleAddStream(req: Request, state: ServerState): Promise<Response> {
  if (state.isWriting) {
    return json({ error: 'Another operation in progress', code: 'WRITE_IN_PROGRESS' }, 409)
  }

  let body: { url: string; name?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, 400)
  }

  if (!body.url) {
    return json({ error: "Missing 'url' field", code: 'BAD_REQUEST' }, 400)
  }

  state.isWriting = true

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const queue: Uint8Array[] = []
      const emit = (e: ProgressEvent) => queue.push(encoder.encode(JSON.stringify(e) + '\n'))

      const flush = () => {
        while (queue.length > 0) {
          try { controller.enqueue(queue.shift()!) } catch { return }
        }
      }
      const interval = setInterval(flush, 50)

      addSource(body.url, body.name, state, emit)
        .then((result) => {
          emit({ type: 'result', name: result.name, chunkCount: result.chunkCount })
        })
        .catch((e: any) => {
          if (e instanceof FetchError) {
            emit({ type: 'error', message: e.message, code: e.code })
          } else {
            emit({ type: 'error', message: e.message })
          }
        })
        .finally(() => {
          clearInterval(interval)
          flush()
          state.isWriting = false
          try { controller.close() } catch {}
        })
    }
  })

  return streamResponse(stream)
}

async function handlePullStream(req: Request, state: ServerState): Promise<Response> {
  if (state.isWriting) {
    return json({ error: 'Another operation in progress', code: 'WRITE_IN_PROGRESS' }, 409)
  }

  let body: { name?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  state.isWriting = true

  const { config } = loadConfig()
  const sources = body.name
    ? config.sources.filter((s) => s.name === body.name)
    : config.sources

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const queue: Uint8Array[] = []
      const emit = (e: ProgressEvent) => queue.push(encoder.encode(JSON.stringify(e) + '\n'))

      const flush = () => {
        while (queue.length > 0) {
          try { controller.enqueue(queue.shift()!) } catch { return }
        }
      }
      const interval = setInterval(flush, 50)

      emit({ type: 'pull:start', total: sources.length })
      pullSources(body.name, state, emit)
        .then((updated) => {
          emit({ type: 'pull:result', updated })
        })
        .catch((e: any) => {
          emit({ type: 'error', message: e.message })
        })
        .finally(() => {
          clearInterval(interval)
          flush()
          state.isWriting = false
          try { controller.close() } catch {}
        })
    }
  })

  return streamResponse(stream)
}

async function handleRebuildStream(state: ServerState): Promise<Response> {
  if (state.isWriting) {
    return json({ error: 'Another operation in progress', code: 'WRITE_IN_PROGRESS' }, 409)
  }

  state.isWriting = true

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const queue: Uint8Array[] = []
      const emit = (e: ProgressEvent) => queue.push(encoder.encode(JSON.stringify(e) + '\n'))

      const flush = () => {
        while (queue.length > 0) {
          try { controller.enqueue(queue.shift()!) } catch { return }
        }
      }
      const interval = setInterval(flush, 50)

      const db = getDb()
      const dims = getDimensions()

      emit({ type: 'rebuild:drop' })
      dropAllChunks(db, dims ?? undefined)
      emit({ type: 'rebuild:dropped' })

      const { config: freshConfig } = loadConfig()
      state.config = freshConfig
      const sources = freshConfig.sources
      emit({ type: 'rebuild:start', total: sources.length })

      ;(async () => {
        let idx = 0
        for (const src of sources) {
          idx++
          emit({ type: 'source:start', index: idx, total: sources.length, name: src.name })
          try {
            const meta = await addSource(src.url, src.name, state, emit)
            emit({ type: 'source:done', index: idx, total: sources.length, name: src.name, chunkCount: meta.chunkCount })
          } catch (e: any) {
            console.error(`${c.error}[doclab]${c.reset} Rebuild failed for ${src.name}:`, e.message)
            emit({ type: 'source:error', index: idx, total: sources.length, name: src.name, message: e.message })
          }
        }
        emit({ type: 'rebuild:result' })
      })()
        .catch((e: any) => {
          emit({ type: 'error', message: e.message })
        })
        .finally(() => {
          clearInterval(interval)
          flush()
          state.isWriting = false
          try { controller.close() } catch {}
        })
    }
  })

  return streamResponse(stream)
}

// ─── Core operations ───

type ProgressFn = (event: ProgressEvent) => void

async function addSource(
  url: string,
  nameOverride: string | undefined,
  state: ServerState,
  onProgress?: ProgressFn
): Promise<SourceMeta> {
  const db = getDb()

  // Generate name early
  const name = nameOverride ?? generatedName(url, '')

  // Fetch
  onProgress?.({ type: 'fetch:start', name })
  const fetchStart = Date.now()
  const fetched = await fetchUrl(url, state.config.jinaApiKey)
  const fetchMs = Date.now() - fetchStart
  onProgress?.({ type: 'fetch:done', bytes: Buffer.byteLength(fetched.content), durationMs: fetchMs })

  // Final name (may use fetched title)
  const finalName = nameOverride ?? generatedName(url, fetched.meta.title ?? '')

  // Convert HTML to markdown if needed
  let mdContent = fetched.content
  if (fetched.isHtml && !fetched.isMarkdown) {
    onProgress?.({ type: 'convert:start' })
    mdContent = htmlToMarkdown(fetched.content)
    onProgress?.({ type: 'convert:done' })
  }

  // Expand llms.txt TOC: extract sub-page links, fetch & concatenate
  if (isLlmsTxtUrl(url)) {
    const links = extractRelativeLinks(fetched.content, url)
    if (links.length === 0) {
      throw new FetchError(
        `No documentation links found in llms.txt for ${finalName}. Nothing to index.`,
        'LLMS_TXT_NO_LINKS',
        0
      )
    }
    onProgress?.({ type: 'llms-expand:start', count: links.length })
    try {
      const { content: expanded, failed: failedCount } = await fetchAndConcat(links, state.config.jinaApiKey, 5, (e) => {
        onProgress?.(e)
      })
      onProgress?.({ type: 'llms-expand:done', failed: failedCount })
      mdContent = expanded
      fetched.meta.isLlmsTxt = true
    } catch (e: any) {
      throw new FetchError(
        `Failed to index ${finalName}: ${e.message}`,
        'LLMS_TXT_EXPAND_FAILED',
        0
      )
    }
  }

  // Chunk
  onProgress?.({ type: 'chunk:start' })
  const chunks = chunkMarkdown(mdContent, finalName)
  onProgress?.({ type: 'chunk:done', count: chunks.length })

  // Build metadata
  const now = new Date().toISOString()
  const meta: SourceMeta = {
    name: finalName,
    url,
    title: fetched.meta.title ?? finalName,
    fetchedAt: now,
    contentHash: fetched.hash,
    chunkCount: chunks.length,
    version: fetched.meta.version,
    author: fetched.meta.author,
    publishedAt: fetched.meta.publishedAt,
    domain: fetched.meta.domain ?? new URL(url).hostname,
    kind: fetched.meta.kind ?? 'unknown',
    isLlmsTxt: fetched.meta.isLlmsTxt
  }

  // Delete existing chunks for this source
  deleteChunksForSource(db, finalName)

  // Insert source
  upsertSource(db, meta)

  // Add to config
  addSourceToConfig({ name: finalName, url })
  const { config } = loadConfig()
  state.config = config

  // Start embedding in parallel with DB writes — they don't depend on each other.
  // Embedding is the bottleneck (~110s), DB writes (~5s) overlap completely.
  let embedPromise: Promise<Float32Array[]> | null = null
  let embedDims = 0

  if (state.embedder && chunks.length > 0) {
    embedDims = await state.embedder.getDimensions()
    ensureVecTable(db, embedDims)
    state.embeddingDims = embedDims

    const embedTexts = chunks.map((c) => `${c.sectionPath}\n${c.header}\n\n${c.content}`)

    onProgress?.({ type: 'embed:start', total: chunks.length })
    const embedStart = Date.now()

    // Fire embedding request — don't await. Ollama runs while DB writes happen.
    embedPromise = state.embedder.embedBatch(embedTexts, (done, total) => {
      onProgress?.({ type: 'embed:progress', done, total })
    }).then((embs) => {
      onProgress?.({ type: 'embed:done', durationMs: Date.now() - embedStart })
      return embs
    })
  }

  // Insert chunks while embedding runs
  if (chunks.length > 0) {
    db.exec('BEGIN')
    try {
      for (const c of chunks) {
        const hash = chunkHash(finalName, c.sectionPath)
        insertChunk(db, {
          hash,
          source: finalName,
          sectionPath: c.sectionPath,
          header: c.header,
          content: c.content,
          hasCodeBlocks: c.hasCodeBlocks
        })
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  // Wait for embedding to finish, then store vectors
  if (embedPromise) {
    try {
      const embeddings = await embedPromise

      // Build hash→rowid map in one query
      const hashRows = db
        .prepare('SELECT id, hash FROM chunks WHERE source = ?')
        .all(finalName) as { id: number; hash: string }[]
      const hashToRowid = new Map(hashRows.map((r) => [r.hash, r.id]))

      const embedRows: Array<{ rowid: number; embedding: Float32Array }> = []
      for (let i = 0; i < chunks.length; i++) {
        if (embeddings[i]) {
          const hash = chunkHash(finalName, chunks[i].sectionPath)
          const rowid = hashToRowid.get(hash)
          if (rowid != null) {
            embedRows.push({ rowid, embedding: embeddings[i] })
          }
        }
      }

      if (embedRows.length > 0) {
        insertEmbeddings(db, embedRows, embedDims)
      }
    } catch (e: any) {
      console.error(
        `[doclab] Embedding failed for ${finalName}: ${e.message}. Chunks searchable via keyword only.`
      )
    }
  }

  return meta
}

async function pullSources(
  nameFilter: string | undefined,
  state: ServerState,
  onProgress?: ProgressFn
): Promise<string[]> {
  const { config } = loadConfig()
  state.config = config

  const sources = nameFilter ? config.sources.filter((s) => s.name === nameFilter) : config.sources

  const updated: string[] = []
  let index = 0

  for (const src of sources) {
    index++
    try {
      const db = getDb()
      const existing = db
        .prepare('SELECT content_hash FROM sources WHERE name = ?')
        .get(src.name) as any

      const fetched = await fetchUrl(src.url, state.config.jinaApiKey)

      if (existing && existing.content_hash === fetched.hash) {
        // Unchanged — update fetched_at
        db.prepare('UPDATE sources SET fetched_at = ? WHERE name = ?').run(
          new Date().toISOString(),
          src.name
        )
        onProgress?.({ type: 'source:skip', index, total: sources.length, name: src.name })
        continue
      }

      // Changed — re-index
      onProgress?.({ type: 'source:start', index, total: sources.length, name: src.name })
      try {
        const meta = await addSource(src.url, src.name, state, onProgress)
        updated.push(src.name)
        onProgress?.({ type: 'source:done', index, total: sources.length, name: src.name, chunkCount: meta.chunkCount })
      } catch (e: any) {
        onProgress?.({ type: 'source:error', index, total: sources.length, name: src.name, message: e.message })
      }
    } catch (e: any) {
      if (e instanceof FetchError && e.status === 404) {
        console.log(`${c.warn}[doclab]${c.reset} ${src.name}: URL returned 404. Source removed.`)
        const db = getDb()
        deleteSource(db, src.name)
        removeSourceFromConfig(src.name)
        onProgress?.({ type: 'source:error', index, total: sources.length, name: src.name, message: 'URL returned 404 — source removed' })
      } else {
        const db = getDb()
        const row = db
          .prepare('SELECT consecutive_failures FROM sources WHERE name = ?')
          .get(src.name) as any
        const failures = (row?.consecutive_failures ?? 0) + 1

        if (failures >= 3) {
          console.log(
            `${c.warn}[doclab]${c.reset} ${src.name}: unreachable ${failures} times. Source removed.`
          )
          deleteSource(db, src.name)
          removeSourceFromConfig(src.name)
        } else {
          db.prepare('UPDATE sources SET consecutive_failures = ? WHERE name = ?').run(
            failures,
            src.name
          )
          console.log(
            `${c.warn}[doclab]${c.reset} ${src.name}: fetch failed (${failures}/3). Retrying next cycle.`
          )
        }
        onProgress?.({ type: 'source:error', index, total: sources.length, name: src.name, message: e.message })
      }
    }
  }

  const { config: freshConfig } = loadConfig()
  state.config = freshConfig
  return updated
}

// ─── Helpers ───

function generatedName(url: string, title: string): string {
  try {
    const u = new URL(url)

    // For llms-full.txt URLs, use subdomain or path segment
    if (url.includes('llms-full.txt') || url.includes('llms.txt')) {
      // Extract meaningful part: hono.dev → hono
      const hostParts = u.hostname.split('.')
      if (hostParts.length >= 2 && hostParts[hostParts.length - 2] !== 'www') {
        return hostParts[hostParts.length - 2]
      }
      return hostParts[0]
    }

    // For blog posts, use slug from path
    const pathParts = u.pathname.split('/').filter(Boolean)
    if (pathParts.length > 0) {
      const last = pathParts[pathParts.length - 1]
        .replace(/\.[^.]+$/, '') // remove extension
        .replace(/[^a-zA-Z0-9-]/g, '-') // sanitize
        .replace(/-+/g, '-') // collapse dashes
        .replace(/^-|-$/g, '') // trim dashes
        .slice(0, 50)

      if (last.length > 2) return last
    }

    // Fallback: domain-based
    return u.hostname.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9-]/g, '-')
  } catch {
    return 'source'
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
