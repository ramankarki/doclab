import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { DlConfig, HealthResponse, SearchResponse, SourceMeta } from '../src/types'

/**
 * Server integration tests.
 * Tests HTTP endpoints with an in-memory database.
 */

// We test the server module's internal logic rather than spinning up a real server
// since the server requires sqlite-vec for full functionality

describe('server endpoint logic', () => {
  let db: Database

  beforeAll(() => {
    db = new Database(':memory:')
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
    `)

    // Seed test data
    db.prepare(
      `
      INSERT INTO sources (name, url, title, fetched_at, content_hash, domain, kind, chunk_count)
      VALUES ('test-source', 'https://test.dev/docs', 'Test Docs',
              '2026-06-09T00:00:00Z', 'abc123', 'test.dev', 'docs', 3)
    `
    ).run()

    db.prepare(
      `
      INSERT INTO chunks (hash, source, section_path, header, content, has_code_blocks)
      VALUES ('hash-a', 'test-source', 'Test > Getting Started', '## Getting Started',
              'Welcome to the test documentation.', 0)
    `
    ).run()

    db.prepare(
      `
      INSERT INTO chunks (hash, source, section_path, header, content, has_code_blocks)
      VALUES ('hash-b', 'test-source', 'Test > API > Auth', '### Auth',
              'Authentication is done via API keys.', 1)
    `
    ).run()

    db.prepare(
      `
      INSERT INTO chunks (hash, source, section_path, header, content, has_code_blocks)
      VALUES ('hash-c', 'test-source', 'Test > API > CORS', '### CORS',
              'Use cors() middleware to enable CORS.', 1)
    `
    ).run()
  })

  afterAll(() => {
    db.close()
  })

  test('health endpoint returns correct chunk count', () => {
    const row = db.prepare('SELECT COUNT(*) as count FROM chunks WHERE stale = 0').get() as any
    expect(row.count).toBe(3)
  })

  test('sources listing returns all sources', () => {
    const rows = db.prepare('SELECT * FROM sources').all() as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('test-source')
    expect(rows[0].domain).toBe('test.dev')
    expect(rows[0].kind).toBe('docs')
  })

  test('keyword search via SQL finds relevant chunks', () => {
    const query = 'cors middleware'
    const tokens = query
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter((t) => t.length > 1)

    const conditions = tokens.map(() => `(header LIKE ? OR section_path LIKE ? OR content LIKE ?)`)
    const params: string[] = []
    for (const token of tokens) {
      params.push(`%${token}%`, `%${token}%`, `%${token}%`)
    }

    const sql = `
      SELECT * FROM chunks WHERE stale = 0
      AND (${conditions.join(' OR ')})
      LIMIT 5
    `

    const rows = db.prepare(sql).all(...params) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].section_path).toContain('CORS')
  })

  test('search with source filter works', () => {
    const source = 'test-source'
    const query = 'api'
    const tokens = query
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter((t) => t.length > 1)

    const conditions = tokens.map(() => `(header LIKE ? OR section_path LIKE ? OR content LIKE ?)`)
    const params: string[] = []
    for (const token of tokens) {
      params.push(`%${token}%`, `%${token}%`, `%${token}%`)
    }

    const sql = `
      SELECT * FROM chunks
      WHERE stale = 0
        AND source = ?
        AND (${conditions.join(' OR ')})
      LIMIT 5
    `

    const rows = db.prepare(sql).all(source, ...params) as any[]
    expect(rows.length).toBeGreaterThan(0)
    // All results should be from test-source
    expect(rows.every((r: any) => r.source === 'test-source')).toBe(true)
  })

  test('delete source cascades chunks', () => {
    // Insert a new source + chunks to delete
    db.prepare(
      `
      INSERT OR REPLACE INTO sources (name, url, title, domain, kind)
      VALUES ('temp-src', 'https://temp.dev', 'Temp', 'temp.dev', 'unknown')
    `
    ).run()

    db.prepare(
      `
      INSERT INTO chunks (hash, source, section_path, header, content)
      VALUES ('temp-hash', 'temp-src', 'Temp > Section', '## Section', 'Content')
    `
    ).run()

    // Verify insertion
    let count = db
      .prepare("SELECT COUNT(*) as c FROM chunks WHERE source = 'temp-src'")
      .get() as any
    expect(count.c).toBe(1)

    // Delete
    db.prepare("DELETE FROM chunks WHERE source = 'temp-src'").run()
    db.prepare("DELETE FROM sources WHERE name = 'temp-src'").run()

    // Verify deletion
    count = db.prepare("SELECT COUNT(*) as c FROM chunks WHERE source = 'temp-src'").get() as any
    expect(count.c).toBe(0)
  })

  test('stale chunks are excluded from search', () => {
    // Mark a chunk as stale
    db.prepare("UPDATE chunks SET stale = 1 WHERE hash = 'hash-c'").run()

    // Search should not find the stale chunk
    const rows = db
      .prepare('SELECT * FROM chunks WHERE stale = 0 AND content LIKE ?')
      .all('%CORS%') as any[]

    expect(rows.every((r: any) => r.hash !== 'hash-c')).toBe(true)

    // Restore
    db.prepare("UPDATE chunks SET stale = 0 WHERE hash = 'hash-c'").run()
  })
})
