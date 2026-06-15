import { createHash } from 'node:crypto'
import type { SourceMeta, SourceKind } from '../types'
import { htmlToMarkdown } from './html-to-md'

export interface FetchResult {
  content: string
  contentType: string
  isMarkdown: boolean
  isHtml: boolean
  hash: string
  meta: Partial<SourceMeta>
}

const JINA_BASE = 'https://r.jina.ai/'

// Status codes that trigger retry (transient failures)
const RETRY_STATUSES = new Set([429, 502, 503])

// Status codes that trigger Jina AI fallback (after retries exhausted)
const FALLBACK_STATUSES = new Set([403, 429, 502, 503])

// Patterns suggesting bot-detection pages (only checked on HTML responses)
const BOT_DETECTION_PATTERNS = [
  /<(?:title|h1)[^>]*>\s*(?:Just a moment|Attention Required|Access Denied|security check|verifying)/i,
  /Cloudflare Ray ID:/i,
  /id="challenge-error-text"/i,
  /g-recaptcha-response/i,
  /turnstile/i
]

// SPA detection: pages where content is loaded via JavaScript.
// The static HTML is an empty shell — no headings, no semantic content elements.
const SPA_MIN_HEADINGS = 1

function isSpaShell(html: string): boolean {
  // Extract body, strip script/style before analysis
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (!bodyMatch) return false
  let body = bodyMatch[1]
  body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  body = body.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')

  // Count headings
  const h1 = (body.match(/<h1[\s>]/gi) || []).length
  const h2 = (body.match(/<h2[\s>]/gi) || []).length
  const h3 = (body.match(/<h3[\s>]/gi) || []).length
  const headings = h1 + h2 + h3
  if (headings >= SPA_MIN_HEADINGS) return false

  // Count semantic content elements — SPAs have hardly any
  const paragraphs = (body.match(/<p[\s>]/gi) || []).length
  const listItems = (body.match(/<li[\s>]/gi) || []).length
  const codeBlocks = (body.match(/<pre[\s>]/gi) || []).length
  const tables = (body.match(/<table[\s>]/gi) || []).length
  const semanticElements = paragraphs + listItems + codeBlocks + tables

  return headings === 0 && semanticElements < 5
}

export async function fetchUrl(url: string, jinaApiKey?: string): Promise<FetchResult> {
  // npmjs.com package pages: use registry API (SPA — raw HTML is empty shell)
  const npmContent = await fetchNpmContent(url)
  if (npmContent) return npmContent

  // Try direct fetch with retry on transient errors
  let lastError: any
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await directFetch(url)
      // SPA detection: if HTML has no headings and very little text,
      // content is likely loaded via JavaScript. Retry with Jina.
      if (result.isHtml && isSpaShell(result.content)) {
        try {
          const jinaResult = await jinaFetch(url, jinaApiKey)
          console.log('[doclab] SPA detected — used Jina AI to render JavaScript')
          return jinaResult
        } catch {
          // Jina failed — return original HTML (better than nothing)
          console.log('[doclab] SPA detected but Jina AI unavailable. Indexing static HTML only.')
        }
      }
      return result
    } catch (e: any) {
      lastError = e
      if (e instanceof FetchError && e.status === 404) {
        throw e // 404 is permanent — don't retry or fallback
      }
      if (e instanceof FetchError && RETRY_STATUSES.has(e.status) && attempt < 2) {
        const delay = Math.pow(2, attempt) * 1000 // 1s, 2s
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      // Connection errors also retry
      if ((e.name === 'FetchError' || e.cause?.code === 'ECONNREFUSED') && attempt < 2) {
        const delay = Math.pow(2, attempt) * 1000
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      break
    }
  }

  // Retries exhausted — try Jina fallback for fallback-eligible statuses
  if (lastError instanceof FetchError && FALLBACK_STATUSES.has(lastError.status)) {
    return await jinaFetch(url, jinaApiKey)
  }
  if (lastError?.name === 'FetchError' || lastError?.cause?.code === 'ECONNREFUSED') {
    return await jinaFetch(url, jinaApiKey)
  }

  throw lastError
}

async function directFetch(url: string): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'doclab/0.1 (local knowledge server)',
      Accept: 'text/markdown, text/html, text/plain, */*'
    },
    redirect: 'follow'
  })

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      throw new FetchError(`URL returned ${response.status}`, 'NOT_FOUND', response.status)
    }
    throw new FetchError(
      `HTTP ${response.status}: ${response.statusText}`,
      'HTTP_ERROR',
      response.status
    )
  }

  const contentType = response.headers.get('content-type') ?? ''
  const raw = await response.text()

  // Only check for bot-detection on HTML pages
  const isHtmlResponse = contentType.includes('text/html')
  if (isHtmlResponse && isBotDetectionPage(raw)) {
    throw new FetchError('Bot detection page detected', 'BOT_DETECTED', 403)
  }

  const hash = createHash('sha256').update(raw).digest('hex')

  const isMarkdown =
    contentType.includes('text/markdown') ||
    contentType.includes('text/plain') ||
    url.endsWith('.md') ||
    url.endsWith('.txt') ||
    url.includes('llms-full.txt') ||
    url.includes('llms.txt')

  const isHtml = contentType.includes('text/html') || !isMarkdown

  const meta = await extractMeta(raw, isHtml, url)

  return {
    content: raw,
    contentType,
    isMarkdown,
    isHtml,
    hash,
    meta
  }
}

async function jinaFetch(url: string, apiKey?: string): Promise<FetchResult> {
  const jinaUrl = `${JINA_BASE}${url}`
  const headers: Record<string, string> = {
    Accept: 'text/markdown'
  }

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const response = await fetch(jinaUrl, { headers })

  if (!response.ok) {
    throw new FetchError(
      `Jina AI fallback failed: HTTP ${response.status}`,
      'JINA_FAILED',
      response.status
    )
  }

  const raw = await response.text()
  const hash = createHash('sha256').update(raw).digest('hex')

  // Jina AI returns clean markdown
  const meta = await extractMeta(raw, false, url)

  return {
    content: raw,
    contentType: 'text/markdown',
    isMarkdown: true,
    isHtml: false,
    hash,
    meta
  }
}

function isBotDetectionPage(html: string): boolean {
  // Only run on HTML content (caller ensures this)
  return BOT_DETECTION_PATTERNS.some((p) => p.test(html))
}

async function extractMeta(
  raw: string,
  isHtml: boolean,
  url: string
): Promise<Partial<SourceMeta>> {
  const meta: Partial<SourceMeta> = {}
  const u = new URL(url)
  meta.domain = u.hostname
  meta.url = url

  if (isHtml) {
    // Extract title
    const titleMatch = raw.match(/<title[^>]*>([^<]*)<\/title>/i)
    if (titleMatch) {
      meta.title = titleMatch[1].trim()
    }

    // Extract author
    const authorMatch = raw.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']*)["']/i)
    if (authorMatch) {
      meta.author = authorMatch[1]
    }

    // Extract published date
    const dateMatch = raw.match(
      /<meta[^>]+(?:property=["']article:published_time["']|name=["']date["'])[^>]+content=["']([^"']*)["']/i
    )
    if (dateMatch) {
      meta.publishedAt = dateMatch[1]
    }
  } else {
    // Markdown — try first h1 as title
    const h1Match = raw.match(/^#\s+(.+)$/m)
    if (h1Match) {
      meta.title = h1Match[1].trim()
    }
  }

  // Detect version
  const versionMatch = raw
    .slice(0, 5000)
    .match(/(?:v(?:ersion[:\s]*)?)(\d+\.\d+\.\d+)|(?:###\s+v?(\d+\.\d+\.\d+))/i)
  if (versionMatch) {
    meta.version = versionMatch[1] || versionMatch[2]
  } else {
    // Try npm registry for npmjs.com package pages
    meta.version = await detectNpmVersion(url)
  }

  // Detect kind
  meta.kind = detectKind(url, raw, isHtml)

  return meta
}

function detectKind(url: string, _raw: string, _isHtml: boolean): SourceKind {
  const path = new URL(url).pathname.toLowerCase()

  if (url.includes('llms-full.txt') || url.includes('llms.txt')) {
    return 'docs'
  }
  if (path.includes('/docs/') || path.includes('/reference/')) {
    return 'docs'
  }
  if (path.includes('/api/')) {
    return 'reference'
  }

  const domain = new URL(url).hostname
  if (
    domain.includes('dev.to') ||
    domain.includes('medium.com') ||
    domain.includes('freecodecamp.org') ||
    domain.includes('blog.')
  ) {
    return 'article'
  }

  if (path.includes('/tutorial') || path.includes('/guide') || path.includes('/learn')) {
    return 'tutorial'
  }

  return 'unknown'
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function isLlmsTxtUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/llms.txt')
  } catch {
    return false
  }
}

export async function fetchAndConcat(
  urls: string[],
  jinaApiKey?: string,
  concurrency = 5
): Promise<string> {
  const total = urls.length
  if (total === 0) return ''
  const results: string[] = new Array(total)
  const failed: { url: string; error: string }[] = []

  // Process in batches to limit concurrency
  for (let i = 0; i < total; i += concurrency) {
    const batch = urls.slice(i, i + concurrency)
    const settled = await Promise.allSettled(
      batch.map(async (u, bi) => {
        const idx = i + bi
        const fileName = u.split('/').pop() || u
        const msg = `  [${idx + 1}/${total}] Fetching ${fileName}...`
        process.stderr.write(`\r${msg}\x1b[K`)
        const result = await fetchUrl(u, jinaApiKey)
        // Convert HTML sub-pages to markdown before concatenating
        if (result.isHtml && !result.isMarkdown) {
          results[idx] = htmlToMarkdown(result.content)
        } else {
          results[idx] = result.content
        }
      })
    )

    for (let j = 0; j < settled.length; j++) {
      const s = settled[j]
      if (s.status === 'rejected') {
        failed.push({ url: urls[i + j], error: s.reason?.message ?? 'Unknown error' })
      }
    }
  }

  process.stderr.write('\n')

  if (failed.length > 0) {
    const names = failed.map((f) => f.url.split('/').pop() || f.url).join(', ')
    console.warn(
      `[doclab] Warning: ${failed.length}/${total} sub-pages could not be fetched (${names})`
    )
  }

  // Return successfully fetched pages only
  const succeeded = results.filter((r): r is string => r != null)
  if (succeeded.length === 0) {
    throw new Error(
      `Failed to index: all ${total} pages could not be fetched (${failed.map((f) => f.url.split('/').pop() || f.url).join(', ')})`
    )
  }

  return succeeded.join('\n\n')
}

export function extractRelativeLinks(content: string, baseUrl: string): string[] {
  const base = new URL(baseUrl)
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g
  const urls = new Set<string>()

  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(content)) !== null) {
    const href = match[2].trim()

    // Skip empty, anchor-only, external URLs, mailto, javascript
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) {
      continue
    }

    let resolved: URL
    try {
      // Try resolving as relative
      if (href.startsWith('http://') || href.startsWith('https://')) {
        // Absolute URL — skip if external domain
        const parsed = new URL(href)
        if (parsed.hostname !== base.hostname) continue
        resolved = parsed
      } else {
        resolved = new URL(href, baseUrl)
      }
    } catch {
      continue
    }

    // Only keep same-domain URLs
    if (resolved.hostname !== base.hostname) continue

    // Strip fragment to deduplicate
    resolved.hash = ''
    urls.add(resolved.toString())
  }

  return Array.from(urls)
}

export function chunkHash(source: string, sectionPath: string): string {
  return createHash('sha256').update(`${source}:${sectionPath}`).digest('hex').slice(0, 16)
}

async function detectNpmVersion(url: string): Promise<string | undefined> {
  try {
    const u = new URL(url)
    const match = u.pathname.match(/^\/package\/([@a-zA-Z0-9.-]+(?:\/[a-zA-Z0-9.-]+)?)/)
    if (!match || !['npmjs.com', 'www.npmjs.com'].includes(u.hostname)) return
    const pkg = match[1]
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return
    const data = (await res.json()) as { version?: string }
    return data.version
  } catch {
    return
  }
}

export class FetchError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'FetchError'
  }
}

// ─── npm registry content fetch ───

const NPM_PKG_RE = /^\/package\/([@a-zA-Z0-9.-]+(?:\/[a-zA-Z0-9.-]+)?)/

function isNpmUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return ['npmjs.com', 'www.npmjs.com'].includes(u.hostname) && NPM_PKG_RE.test(u.pathname)
  } catch {
    return false
  }
}

function extractNpmPkg(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(NPM_PKG_RE)
    return match ? match[1] : null
  } catch {
    return null
  }
}

async function fetchNpmContent(url: string): Promise<FetchResult | null> {
  if (!isNpmUrl(url)) return null
  const pkg = extractNpmPkg(url)
  if (!pkg) return null

  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return null

    const data = (await res.json()) as {
      name?: string
      version?: string
      description?: string
      readme?: string
      license?: string
      homepage?: string
      keywords?: string[]
    }

    const title = data.name ?? pkg
    const version = data.version ?? ''
    const desc = data.description ?? ''
    const readme = data.readme ?? ''
    const license = data.license ? `License: ${data.license}` : ''
    const keywords = data.keywords?.length ? `Keywords: ${data.keywords.join(', ')}` : ''

    const meta = [
      `# ${title} v${version}`,
      desc ? `\n${desc}\n` : '',
      keywords ? `\n${keywords}` : '',
      license ? `\n${license}` : '',
      data.homepage ? `\nHomepage: ${data.homepage}` : ''
    ]
      .filter(Boolean)
      .join('\n')

    const content = readme ? `${meta}\n\n${readme}` : meta
    const hash = createHash('sha256').update(content).digest('hex')

    return {
      content,
      contentType: 'text/markdown',
      isMarkdown: true,
      isHtml: false,
      hash,
      meta: {
        title: `${title} v${version}`,
        version,
        domain: 'npmjs.com',
        kind: 'docs' as const,
        author: pkg.startsWith('@') ? pkg.split('/')[0] : undefined
      }
    }
  } catch {
    return null
  }
}
