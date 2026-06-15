import { describe, test, expect } from 'bun:test'
import {
  fetchUrl,
  hashContent,
  chunkHash,
  FetchError,
  isLlmsTxtUrl,
  fetchAndConcat,
  extractRelativeLinks
} from '../src/lib/fetcher'

describe('fetchAndConcat', () => {
  test('returns empty string for empty array', async () => {
    const { content } = await fetchAndConcat([])
    expect(content).toBe('')
  })

  test('warns on partial failure, returns successful pages', async () => {
    // Non-existent port + a working server
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/ok.md') {
          return new Response('# OK', {
            headers: { 'Content-Type': 'text/markdown' }
          })
        }
        return new Response('Not Found', { status: 404 })
      }
    })

    try {
      const base = `http://127.0.0.1:${server.port}`
      const { content } = await fetchAndConcat([
        `${base}/ok.md`,
        'http://127.0.0.1:19999/nope.md',
        `${base}/ok.md`
      ])
      // Returns successful pages, skip failures
      expect(content).toContain('# OK')
      // Warning logged to stderr (can't easily assert, but no throw)
    } finally {
      server.stop()
    }
  })

  test('throws only when ALL pages fail', async () => {
    try {
      await fetchAndConcat(['http://127.0.0.1:19999/a.md', 'http://127.0.0.1:19999/b.md'])
      expect(false).toBe(true)
    } catch (e: any) {
      expect(e.message).toContain('all')
      expect(e.message).toContain('pages could not be fetched')
    }
  })

  test('fetches and concatenates pages preserving order', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/page1.md') {
          return new Response('# Page 1\n\nContent one.', {
            headers: { 'Content-Type': 'text/markdown' }
          })
        }
        if (url.pathname === '/page2.md') {
          return new Response('# Page 2\n\nContent two.', {
            headers: { 'Content-Type': 'text/markdown' }
          })
        }
        if (url.pathname === '/page3.md') {
          return new Response('# Page 3\n\nContent three.', {
            headers: { 'Content-Type': 'text/markdown' }
          })
        }
        return new Response('Not Found', { status: 404 })
      }
    })

    try {
      const base = `http://127.0.0.1:${server.port}`
      const { content } = await fetchAndConcat([
        `${base}/page1.md`,
        `${base}/page2.md`,
        `${base}/page3.md`
      ])

      expect(content).toContain('# Page 1')
      expect(content).toContain('# Page 2')
      expect(content).toContain('# Page 3')
      expect(content).toBe(
        '# Page 1\n\nContent one.\n\n# Page 2\n\nContent two.\n\n# Page 3\n\nContent three.'
      )
    } finally {
      server.stop()
    }
  })
})

describe('isLlmsTxtUrl', () => {
  test('returns true for llms.txt URLs', () => {
    expect(isLlmsTxtUrl('https://better-auth.com/llms.txt')).toBe(true)
    expect(isLlmsTxtUrl('https://ui.shadcn.com/llms.txt')).toBe(true)
    expect(isLlmsTxtUrl('https://tanstack.com/llms.txt')).toBe(true)
    expect(isLlmsTxtUrl('https://backblaze.com/llms.txt')).toBe(true)
  })

  test('returns false for llms-full.txt URLs', () => {
    expect(isLlmsTxtUrl('https://hono.dev/llms-full.txt')).toBe(false)
    expect(isLlmsTxtUrl('https://orm.drizzle.team/llms-full.txt')).toBe(false)
    expect(isLlmsTxtUrl('https://zod.dev/llms-full.txt')).toBe(false)
  })

  test('returns false for regular docs URLs', () => {
    expect(isLlmsTxtUrl('https://hono.dev/docs/guides/rpc')).toBe(false)
    expect(isLlmsTxtUrl('https://example.com/readme.md')).toBe(false)
    expect(isLlmsTxtUrl('https://example.com')).toBe(false)
  })

  test('ignores query params and hash', () => {
    expect(isLlmsTxtUrl('https://example.com/llms.txt?v=2')).toBe(true)
    expect(isLlmsTxtUrl('https://example.com/llms.txt#section')).toBe(true)
    expect(isLlmsTxtUrl('https://example.com/llms.txt?v=2&x=3#top')).toBe(true)
  })

  test('handles invalid URLs gracefully', () => {
    expect(isLlmsTxtUrl('not a url')).toBe(false)
    expect(isLlmsTxtUrl('')).toBe(false)
  })

  test('any protocol with /llms.txt pathname matches', () => {
    // URL constructor parses ftp:// fine — pathname still ends with /llms.txt
    expect(isLlmsTxtUrl('ftp://example.com/llms.txt')).toBe(true)
  })

  test('case sensitive — pathname must end with /llms.txt', () => {
    expect(isLlmsTxtUrl('https://example.com/LLMS.TXT')).toBe(false)
    expect(isLlmsTxtUrl('https://example.com/Llms.txt')).toBe(false)
  })

  test('path must end with exact /llms.txt, not in middle', () => {
    expect(isLlmsTxtUrl('https://example.com/llms.txt/docs/page')).toBe(false)
    expect(isLlmsTxtUrl('https://example.com/docs/llms.txt.md')).toBe(false)
  })
})

describe('extractRelativeLinks', () => {
  const betterAuthLlms = `# Better Auth

## Getting Started
- [Installation](/docs/installation.md)
- [Basic Usage](/docs/basic-usage.md)

## Plugins
- [Email & Password](/docs/plugins/email-password.md)
- [OAuth](/docs/plugins/oauth.md)

## Adapters
- [Drizzle ORM](/docs/adapters/drizzle.md)
- [Prisma](/docs/adapters/prisma.md)

## External
- [GitHub](https://github.com/better-auth/better-auth)
- [Discord](https://discord.gg/better-auth)

## Misc
- [Skip anchor](#section-anchor)
- [Empty]()
- [Mailto](mailto:test@example.com)
`

  test('extracts relative markdown links', () => {
    const links = extractRelativeLinks(betterAuthLlms, 'https://better-auth.com/llms.txt')
    expect(links).toContain('https://better-auth.com/docs/installation.md')
    expect(links).toContain('https://better-auth.com/docs/basic-usage.md')
    expect(links).toContain('https://better-auth.com/docs/plugins/email-password.md')
    expect(links).toContain('https://better-auth.com/docs/plugins/oauth.md')
    expect(links).toContain('https://better-auth.com/docs/adapters/drizzle.md')
    expect(links).toContain('https://better-auth.com/docs/adapters/prisma.md')
    expect(links.length).toBe(6)
  })

  test('excludes external domains', () => {
    const links = extractRelativeLinks(betterAuthLlms, 'https://better-auth.com/llms.txt')
    expect(links.some(l => l.includes('github.com'))).toBe(false)
    expect(links.some(l => l.includes('discord.gg'))).toBe(false)
  })

  test('excludes anchor-only links', () => {
    const links = extractRelativeLinks(betterAuthLlms, 'https://better-auth.com/llms.txt')
    expect(links).not.toContain('https://better-auth.com/llms.txt#section-anchor')
    expect(links.some(l => l.includes('#'))).toBe(false)
  })

  test('excludes empty and non-http links', () => {
    const links = extractRelativeLinks(betterAuthLlms, 'https://better-auth.com/llms.txt')
    // No empty href link
    expect(links.length).toBe(6)
  })

  test('returns empty array for content with no links', () => {
    const links = extractRelativeLinks('Just plain text\nno links here', 'https://example.com')
    expect(links).toEqual([])
  })

  test('deduplicates identical links', () => {
    const dupContent = '- [One](/docs/a.md)\n- [Two](/docs/a.md)\n'
    const links = extractRelativeLinks(dupContent, 'https://example.com/llms.txt')
    expect(links).toEqual(['https://example.com/docs/a.md'])
  })

  test('strips fragments on dedup', () => {
    const content = '- [One](/docs/a.md#section1)\n- [Two](/docs/a.md#section2)\n'
    const links = extractRelativeLinks(content, 'https://example.com/llms.txt')
    expect(links).toEqual(['https://example.com/docs/a.md'])
  })

  test('preserves same-domain absolute URLs', () => {
    const content = '- [Self](https://example.com/docs/page.md)\n- [Other](https://other.com/page.md)\n'
    const links = extractRelativeLinks(content, 'https://example.com/llms.txt')
    expect(links).toContain('https://example.com/docs/page.md')
    expect(links.some(l => l.includes('other.com'))).toBe(false)
    expect(links.length).toBe(1)
  })
})

describe('fetcher', () => {
  test('hashContent produces consistent hashes', () => {
    const hash1 = hashContent('hello world')
    const hash2 = hashContent('hello world')
    expect(hash1).toBe(hash2)
  })

  test('hashContent produces different hashes for different content', () => {
    const hash1 = hashContent('hello')
    const hash2 = hashContent('world')
    expect(hash1).not.toBe(hash2)
  })

  test('chunkHash produces stable hashes', () => {
    const hash1 = chunkHash('hono', 'Middleware > CORS')
    const hash2 = chunkHash('hono', 'Middleware > CORS')
    expect(hash1).toBe(hash2)
    expect(hash1.length).toBe(16) // hex string of first 8 bytes
  })

  test('chunkHash differentiates sources', () => {
    const h1 = chunkHash('hono', 'Middleware > CORS')
    const h2 = chunkHash('express', 'Middleware > CORS')
    expect(h1).not.toBe(h2)
  })

  test('FetchError has correct properties', () => {
    const err = new FetchError('Not found', 'NOT_FOUND', 404)
    expect(err.message).toBe('Not found')
    expect(err.code).toBe('NOT_FOUND')
    expect(err.status).toBe(404)
    expect(err.name).toBe('FetchError')
    expect(err instanceof Error).toBe(true)
  })

  test('fetchUrl rejects invalid URLs', async () => {
    try {
      await fetchUrl('not-a-valid-url')
      expect(false).toBe(true) // should not reach
    } catch (e: any) {
      expect(e).toBeDefined()
    }
  })
})
