/**
 * Recursive Markdown Chunker
 *
 * Splits markdown on h2 headers, then recursively on h3/h4 if sections
 * exceed TARGET_CHUNK_SIZE. Falls back to paragraph-level splitting.
 * NEVER splits inside a ``` code fence.
 *
 * Core rules:
 * - Target 2500 chars (~400 tokens)
 * - Min chunk: 100 chars (skip near-empty sections)
 * - Max chunk: none (code fence can be any size)
 * - Merge adjacent fragments < 200 chars after paragraph split
 * - Breadcrumb inheritance: "Hono > Middleware > CORS"
 */

import type { RawChunk, FenceSpan } from '../types'

const TARGET_CHUNK_SIZE = 2500
const MIN_CHUNK_SIZE = 100
const MERGE_THRESHOLD = 200

export function chunkMarkdown(text: string, sourceName: string): RawChunk[] {
  const chunks = chunkRecursive(text, sourceName, '')

  if (chunks.length === 0) {
    // No sections found at all — make one chunk from whole text
    if (text.trim().length >= MIN_CHUNK_SIZE) {
      return [
        {
          header: sourceName,
          sectionPath: sourceName,
          content: text.trim(),
          hasCodeBlocks: hasFences(text)
        }
      ]
    }
    return []
  }

  // Deduplicate section paths — append #2, #3 for repeats
  return deduplicatePaths(chunks)
}

function chunkRecursive(text: string, sourceName: string, parentPath: string): RawChunk[] {
  const fenceSpans = findFenceSpans(text)

  // Try h2 split first
  const h2Sections = splitOnHeaders(text, /^## .+$/gm, fenceSpans)

  if (h2Sections.length >= 1) {
    // Got h2 sections
    const chunks: RawChunk[] = []
    for (const section of h2Sections) {
      const header = section.header || sourceName
      if (section.text.trim().length < MIN_CHUNK_SIZE) continue

      const path = section.header
        ? parentPath
          ? `${parentPath} > ${section.header}`
          : `${sourceName} > ${section.header}`
        : parentPath || sourceName

      if (section.text.trim().length <= TARGET_CHUNK_SIZE) {
        chunks.push({
          header,
          sectionPath: path,
          content: section.text.trim(),
          hasCodeBlocks: hasFences(section.text)
        })
      } else {
        // Too big — try h3 split
        const subChunks = splitDeeper(section.text, sourceName, path, '###', fenceSpans)
        chunks.push(...subChunks)
      }
    }
    if (chunks.length > 0) return chunks
  }

  // No h2 sections — try h3
  const h3Sections = splitOnHeaders(text, /^### .+$/gm, fenceSpans)
  if (h3Sections.length >= 1) {
    const chunks: RawChunk[] = []
    for (const section of h3Sections) {
      if (section.text.trim().length < MIN_CHUNK_SIZE) continue

      const header = section.header || sourceName
      const path = section.header
        ? parentPath
          ? `${parentPath} > ${section.header}`
          : `${sourceName} > ${section.header}`
        : parentPath || sourceName

      if (section.text.trim().length <= TARGET_CHUNK_SIZE) {
        chunks.push({
          header,
          sectionPath: path,
          content: section.text.trim(),
          hasCodeBlocks: hasFences(section.text)
        })
      } else {
        const subChunks = splitDeeper(section.text, sourceName, path, '####', fenceSpans)
        chunks.push(...subChunks)
      }
    }
    if (chunks.length > 0) return chunks
  }

  // No headers at all — paragraph split
  const trimmed = text.trim()
  if (trimmed.length <= TARGET_CHUNK_SIZE) {
    if (trimmed.length >= MIN_CHUNK_SIZE) {
      const path = parentPath || sourceName
      return [
        {
          header: parentPath || sourceName,
          sectionPath: path,
          content: trimmed,
          hasCodeBlocks: hasFences(text)
        }
      ]
    }
    return []
  }

  // Paragraph-level split
  const paraChunks = splitOnParagraphs(trimmed, fenceSpans)
  const merged = mergeSmallChunks(paraChunks)
  const path = parentPath || sourceName

  const warning = '⚠ weak chunk boundaries — search quality may vary'
  if (merged.length > 0 && !merged[0].content.includes(warning)) {
    merged[0].content = `${warning}\n\n${merged[0].content}`
  }

  return merged.map((c, i) => ({
    header: sourceName,
    sectionPath: merged.length > 1 ? `${path} #${i + 1}` : path,
    content: c.content,
    hasCodeBlocks: hasFences(c.content)
  }))
}

function splitDeeper(
  text: string,
  sourceName: string,
  parentPath: string,
  level: string,
  _parentFenceSpans: FenceSpan[]
): RawChunk[] {
  const fenceSpans = findFenceSpans(text)
  const pattern = new RegExp(`^${level} .+$`, 'gm')
  const sections = splitOnHeaders(text, pattern, fenceSpans)

  if (sections.length >= 1) {
    const chunks: RawChunk[] = []
    for (const section of sections) {
      if (section.text.trim().length < MIN_CHUNK_SIZE) continue

      const path = `${parentPath} > ${section.header}`

      if (section.text.trim().length <= TARGET_CHUNK_SIZE) {
        chunks.push({
          header: section.header,
          sectionPath: path,
          content: section.text.trim(),
          hasCodeBlocks: hasFences(section.text)
        })
      } else {
        // Try next level deeper
        const nextLevel = level === '###' ? '####' : null
        if (nextLevel) {
          const subChunks = splitDeeper(section.text, sourceName, path, nextLevel, fenceSpans)
          chunks.push(...subChunks)
        } else {
          // No deeper headers — paragraph split
          const paraChunks = splitOnParagraphs(section.text.trim(), fenceSpans)
          const merged = mergeSmallChunks(paraChunks)
          for (let i = 0; i < merged.length; i++) {
            chunks.push({
              header: section.header,
              sectionPath: merged.length > 1 ? `${path} #${i + 1}` : path,
              content: merged[i].content,
              hasCodeBlocks: hasFences(merged[i].content)
            })
          }
        }
      }
    }
    if (chunks.length > 0) return chunks
  }

  // Can't split at this level — paragraph split
  const paraChunks = splitOnParagraphs(text.trim(), fenceSpans)
  const merged = mergeSmallChunks(paraChunks)
  return merged.map((c, i) => ({
    header: parentPath,
    sectionPath: merged.length > 1 ? `${parentPath} #${i + 1}` : parentPath,
    content: c.content,
    hasCodeBlocks: hasFences(c.content)
  }))
}

// ─── Header splitting ───

interface Section {
  header: string
  text: string
}

function splitOnHeaders(text: string, pattern: RegExp, fenceSpans: FenceSpan[]): Section[] {
  // Clone the regex with global flag to use exec
  const regex = new RegExp(pattern.source, 'gm')
  const matches: { index: number; header: string; end: number }[] = []

  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const splitPoint = match.index
    // Check if split point is inside code fence
    if (isInsideFence(splitPoint, fenceSpans)) continue

    const headerLine = match[0]
    const headerText = headerLine.replace(/^#+\s*/, '').trim()
    matches.push({
      index: splitPoint,
      header: headerText,
      end: splitPoint + headerLine.length
    })
  }

  if (matches.length === 0) return []

  const sections: Section[] = []

  // Text before first header
  if (matches[0].index > 0) {
    const before = text.slice(0, matches[0].index).trim()
    if (before.length >= MIN_CHUNK_SIZE) {
      sections.push({ header: '', text: before })
    }
  }

  // Sections between headers
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end
    const end = i < matches.length - 1 ? matches[i + 1].index : text.length
    const content = text.slice(start, end).trim()

    if (content.length >= MIN_CHUNK_SIZE) {
      sections.push({ header: matches[i].header, text: content })
    }
  }

  return sections
}

// ─── Paragraph splitting ───

interface ChunkFragment {
  content: string
}

function splitOnParagraphs(text: string, fenceSpans: FenceSpan[]): ChunkFragment[] {
  // Split on double newlines (paragraph breaks)
  const rawParts = text.split(/\n\n+/)

  // Merge parts that are inside the same code fence
  const parts: string[] = []
  let current = ''

  for (const part of rawParts) {
    if (current === '') {
      current = part
    } else {
      const testText = current + '\n\n' + part
      // Check if the join point is inside a fence
      const joinPoint = current.length
      // Only merge if both are inside fences or both outside
      const currentInFence = isInsideFence(current.length - 1, fenceSpans)
      const partInFence = isInsideFence(0, findFenceSpans(part))

      if (currentInFence === partInFence) {
        current += '\n\n' + part
      } else {
        parts.push(current)
        current = part
      }
    }
  }
  if (current) parts.push(current)

  return parts.filter((p) => p.trim().length >= MIN_CHUNK_SIZE).map((p) => ({ content: p.trim() }))
}

function mergeSmallChunks(chunks: ChunkFragment[]): ChunkFragment[] {
  if (chunks.length <= 1) return chunks

  const result: ChunkFragment[] = []
  let buffer = ''

  for (const chunk of chunks) {
    if (chunk.content.length < MERGE_THRESHOLD) {
      // Small chunk — buffer it
      buffer = buffer ? buffer + '\n\n' + chunk.content : chunk.content
    } else {
      // Large chunk
      if (buffer) {
        // Merge buffer into this chunk (prepend)
        result.push({ content: buffer + '\n\n' + chunk.content })
        buffer = ''
      } else {
        result.push(chunk)
      }
    }
  }

  // Remaining buffer
  if (buffer) {
    if (result.length > 0) {
      // Merge with last chunk
      result[result.length - 1] = {
        content: result[result.length - 1].content + '\n\n' + buffer
      }
    } else {
      result.push({ content: buffer })
    }
  }

  return result
}

// ─── Path deduplication ───
// Ensures every chunk has a unique sectionPath by appending a disambiguating
// suffix when collisions are detected (e.g., multiple h2 sections with same header).

function deduplicatePaths(chunks: RawChunk[]): RawChunk[] {
  // First pass: build a set of all paths to find collisions
  const pathFreq = new Map<string, number>()
  for (const c of chunks) {
    pathFreq.set(c.sectionPath, (pathFreq.get(c.sectionPath) ?? 0) + 1)
  }

  // Second pass: for paths that appear multiple times, append counters
  const counters = new Map<string, number>()
  return chunks.map((c) => {
    const path = c.sectionPath
    if ((pathFreq.get(path) ?? 0) <= 1) return c
    const count = counters.get(path) ?? 0
    counters.set(path, count + 1)
    if (count === 0) return c // first occurrence stays as-is
    return { ...c, sectionPath: `${path} #${count + 1}` }
  })
}

// ─── Fence utilities ───

function findFenceSpans(text: string): FenceSpan[] {
  const spans: FenceSpan[] = []
  const regex = /^```/gm
  let match: RegExpExecArray | null
  const openSpans: number[] = []

  while ((match = regex.exec(text)) !== null) {
    if (openSpans.length === 0) {
      openSpans.push(match.index)
    } else {
      const start = openSpans.pop()!
      spans.push({ start, end: match.index + 3 })
    }
  }

  // Unclosed fences: close at end of text
  for (const start of openSpans) {
    spans.push({ start, end: text.length })
  }

  return spans
}

function isInsideFence(pos: number, spans: FenceSpan[]): boolean {
  return spans.some((s) => pos > s.start && pos < s.end)
}

function hasFences(text: string): boolean {
  return /```/.test(text)
}
