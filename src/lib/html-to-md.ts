/**
 * HTML → Markdown converter (~150 lines, no external library)
 *
 * Handles documentation pages, blog posts, and technical articles.
 * Strips navigation, footers, and boilerplate. Preserves code blocks and headings.
 */

export function htmlToMarkdown(html: string): string {
  let result = html

  // 1. Extract main content area if present
  result = extractMainContent(result)

  // 2. Remove unwanted elements
  result = removeUnwantedElements(result)

  // 3. Convert structural elements
  result = convertHeadings(result)
  result = convertCodeBlocks(result)
  result = convertInlineCode(result)
  result = convertLinks(result)
  result = convertLists(result)
  result = convertEmphasis(result)
  result = convertTables(result)
  result = convertImages(result)
  result = convertParagraphs(result)

  // 4. Remove remaining HTML tags
  result = stripRemainingTags(result)

  // 5. Decode HTML entities (after tags removed)
  result = decodeHtmlEntities(result)

  // 6. Clean up whitespace
  result = cleanupWhitespace(result)

  return result
}

function extractMainContent(html: string): string {
  // Try <article> first
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
  if (articleMatch) return articleMatch[1]

  // Try <main>
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  if (mainMatch) return mainMatch[1]

  // Try common content divs
  const contentMatch = html.match(
    /<(?:div|section)[^>]*(?:class|id)=["'](?:content|main|article|post|entry|docs)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i
  )
  if (contentMatch) return contentMatch[1]

  // Try <body>
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) return bodyMatch[1]

  return html
}

function removeUnwantedElements(html: string): string {
  // Remove tags and their contents
  const removeTags = ['nav', 'footer', 'script', 'style', 'aside', 'noscript']
  for (const tag of removeTags) {
    html = html.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
  }
  // Remove self-closing elements
  html = html.replace(/<link[^>]*\/?>/gi, '')
  html = html.replace(/<meta[^>]*\/?>/gi, '')
  return html
}

function convertHeadings(html: string): string {
  for (let i = 6; i >= 1; i--) {
    const regex = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi')
    html = html.replace(regex, (_, content) => {
      const text = stripInlineTags(content).trim()
      return `\n\n${'#'.repeat(i)} ${text}\n\n`
    })
  }
  return html
}

function convertCodeBlocks(html: string): string {
  // Handle <pre><code class="language-xxx">...</code></pre>
  return html.replace(
    /<pre[^>]*><code(?:[^>]*class=["'](?:language-)?(\w+)["'][^>]*)?[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    (_, lang, code) => {
      const decoded = decodeHtmlEntities(code)
      const fence = lang ? `\`\`\`${lang}\n${decoded}\n\`\`\`` : `\`\`\`\n${decoded}\n\`\`\``
      return `\n\n${fence}\n\n`
    }
  )
}

function convertInlineCode(html: string): string {
  return html.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, content) => {
    const decoded = decodeHtmlEntities(content)
    return `\`${decoded}\``
  })
}

function convertLinks(html: string): string {
  return html.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const cleanText = stripInlineTags(text).trim()
    if (!cleanText) return ''
    // Skip nav/skip links
    if (
      href.startsWith('#') &&
      (cleanText.toLowerCase().includes('skip') || cleanText.length < 2)
    ) {
      return ''
    }
    return `[${cleanText}](${href})`
  })
}

function convertLists(html: string): string {
  // Ordered lists
  html = html.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
    const items = processListItems(content, true)
    return `\n${items}\n`
  })

  // Unordered lists
  html = html.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
    const items = processListItems(content, false)
    return `\n${items}\n`
  })

  return html
}

function processListItems(content: string, ordered: boolean): string {
  const items: string[] = []
  const itemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi
  let match: RegExpExecArray | null
  let idx = 1

  while ((match = itemRegex.exec(content)) !== null) {
    const text = stripInlineTags(match[1]).trim()
    if (text) {
      const prefix = ordered ? `${idx}.` : '-'
      // Handle multi-line — indent continuation lines
      const lines = text.split('\n')
      const first = `${prefix} ${lines[0]}`
      const rest = lines
        .slice(1)
        .map((l) => `  ${l}`)
        .join('\n')
      items.push(rest ? `${first}\n${rest}` : first)
      idx++
    }
  }

  return items.join('\n')
}

function convertEmphasis(html: string): string {
  html = html.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**')
  html = html.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*')
  return html
}

function convertTables(html: string): string {
  return html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, content) => {
    // Extract rows
    const rows: string[][] = []
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
    let trMatch: RegExpExecArray | null

    while ((trMatch = trRegex.exec(content)) !== null) {
      const cells: string[] = []
      const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi
      let cellMatch: RegExpExecArray | null

      while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
        cells.push(stripInlineTags(cellMatch[1]).trim())
      }
      if (cells.length > 0) rows.push(cells)
    }

    if (rows.length < 2) return '' // Skip trivial tables

    const colCount = Math.max(...rows.map((r) => r.length))
    const padded = rows.map((r) => {
      while (r.length < colCount) r.push('')
      return r
    })

    const header = padded[0]
    const separator = header.map(() => '---')
    const body = padded.slice(1)

    const mdRows = [
      `| ${header.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...body.map((r) => `| ${r.join(' | ')} |`)
    ]

    return `\n\n${mdRows.join('\n')}\n\n`
  })
}

function convertImages(html: string): string {
  return html.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, (_, alt) => {
    if (alt && alt.trim()) return `[Image: ${alt.trim()}]`
    return ''
  })
}

function convertParagraphs(html: string): string {
  // Replace <p> and <br> with newlines
  html = html.replace(/<p[^>]*>/gi, '\n\n')
  html = html.replace(/<\/p>/gi, '')
  html = html.replace(/<br\s*\/?>/gi, '\n')
  html = html.replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
  html = html.replace(/<\/(?:div|section|article)>/gi, '\n\n')
  return html
}

function stripRemainingTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

function stripInlineTags(text: string): string {
  return text.replace(/<[^>]+>/g, '')
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
}

function cleanupWhitespace(text: string): string {
  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n')
  // Remove trailing whitespace on lines
  text = text.replace(/[ \t]+$/gm, '')
  // Trim
  text = text.trim()
  return text
}
