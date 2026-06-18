/**
 * Hybrid Search: Vector ANN + Keyword token overlap + RRF fusion
 */

import type { ScoredResult, SearchResponse, SourceKind } from '../types'
import type { Database } from 'bun:sqlite'
import { searchSimilar, isVecLoaded } from '../db'

const RRF_K = 60
const VECTOR_WEIGHT = 0.6
const KEYWORD_WEIGHT = 0.4
const MUTUAL_BOOST = 1.3

export function hybridSearch(
  db: Database,
  queryEmbedding: Float32Array | null,
  query: string,
  topK: number,
  dims: number | undefined,
  source?: string,
  kind?: SourceKind
): SearchResponse {
  const start = performance.now()

  const vecResults: ScoredResult[] = []
  const kwResults: ScoredResult[] = []

  // ── Vector search ──
  if (queryEmbedding && dims && isVecLoaded()) {
    try {
      const rows = searchSimilar(db, queryEmbedding, dims, topK, source, kind)
      vecResults.push(
        ...rows.map((r, i) => ({
          hash: r.hash,
          source: r.source,
          sectionPath: r.sectionPath,
          header: r.header,
          content: r.content,
          hasCodeBlocks: r.hasCodeBlocks,
          distance: r.distance,
          sourceTitle: r.sourceTitle,
          sourceDomain: r.sourceDomain,
          sourceKind: r.sourceKind,
          sourceVersion: r.sourceVersion,
          fetchedAt: r.fetchedAt,
          rank: i
        }))
      )
    } catch (e: any) {
      console.error('[doclab] Vector search failed:', e.message)
      // vec0 search failed — fall through to keyword only
    }
  }

  // ── Keyword search ──
  try {
    const kwResults_raw = keywordSearch(db, query, topK * 2, source, kind)
    kwResults.push(...kwResults_raw.map((r, i) => ({ ...r, rank: i })))
  } catch {
    // Keyword should not fail
  }

  // ── RRF Fusion ──
  let merged: ScoredResult[]
  const degraded = vecResults.length === 0

  if (vecResults.length > 0 && kwResults.length > 0) {
    merged = rrfFusion(vecResults, kwResults)
  } else if (vecResults.length > 0) {
    merged = vecResults.map((r) => ({
      ...r,
      fusionScore: 1 / (RRF_K + r.rank + 1)
    }))
  } else {
    merged = kwResults.map((r) => ({
      ...r,
      fusionScore: 1 / (RRF_K + r.rank + 1)
    }))
  }

  // Sort by fusion score descending, take top K
  merged.sort((a, b) => (b.fusionScore ?? 0) - (a.fusionScore ?? 0))
  const results = merged.slice(0, topK)

  const end = performance.now()

  return {
    results,
    degraded,
    queryTimeMs: Math.round(end - start)
  }
}

// ── Keyword Search ──

function keywordSearch(
  db: Database,
  query: string,
  limit: number,
  source?: string,
  kind?: string
): ScoredResult[] {
  // Tokenize and escape for FTS5 query syntax (special chars: -, ", *, (, ))
  const tokens = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // strip punctuation (FTS5 tokenizer handles it anyway)
    .split(/\s+/)
    .filter((t) => t.length > 1)

  if (tokens.length === 0) return []

  // Build FTS5 MATCH query: tokens joined by OR
  const matchQuery = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')

  // BM25: content weight=1.0, header=0.5, section_path=0.25
  let sql = `
    SELECT c.hash, c.source, c.section_path, c.header, c.content,
           c.has_code_blocks, s.title, s.domain, s.kind, s.fetched_at, s.version,
           bm25(chunks_fts, 1.0, 0.5, 0.25) AS rank
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.rowid
    JOIN sources s ON c.source = s.name
    WHERE chunks_fts MATCH ?
      AND c.stale = 0
  `

  const params: any[] = [matchQuery]

  if (source) {
    sql += ` AND c.source = ?`
    params.push(source)
  }
  if (kind) {
    sql += ` AND s.kind = ?`
    params.push(kind)
  }

  sql += ` ORDER BY rank LIMIT ?`
  params.push(limit)

  const rows = db.prepare(sql).all(...params) as any[]

  // Convert BM25 rank to distance-like score for RRF fusion.
  // Lower BM25 = better. Invert so fusion works naturally.
  const scores = rows.map((r: any) => ({
    hash: r.hash,
    source: r.source,
    sectionPath: r.section_path,
    header: r.header,
    content: r.content,
    hasCodeBlocks: Boolean(r.has_code_blocks),
    distance: 1 / (1 + Math.abs(r.rank)),  // BM25 rank → distance (lower = better)
    sourceTitle: r.title,
    sourceDomain: r.domain,
    sourceKind: r.kind,
    sourceVersion: r.version,
    fetchedAt: r.fetched_at,
    rank: 0
  }))

  return scores.map((r, i) => ({ ...r, rank: i }))
}

// ── Reciprocal Rank Fusion ──
// Weighted: vector contributes more than keyword (semantic > token overlap).
// Mutual confirmation: chunks found by both methods boosted 1.3x.

function rrfFusion(resultsA: ScoredResult[], resultsB: ScoredResult[]): ScoredResult[] {
  const scores = new Map<string, { result: ScoredResult; score: number; confirmedBy: Set<'vec' | 'kw'> }>()

  // Vector results (weight 0.6)
  for (let i = 0; i < resultsA.length; i++) {
    const r = resultsA[i]
    const key = r.hash
    const existing = scores.get(key)
    const contribution = VECTOR_WEIGHT / (RRF_K + i + 1)
    const score = (existing?.score ?? 0) + contribution
    const confirmedBy = existing?.confirmedBy ?? new Set()
    confirmedBy.add('vec')
    scores.set(key, { result: r, score, confirmedBy })
  }

  // Keyword results (weight 0.4)
  for (let i = 0; i < resultsB.length; i++) {
    const r = resultsB[i]
    const key = r.hash
    const existing = scores.get(key)
    const contribution = KEYWORD_WEIGHT / (RRF_K + i + 1)
    const score = (existing?.score ?? 0) + contribution
    const confirmedBy = existing?.confirmedBy ?? new Set()
    confirmedBy.add('kw')
    scores.set(key, {
      result: existing?.result ?? r,
      score,
      confirmedBy
    })
  }

  return Array.from(scores.values())
    .map((entry) => {
      let score = entry.score

      // Penalize chunks where vector found them but with poor semantic distance.
      // High vector distance (>0.5) means the keyword token overlap is coincidental
      // (e.g., "HEAD Request Best Practices" matching "project structure best practices").
      const fromVec = entry.confirmedBy.has('vec')
      const vecDist = entry.result.distance
      if (fromVec && vecDist != null && vecDist > 0.5) {
        score *= Math.max(0.2, 1 - vecDist)
      }

      // Mutual confirmation boost only when vector is confident (distance ≤ 0.3).
      // Prevents boosting coincidental keyword+vector overlaps on irrelevant pages.
      if (entry.confirmedBy.size === 2 && (!fromVec || (vecDist != null && vecDist <= 0.3))) {
        score *= MUTUAL_BOOST
      }

      return {
        ...entry.result,
        fusionScore: score
      }
    })
    .sort((a, b) => (b.fusionScore ?? 0) - (a.fusionScore ?? 0))
}
