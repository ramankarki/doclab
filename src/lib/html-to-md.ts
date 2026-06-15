/**
 * HTML → Markdown converter using turndown + GFM plugin.
 *
 * Handles documentation pages, blog posts, API references, and specs.
 * turndown preserves code fences, headings, tables (via GFM), and links.
 * Strips nav, footer, script, style, and aside before conversion.
 */

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
})
turndown.use(gfm)

// Skip empty anchor tags (ReSpec self-links, empty nav links)
// <a href="#section"></a> → nothing (not even [](#section))
turndown.addRule('emptyAnchor', {
  filter: (node, options) => {
    return node.nodeName === 'A' &&
      (node.textContent?.trim() ?? '') === ''
  },
  replacement: () => ''
})

// Preserve Tab component labels from framework-specific doc markup
// <Tab value="hono">code</Tab> → **Tab: hono**\ncode
turndown.addRule('tab', {
  filter: (node) => {
    return node.nodeName === 'TAB' ||
      (node.nodeName === 'DIV' && node.getAttribute('data-component-part') === 'tab-content')
  },
  replacement: (content, node) => {
    const label = (node as HTMLElement).getAttribute?.('value') ||
      (node as HTMLElement).getAttribute?.('data-value') || ''
    const prefix = label ? `**Tab: ${label.trim()}**\n` : ''
    return `\n${prefix}${content}\n`
  }
})

export function htmlToMarkdown(html: string): string {
  // Extract body content if present, otherwise use full HTML
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  let content = bodyMatch ? bodyMatch[1] : html

  // Strip elements that are never useful for search/context
  const removeTags = ['nav', 'footer', 'script', 'style', 'aside', 'noscript']
  for (const tag of removeTags) {
    content = content.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
  }

  return turndown.turndown(content)
}
