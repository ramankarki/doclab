/**
 * Hybrid Search: Vector ANN + Keyword token overlap + RRF fusion
 */

import type { ScoredResult, SearchResponse, SourceKind } from "../types";
import type { Database } from "bun:sqlite";
import { searchSimilar, isVecLoaded } from "../db";

const RRF_K = 60;

export function hybridSearch(
  db: Database,
  queryEmbedding: Float32Array | null,
  query: string,
  topK: number,
  dims: number | undefined,
  source?: string,
  kind?: SourceKind
): SearchResponse {
  const start = performance.now();

  const vecResults: ScoredResult[] = [];
  const kwResults: ScoredResult[] = [];

  // ── Vector search ──
  if (queryEmbedding && dims && isVecLoaded()) {
    try {
      const rows = searchSimilar(
        db,
        queryEmbedding,
        dims,
        topK,
        source,
        kind
      );
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
          rank: i,
        }))
      );
    } catch (e: any) {
      console.error("[doclab] Vector search failed:", e.message);
      // vec0 search failed — fall through to keyword only
    }
  }

  // ── Keyword search ──
  try {
    const kwResults_raw = keywordSearch(db, query, topK * 2, source, kind);
    kwResults.push(...kwResults_raw.map((r, i) => ({ ...r, rank: i })));
  } catch {
    // Keyword should not fail
  }

  // ── RRF Fusion ──
  let merged: ScoredResult[];
  const degraded = vecResults.length === 0;

  if (vecResults.length > 0 && kwResults.length > 0) {
    merged = rrfFusion(vecResults, kwResults);
  } else if (vecResults.length > 0) {
    merged = vecResults.map((r) => ({
      ...r,
      fusionScore: 1 / (RRF_K + r.rank + 1),
    }));
  } else {
    merged = kwResults.map((r) => ({
      ...r,
      fusionScore: 1 / (RRF_K + r.rank + 1),
    }));
  }

  // Sort by fusion score descending, take top K
  merged.sort((a, b) => (b.fusionScore ?? 0) - (a.fusionScore ?? 0));
  const results = merged.slice(0, topK);

  const end = performance.now();

  return {
    results,
    degraded,
    queryTimeMs: Math.round(end - start),
  };
}

// ── Keyword Search ──

function keywordSearch(
  db: Database,
  query: string,
  limit: number,
  source?: string,
  kind?: string
): ScoredResult[] {
  const tokens = query
    .toLowerCase()
    .split(/[\s,.-]+/)
    .filter((t) => t.length > 1);

  if (tokens.length === 0) return [];

  const conditions = tokens.map(
    () => `(c.header LIKE ? OR c.section_path LIKE ? OR c.content LIKE ?)`
  );

  let sql = `
    SELECT c.hash, c.source, c.section_path, c.header, c.content,
           c.has_code_blocks, s.title, s.domain, s.kind, s.fetched_at, s.version
    FROM chunks c
    JOIN sources s ON c.source = s.name
    WHERE c.stale = 0
      AND (${conditions.join(" OR ")})
  `;

  const params: string[] = [];
  for (const token of tokens) {
    const p = `%${token}%`;
    params.push(p, p, p);
  }

  if (source) {
    sql += ` AND c.source = ?`;
    params.push(source);
  }
  if (kind) {
    sql += ` AND s.kind = ?`;
    params.push(kind);
  }

  sql += ` LIMIT ?`;
  params.push(String(limit));

  const rows = db.prepare(sql).all(...params) as any[];

  // Score results based on match quality
  const scored = rows.map((r: any, i: number) => {
    let score = 0;
    const headerLower = (r.header ?? "").toLowerCase();
    const pathLower = (r.section_path ?? "").toLowerCase();
    const contentLower = (r.content ?? "").toLowerCase();

    for (const token of tokens) {
      if (headerLower.includes(token)) score += 3;
      if (pathLower.includes(token)) score += 2;
      if (contentLower.includes(token)) score += 1;
    }
    const matchCount = tokens.filter(
      (t) =>
        headerLower.includes(t) ||
        pathLower.includes(t) ||
        contentLower.includes(t)
    ).length;
    score *= matchCount;

    return {
      hash: r.hash,
      source: r.source,
      sectionPath: r.section_path,
      header: r.header,
      content: r.content,
      hasCodeBlocks: Boolean(r.has_code_blocks),
      distance: 1 / (1 + score),
      sourceTitle: r.title,
      sourceDomain: r.domain,
      sourceKind: r.kind,
      sourceVersion: r.version,
      fetchedAt: r.fetched_at,
      rank: i,
    };
  });

  // Sort by score descending (distance ascending)
  scored.sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1));
  return scored.map((r, i) => ({ ...r, rank: i }));
}

// ── Reciprocal Rank Fusion ──

function rrfFusion(
  resultsA: ScoredResult[],
  resultsB: ScoredResult[]
): ScoredResult[] {
  const scores = new Map<string, { result: ScoredResult; score: number }>();

  for (let i = 0; i < resultsA.length; i++) {
    const r = resultsA[i];
    const key = r.hash;
    const existing = scores.get(key);
    const score = (existing?.score ?? 0) + 1 / (RRF_K + i + 1);
    scores.set(key, { result: r, score });
  }

  for (let i = 0; i < resultsB.length; i++) {
    const r = resultsB[i];
    const key = r.hash;
    const existing = scores.get(key);
    const score = (existing?.score ?? 0) + 1 / (RRF_K + i + 1);
    scores.set(key, {
      result: existing?.result ?? r,
      score,
    });
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      ...entry.result,
      fusionScore: entry.score,
    }));
}
