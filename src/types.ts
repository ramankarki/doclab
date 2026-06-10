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
  maxChunksPerQuery: 5,
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

export interface FenceSpan {
  start: number
  end: number
}
