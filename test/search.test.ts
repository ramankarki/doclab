import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'

/**
 * Search tests — test keyword search and RRF fusion.
 * Vector search requires sqlite-vec which may not be available in test env.
 */

// We test the search logic indirectly by testing keyword search behavior
// and the RRF algorithm through its exported function patterns

describe('search', () => {
  test('keyword tokenization works', () => {
    const query = 'hono cors middleware'
    const tokens = query
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter((t) => t.length > 1)

    expect(tokens).toEqual(['hono', 'cors', 'middleware'])
  })

  test('keyword search finds content via SQLite', () => {
    const db = new Database(':memory:')

    db.exec(`
      CREATE TABLE sources (
        name TEXT PRIMARY KEY,
        url TEXT,
        title TEXT,
        fetched_at TEXT,
        content_hash TEXT,
        domain TEXT,
        kind TEXT DEFAULT 'unknown',
        chunk_count INTEGER DEFAULT 0,
        consecutive_failures INTEGER DEFAULT 0,
        version TEXT,
        author TEXT,
        published_at TEXT
      );

      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT UNIQUE NOT NULL,
        source TEXT NOT NULL,
        section_path TEXT NOT NULL,
        header TEXT NOT NULL,
        content TEXT NOT NULL,
        has_code_blocks INTEGER DEFAULT 0,
        stale INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `)

    // Insert test data
    db.prepare(
      `
      INSERT INTO sources (name, url, title, domain, kind)
      VALUES ('hono', 'https://hono.dev', 'Hono Docs', 'hono.dev', 'docs')
    `
    ).run()

    db.prepare(
      `
      INSERT INTO chunks (hash, source, section_path, header, content)
      VALUES ('hash1', 'hono', 'Hono > Middleware > CORS', '## CORS',
              'Cross-Origin Resource Sharing middleware for Hono. Use cors() to enable CORS.')
    `
    ).run()

    db.prepare(
      `
      INSERT INTO chunks (hash, source, section_path, header, content)
      VALUES ('hash2', 'hono', 'Hono > Middleware > Logger', '## Logger',
              'Request logging middleware for Hono. Use logger() to log requests.')
    `
    ).run()

    // Keyword search
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
      SELECT * FROM chunks
      WHERE stale = 0 AND (${conditions.join(' OR ')})
      LIMIT 5
    `

    const rows = db.prepare(sql).all(...params) as any[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].content).toContain('CORS')
  })

  test('RRF fusion algorithm produces correct scores', () => {
    // Simplified RRF test
    const resultsA = [
      { hash: 'a', rank: 0, score: 0 },
      { hash: 'b', rank: 1, score: 0 },
      { hash: 'c', rank: 2, score: 0 }
    ]
    const resultsB = [
      { hash: 'b', rank: 0, score: 0 },
      { hash: 'd', rank: 1, score: 0 },
      { hash: 'a', rank: 2, score: 0 }
    ]

    const K = 60
    const scores = new Map<string, number>()

    resultsA.forEach((r, i) => {
      scores.set(r.hash, (scores.get(r.hash) ?? 0) + 1 / (K + i + 1))
    })
    resultsB.forEach((r, i) => {
      scores.set(r.hash, (scores.get(r.hash) ?? 0) + 1 / (K + i + 1))
    })

    // 'b' appears in both lists → should have highest score
    const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1])
    expect(sorted[0][0]).toBe('b')
    // 'a' also appears in both
    expect(sorted[1][0]).toBe('a')
  })

  test('empty query returns no results', () => {
    const query = ''
    const tokens = query
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter((t) => t.length > 1)

    expect(tokens.length).toBe(0)
  })

  test('short tokens are filtered', () => {
    const query = 'a b c'
    const tokens = query
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter((t) => t.length > 1)

    expect(tokens.length).toBe(0) // single chars filtered
  })
})
