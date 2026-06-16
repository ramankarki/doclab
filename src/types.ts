// ─── Config types ───

export type EmbeddingProvider = 'ollama' | 'openai' | 'voyage'

export interface EmbeddingConfig {
  provider: EmbeddingProvider
  model?: string
  ollamaUrl?: string
  apiKey?: string
  dimensions?: number
}

export interface SourceConfig {
  name: string
  url: string
}

export interface DlConfig {
  sources: SourceConfig[]
  embedding: EmbeddingConfig
  rebuildInterval: string
  maxChunksPerQuery: number
  idleTimeout: string
  port?: number
  jinaApiKey?: string
}

export const DEFAULT_CONFIG: DlConfig = {
  sources: [],
  embedding: {
    provider: 'ollama',
    model: 'nomic-embed-text',
    ollamaUrl: 'http://localhost:11434'
  },
  rebuildInterval: '24h',
  maxChunksPerQuery: 10,
  idleTimeout: '30m',
  jinaApiKey: undefined
}

// ─── Source metadata ───

export type SourceKind = 'docs' | 'article' | 'tutorial' | 'reference' | 'unknown'

export interface SourceMeta {
  name: string
  url: string
  title: string
  fetchedAt: string
  contentHash: string
  chunkCount: number
  version?: string
  author?: string
  publishedAt?: string
  domain: string
  kind: SourceKind
  isLlmsTxt?: boolean
}

// ─── Chunk types ───

export interface DocChunk {
  id: number
  hash: string
  source: string
  sectionPath: string
  header: string
  content: string
  hasCodeBlocks: boolean
  stale: boolean
  createdAt: string
  updatedAt: string
}

// ─── Search types ───

export interface SearchRequest {
  query: string
  source?: string
  kind?: SourceKind
  topK?: number
}

export interface ScoredResult {
  hash: string
  source: string
  sectionPath: string
  header: string
  content: string
  hasCodeBlocks: boolean
  distance?: number
  fusionScore?: number
  sourceTitle?: string
  sourceDomain?: string
  sourceKind?: string
  sourceVersion?: string
  fetchedAt: string
  rank: number
}

export interface SearchResponse {
  results: ScoredResult[]
  degraded: boolean
  queryTimeMs: number
}

// ─── HTTP API types ───

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'indexing'
  chunks: number
  sources: number
  ollama: 'connected' | 'unreachable' | 'not-configured'
  uptime: number
  embeddingModel?: string
  embeddingDims?: number
}

export interface ErrorResponse {
  error: string
  code: string
  hint?: string
}

export interface AddSourceRequest {
  url: string
  name?: string
}

export interface RemoveSourceRequest {
  name: string
}

export interface PullRequest {
  name?: string
}

// ─── Chunking types ───

export interface RawChunk {
  header: string
  sectionPath: string
  content: string
  hasCodeBlocks: boolean
}

// ─── Streaming progress events ───

export type ProgressEvent =
  | { type: 'fetch:start'; name: string }
  | { type: 'fetch:done'; bytes: number; durationMs: number }
  | { type: 'convert:start' }
  | { type: 'convert:done' }
  | { type: 'chunk:start' }
  | { type: 'chunk:done'; count: number }
  | { type: 'embed:start'; total: number }
  | { type: 'embed:progress'; done: number; total: number }
  | { type: 'embed:done'; durationMs: number }
  | { type: 'result'; name: string; chunkCount: number }
  | { type: 'error'; message: string; code?: string }
  | { type: 'source:start'; index: number; total: number; name: string }
  | { type: 'source:skip'; index: number; total: number; name: string }
  | { type: 'source:done'; index: number; total: number; name: string; chunkCount: number }
  | { type: 'source:error'; index: number; total: number; name: string; message: string }
  | { type: 'pull:start'; total: number }
  | { type: 'pull:result'; updated: string[] }
  | { type: 'rebuild:start'; total: number }
  | { type: 'rebuild:drop' }
  | { type: 'rebuild:dropped' }
  | { type: 'rebuild:result' }
  | { type: 'llms-expand:start'; count: number }
  | { type: 'llms-expand:done'; failed: number }
  | { type: 'subfetch:progress'; index: number; total: number; file: string }
  | { type: 'queue:wait'; position: number }
