import { describe, test, expect } from 'bun:test'
import { htmlToMarkdown } from '../src/lib/html-to-md'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fixturesDir = join(import.meta.dir, 'fixtures')

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('htmlToMarkdown', () => {
  test('converts headings', () => {
    const html = '<h1>Title</h1><h2>Section</h2><h3>Subsection</h3>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('# Title')
    expect(md).toContain('## Section')
    expect(md).toContain('### Subsection')
  })

  test('converts code blocks with language', () => {
    const html = '<pre><code class="language-ts">const x = 1;</code></pre>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('```ts')
    expect(md).toContain('const x = 1;')
    expect(md).toContain('```')
  })

  test('converts inline code', () => {
    const html = '<p>Use the <code>app.use()</code> method</p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('`app.use()`')
  })

  test('converts links', () => {
    const html = '<a href="https://example.com">Example</a>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('[Example](https://example.com)')
  })

  test('removes nav and footer', () => {
    const html = `
      <nav><a href="/">Home</a></nav>
      <article><h1>Content</h1><p>Hello</p></article>
      <footer>Copyright</footer>
    `
    const md = htmlToMarkdown(html)
    expect(md).not.toContain('Home')
    expect(md).not.toContain('Copyright')
    expect(md).toContain('# Content')
    expect(md).toContain('Hello')
  })

  test('extracts article content', () => {
    const html = readFixture('sample.html')
    const md = htmlToMarkdown(html)

    // Should have the title
    expect(md).toContain('Why Do React Hooks Rely on Call Order?')

    // Should have code block
    expect(md).toContain('```js')
    expect(md).toContain('function useState')

    // Should not have nav content
    expect(md).not.toContain('Archive')

    // Should not have footer content
    expect(md).not.toContain('2019 Dan Abramov')
  })

  test('converts lists', () => {
    const html = `
      <ul>
        <li>First item</li>
        <li>Second item</li>
      </ul>
    `
    const md = htmlToMarkdown(html)
    expect(md).toContain('*   First item')
    expect(md).toContain('*   Second item')
  })

  test('converts emphasis', () => {
    const html = '<p>This is <strong>bold</strong> and <em>italic</em></p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('**bold**')
    expect(md).toContain('_italic_')
  })

  test('handles HTML entities', () => {
    const html = '<p>x &lt; y &amp;&amp; z &gt; w</p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('x < y && z > w')
  })

  test('converts simple tables', () => {
    const html = `
      <table>
        <tr><th>Name</th><th>Age</th></tr>
        <tr><td>Alice</td><td>30</td></tr>
        <tr><td>Bob</td><td>25</td></tr>
      </table>
    `
    const md = htmlToMarkdown(html)
    expect(md).toContain('| Name | Age |')
    expect(md).toContain('| --- | --- |')
    expect(md).toContain('| Alice | 30 |')
    expect(md).toContain('| Bob | 25 |')
  })

  test('preserves Tab component labels and content', () => {
    const html = `
      <div>
        <Tab value="hono">
          app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
        </Tab>
        <Tab value="express">
          app.use("/api/auth/*", authHandler());
        </Tab>
        <p>Some text</p>
      </div>
    `
    const md = htmlToMarkdown(html)
    // Tab labels preserved as bold markers
    expect(md).toContain('**Tab: hono**')
    expect(md).toContain('**Tab: express**')
    // Code content preserved
    // turndown escapes special markdown chars [ ] inside code
    expect(md).toContain('app.on(\\[')
    expect(md).toContain('auth.handler(c.req.raw)')
    expect(md).toContain('app.use(')
    expect(md).toContain('authHandler()')
    // Non-tab content still present
    expect(md).toContain('Some text')
  })
})
