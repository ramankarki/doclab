/**
 * Recursive Markdown Chunker
 *
 * Splits markdown on h2 headers, then recursively on h3/h4 if sections
 * exceed TARGET_CHUNK_SIZE. Falls back to paragraph-level splitting.
 * NEVER splits inside a ``` code fence.
 *
 * Core rules:
 * - Target 2500 chars
 * - Min chunk: 100 chars
 * - Max chunk: none (code fence can be any size)
 * - Fence-safe: state toggle per line. ``` at line start toggles in/out.
 * - Breadcrumb inheritance: "Hono > Middleware > CORS"
 */

import type { RawChunk } from '../types'

const TARGET_CHUNK_SIZE = 2500
const MIN_CHUNK_SIZE = 100
const MERGE_MAX = Math.floor(TARGET_CHUNK_SIZE * 0.9)

export function chunkMarkdown(text: string, sourceName: string): RawChunk[] {
  const chunks = chunkRecursive(text, sourceName, '')

  if (chunks.length === 0) {
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

  return deduplicatePaths(chunks)
}

function chunkRecursive(text: string, sourceName: string, parentPath: string): RawChunk[] {
  // Try h2 split first
  const h2Sections = splitOnHeaders(text, /^## .+$/gm)

  if (h2Sections.length >= 1) {
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
        const subChunks = splitDeeper(section.text, sourceName, path, '###')
        chunks.push(...subChunks)
      }
    }
    if (chunks.length > 0) return chunks
  }

  // No h2 sections — try h3
  const h3Sections = splitOnHeaders(text, /^### .+$/gm)
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
        const subChunks = splitDeeper(section.text, sourceName, path, '####')
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

  const paraChunks = splitOnParagraphs(trimmed)
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
  level: string
): RawChunk[] {
  const pattern = new RegExp(`^${level} .+$`, 'gm')
  const sections = splitOnHeaders(text, pattern)

  if (sections.length >= 1) {
    const chunks: RawChunk[] = []
    const parentHeading = parentPath.split(' > ').pop() || sourceName
    for (const section of sections) {
      if (section.text.trim().length < MIN_CHUNK_SIZE) continue

      const header = section.header || parentHeading
      const path = section.header ? `${parentPath} > ${section.header}` : parentPath

      if (section.text.trim().length <= TARGET_CHUNK_SIZE) {
        chunks.push({
          header,
          sectionPath: path,
          content: section.text.trim(),
          hasCodeBlocks: hasFences(section.text)
        })
      } else {
        const nextLevel = level === '###' ? '####' : null
        if (nextLevel) {
          const subChunks = splitDeeper(section.text, sourceName, path, nextLevel)
          chunks.push(...subChunks)
        } else {
          const paraChunks = splitOnParagraphs(section.text.trim())
          const merged = mergeSmallChunks(paraChunks)
          for (let i = 0; i < merged.length; i++) {
            chunks.push({
              header,
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
  const paraChunks = splitOnParagraphs(text.trim())
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

function splitOnHeaders(text: string, pattern: RegExp): Section[] {
  const regex = new RegExp(pattern.source, 'gm')
  const matches: { index: number; header: string; end: number }[] = []

  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const splitPoint = match.index
    if (isInsideFence(text, splitPoint)) continue

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

  if (matches[0].index > 0) {
    const before = text.slice(0, matches[0].index).trim()
    if (before.length >= MIN_CHUNK_SIZE) {
      sections.push({ header: '', text: before })
    }
  }

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

function splitOnParagraphs(text: string): ChunkFragment[] {
  const lines = text.split('\n')
  const parts: string[] = []
  let current = ''
  let inFence = false

  for (const line of lines) {
    // Toggle fence state on any fence line (3+ backticks or tildes)
    if (isFenceLine(line)) {
      inFence = !inFence
      current += (current ? '\n' : '') + line
      continue
    }

    if (inFence) {
      // Inside code block — always keep together
      current += '\n' + line
      continue
    }

    // Outside fence: blank line = paragraph boundary
    if (line.trim() === '') {
      if (current) {
        parts.push(current)
        current = ''
      }
    } else {
      current += (current ? '\n' : '') + line
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
    const combinedSize = buffer
      ? buffer.length + 2 + chunk.content.length
      : chunk.content.length

    if (chunk.content.length >= MERGE_MAX) {
      if (buffer) {
        result.push({ content: buffer })
        buffer = ''
      }
      result.push(chunk)
    } else if (combinedSize <= MERGE_MAX) {
      buffer = buffer ? buffer + '\n\n' + chunk.content : chunk.content
    } else {
      result.push({ content: buffer })
      buffer = chunk.content
    }
  }

  if (buffer) {
    if (result.length > 0 && result[result.length - 1].content.length + 2 + buffer.length <= TARGET_CHUNK_SIZE) {
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

function deduplicatePaths(chunks: RawChunk[]): RawChunk[] {
  const pathFreq = new Map<string, number>()
  for (const c of chunks) {
    pathFreq.set(c.sectionPath, (pathFreq.get(c.sectionPath) ?? 0) + 1)
  }

  const counters = new Map<string, number>()
  return chunks.map((c) => {
    const path = c.sectionPath
    if ((pathFreq.get(path) ?? 0) <= 1) return c
    const count = counters.get(path) ?? 0
    counters.set(path, count + 1)
    if (count === 0) return c
    return { ...c, sectionPath: `${path} #${count + 1}` }
  })
}

// ─── Fence utilities ───

/**
 * Check if a line starts a code fence (3+ backticks or 3+ tildes, max 3 spaces indent).
 */
function isFenceLine(line: string): boolean {
  const trimmed = line.trimStart()
  return /^```+/.test(trimmed) || /^~~~+/.test(trimmed)
}

/**
 * Check if a position in text is inside a code fence.
 * Uses line-by-line state toggle — simple and correct.
 */
function isInsideFence(text: string, pos: number): boolean {
  const upToPos = text.slice(0, pos)
  const lines = upToPos.split('\n')
  let inFence = false
  for (const line of lines) {
    if (isFenceLine(line)) {
      inFence = !inFence
    }
  }
  return inFence
}

function hasFences(text: string): boolean {
  return /```|~~~/.test(text)
}
