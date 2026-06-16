/**
 * SQLite database setup, migrations, and query helpers.
 *
 * Uses bun:sqlite with sqlite-vec extension for vector search.
 * Cross-platform: macOS (Brew SQLite), Linux, Windows.
 * Tables: sources, chunks, chunk_embeddings_{dim}d (vec0 virtual table)
 */

import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import type { DocChunk, SourceMeta } from './types'
import { getDoclabDir } from './config'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

let _db: Database | null = null
let _vecLoaded = false
let _dimensions: number | null = null

// ── macOS Brew SQLite paths (needed for extension loading) ──

const BREW_SQLITE_ARM = '/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib'
const BREW_SQLITE_X86 = '/usr/local/opt/sqlite3/lib/libsqlite3.dylib'

function detectBrewSqlite(): string | null {
  if (existsSync(BREW_SQLITE_ARM)) return BREW_SQLITE_ARM
  if (existsSync(BREW_SQLITE_X86)) return BREW_SQLITE_X86
  return null
}

// ── Public API ──

export function getDb(): Database {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.')
  return _db
}

export function getDimensions(): number | null {
  return _dimensions
}

export function isVecLoaded(): boolean {
  return _vecLoaded
}

export async function initDb(dimensions?: number): Promise<Database> {
  const doclabDir = getDoclabDir()
  const dbPath = join(doclabDir, 'doclab.db')

  // macOS: use Brew SQLite for extension loading support
  const brewLib = detectBrewSqlite()
  if (brewLib) {
    try {
      Database.setCustomSQLite(brewLib)
    } catch {
      // Silently continue with system SQLite
    }
  }

  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')

  // Load sqlite-vec extension
  try {
    sqliteVec.load(db)
    _vecLoaded = true
  } catch (e: any) {
    console.error(`sqlite-vec load failed: ${e.message}`)
    console.error('Install: bun add sqlite-vec')
    _vecLoaded = false
  }

  // Run migrations
  runMigrations(db)

  // Create vec0 table if dimensions provided
  if (dimensions && _vecLoaded) {
    _dimensions = dimensions
    ensureVecTable(db, dimensions)
  } else if (_vecLoaded) {
    // Try to detect existing vec table
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chunk_embeddings_%'"
      )
      .all() as { name: string }[]

    if (tables.length > 0) {
      const name = tables[0].name
      const match = name.match(/chunk_embeddings_(\d+)d/)
      if (match) {
        _dimensions = parseInt(match[1])
      }
    }
  }

  _db = db
  return db
}

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
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

    CREATE TABLE IF NOT EXISTS chunks (
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

    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
    CREATE INDEX IF NOT EXISTS idx_chunks_section ON chunks(section_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_stale ON chunks(stale);

    /* FTS5 full-text search with BM25 ranking.
       content carries highest weight (the real text), header medium, section_path low. */
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      header,
      section_path,
      content='chunks',
      content_rowid='id'
    );

    /* Triggers to keep FTS5 in sync with chunks table.
       INSERT OR REPLACE on chunks → auto-updates FTS5 index. */
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, header, section_path)
      VALUES (new.id, new.content, new.header, new.section_path);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, header, section_path)
      VALUES ('delete', old.id, old.content, old.header, old.section_path);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, header, section_path)
      VALUES ('delete', old.id, old.content, old.header, old.section_path);
      INSERT INTO chunks_fts(rowid, content, header, section_path)
      VALUES (new.id, new.content, new.header, new.section_path);
    END;
  `)
}

export function ensureVecTable(db: Database, dimensions: number): void {
  const tableName = `chunk_embeddings_${dimensions}d`

  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName)

  if (exists) return

  db.exec(`CREATE VIRTUAL TABLE ${tableName} USING vec0(embedding float[${dimensions}])`)
}

// ── Source queries ──

export function upsertSource(db: Database, meta: SourceMeta): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO sources
      (name, url, title, fetched_at, content_hash, version, author,
       published_at, domain, kind, chunk_count, consecutive_failures)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `
  ).run(
    meta.name,
    meta.url,
    meta.title,
    meta.fetchedAt,
    meta.contentHash,
    meta.version ?? null,
    meta.author ?? null,
    meta.publishedAt ?? null,
    meta.domain,
    meta.kind,
    meta.chunkCount
  )
}

export function getSource(db: Database, name: string): SourceMeta | null {
  const row = db.prepare('SELECT * FROM sources WHERE name = ?').get(name) as any
  if (!row) return null
  return rowToSourceMeta(row)
}

export function listSources(db: Database): SourceMeta[] {
  const rows = db.prepare('SELECT * FROM sources ORDER BY name').all() as any[]
  return rows.map(rowToSourceMeta)
}

export function deleteSource(db: Database, name: string): void {
  db.prepare('DELETE FROM chunks WHERE source = ?').run(name)
  db.prepare('DELETE FROM sources WHERE name = ?').run(name)
}

function rowToSourceMeta(row: any): SourceMeta {
  return {
    name: row.name,
    url: row.url,
    title: row.title ?? '',
    fetchedAt: row.fetched_at ?? '',
    contentHash: row.content_hash ?? '',
    chunkCount: row.chunk_count ?? 0,
    version: row.version ?? undefined,
    author: row.author ?? undefined,
    publishedAt: row.published_at ?? undefined,
    domain: row.domain ?? '',
    kind: row.kind ?? 'unknown'
  }
}

// ── Chunk queries ──

export function insertChunk(
  db: Database,
  chunk: {
    hash: string
    source: string
    sectionPath: string
    header: string
    content: string
    hasCodeBlocks: boolean
  }
): number {
  const result = db
    .prepare(
      `
    INSERT OR REPLACE INTO chunks (hash, source, section_path, header, content, has_code_blocks, stale)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `
    )
    .run(
      chunk.hash,
      chunk.source,
      chunk.sectionPath,
      chunk.header,
      chunk.content,
      chunk.hasCodeBlocks ? 1 : 0
    )
  return Number(result.lastInsertRowid)
}

export function insertEmbedding(
  db: Database,
  rowid: number,
  embedding: Float32Array,
  dimensions: number
): void {
  const tableName = `chunk_embeddings_${dimensions}d`
  // Delete existing embedding for this chunk
  db.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`).run(rowid)
  // Insert using vec_f32 wrapper
  db.prepare(`INSERT INTO ${tableName}(rowid, embedding) VALUES (?, vec_f32(?))`).run(
    rowid,
    embedding
  )
}

/** Batch insert embeddings in a single transaction. Much faster than N individual calls. */
export function insertEmbeddings(
  db: Database,
  rows: Array<{ rowid: number; embedding: Float32Array }>,
  dimensions: number
): void {
  if (rows.length === 0) return

  const tableName = `chunk_embeddings_${dimensions}d`
  const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`)
  const insertStmt = db.prepare(
    `INSERT INTO ${tableName}(rowid, embedding) VALUES (?, vec_f32(?))`
  )

  db.exec('BEGIN')
  try {
    for (const { rowid, embedding } of rows) {
      deleteStmt.run(rowid)
      insertStmt.run(rowid, embedding)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function searchSimilar(
  db: Database,
  queryEmbedding: Float32Array,
  dims: number,
  topK: number,
  source?: string,
  kind?: string
): Array<{
  hash: string
  source: string
  sectionPath: string
  header: string
  content: string
  hasCodeBlocks: boolean
  distance: number
  sourceTitle?: string
  sourceDomain?: string
  sourceKind?: string
  sourceVersion?: string
  fetchedAt: string
}> {
  const tableName = `chunk_embeddings_${dims}d`

  let sql = `
    SELECT c.id, c.hash, c.source, c.section_path, c.header, c.content,
           c.has_code_blocks, s.title, s.domain, s.kind, s.fetched_at, s.version,
           v.distance
    FROM ${tableName} v
    JOIN chunks c ON c.id = v.rowid
    JOIN sources s ON c.source = s.name
    WHERE v.embedding MATCH ?
      AND k = ?
      AND c.stale = 0
  `

  const params: any[] = [queryEmbedding, topK * 2]

  if (source) {
    sql += ` AND c.source = ?`
    params.push(source)
  }
  if (kind) {
    sql += ` AND s.kind = ?`
    params.push(kind)
  }

  const rows = db.prepare(sql).all(...params) as any[]

  return rows.map((r: any) => ({
    hash: r.hash,
    source: r.source,
    sectionPath: r.section_path,
    header: r.header,
    content: r.content,
    hasCodeBlocks: Boolean(r.has_code_blocks),
    distance: r.distance,
    sourceTitle: r.title,
    sourceDomain: r.domain,
    sourceKind: r.kind,
    sourceVersion: r.version,
    fetchedAt: r.fetched_at
  }))
}

export function deleteChunksForSource(db: Database, source: string): void {
  db.prepare('DELETE FROM chunks WHERE source = ?').run(source)
}

export function getChunkCount(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM chunks WHERE stale = 0').get() as any
  return row?.count ?? 0
}

export function getChunkByHash(db: Database, hash: string): DocChunk | null {
  const row = db.prepare('SELECT * FROM chunks WHERE hash = ?').get(hash) as any
  if (!row) return null
  return rowToDocChunk(row)
}

function rowToDocChunk(row: any): DocChunk {
  return {
    id: row.id,
    hash: row.hash,
    source: row.source,
    sectionPath: row.section_path,
    header: row.header,
    content: row.content,
    hasCodeBlocks: Boolean(row.has_code_blocks),
    stale: Boolean(row.stale),
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? ''
  }
}

// ── Rebuild ──

export function dropAllChunks(db: Database, dimensions?: number): void {
  db.exec('DELETE FROM chunks')  /* triggers chunks_ad → cascades to FTS5 */
  if (dimensions) {
    const tableName = `chunk_embeddings_${dimensions}d`
    db.exec(`DELETE FROM ${tableName}`)
  }
  db.exec('UPDATE sources SET chunk_count = 0, fetched_at = NULL, content_hash = NULL')
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
    _vecLoaded = false
  }
}
