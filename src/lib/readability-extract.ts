/**
 * Content extraction via Mozilla Readability.
 *
 * Extracts main article/content from HTML pages, stripping
 * navigation, sidebars, ads, and boilerplate automatically.
 * Falls back to raw HTML if Readability can't parse the page.
 */

import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

export function extractContent(html: string): string {
  try {
    const { document } = parseHTML(html)

    // Readability needs getBoundingClientRect on elements — mock it
    // (linkedom doesn't provide layout APIs)
    patchForReadability(document)

    const reader = new Readability(document)
    const article = reader.parse()

    if (article?.textContent && article.textContent.length > 100) {
      // Reconstruct minimal HTML from extracted content
      // Readability gives us textContent and content (HTML string)
      if (article.content) {
        return article.content
      }
      // Fallback: wrap text content in basic structure
      const title = article.title ? `<h1>${article.title}</h1>\n` : ''
      return `<!DOCTYPE html><html><body>${title}${article.textContent}</body></html>`
    }
  } catch (e) {
    // Readability failed — fall through to raw HTML
  }

  // Fallback: return original HTML
  return html
}

/**
 * Patch linkedom document to support Readability's DOM requirements.
 * Readability uses getBoundingClientRect to check element visibility.
 * linkedom doesn't provide layout APIs — we mock them.
 */
function patchForReadability(document: any): void {
  // Mock getBoundingClientRect on Element prototype
  const ElementProto = document.defaultView?.Element?.prototype
  if (ElementProto && !ElementProto.getBoundingClientRect) {
    ElementProto.getBoundingClientRect = function () {
      return {
        width: 100,
        height: 20,
        top: 0,
        left: 0,
        bottom: 20,
        right: 100,
        x: 0,
        y: 0,
        toJSON() {
          return this
        }
      }
    }
  }
}
