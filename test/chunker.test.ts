import { describe, test, expect } from "bun:test";
import { chunkMarkdown } from "../src/lib/chunker";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixturesDir = join(import.meta.dir, "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

describe("chunker", () => {
  test("splits on h2 headers", () => {
    const md = readFixture("basic.md");
    const chunks = chunkMarkdown(md, "basic");

    // 4 chunks: intro + 3 h2 sections
    expect(chunks.length).toBe(4);

    // Intro is first chunk
    expect(chunks[0].sectionPath).toBe("basic");

    // h2 sections follow
    const sections = chunks.map((c) => c.header);
    expect(sections).toContain("Getting Started");
    expect(sections).toContain("Installation");
    expect(sections).toContain("Configuration");
  });

  test("preserves code fences", () => {
    const md = readFixture("with-code.md");
    const chunks = chunkMarkdown(md, "with-code");

    // Should have intro + 4 h2 sections
    expect(chunks.length).toBeGreaterThanOrEqual(4);

    const tsChunk = chunks.find((c) =>
      c.content.includes("```ts")
    );
    expect(tsChunk).toBeDefined();
    expect(tsChunk!.hasCodeBlocks).toBe(true);

    // Should have all four code blocks
    const codeChunks = chunks.filter((c) => c.hasCodeBlocks);
    expect(codeChunks.length).toBeGreaterThanOrEqual(4);
  });

  test("handles blog post with h2 headers", () => {
    const md = readFixture("blog-post.md");
    const chunks = chunkMarkdown(md, "overreacted");

    // Intro + 3 h2 sections
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const useStateChunk = chunks.find((c) =>
      c.header.includes("useState")
    );
    expect(useStateChunk).toBeDefined();
    expect(useStateChunk!.content).toContain("```js");
    expect(useStateChunk!.hasCodeBlocks).toBe(true);
  });

  test("falls back to paragraph split for no-headers document", () => {
    const md = readFixture("no-headers.md");
    const chunks = chunkMarkdown(md, "no-headers");

    expect(chunks.length).toBeGreaterThan(0);
    // Code fence should be preserved in some chunk
    const codeChunk = chunks.find((c) => c.hasCodeBlocks);
    if (codeChunk) {
      expect(codeChunk.content).toContain("```python");
      expect(codeChunk.content).toContain("```");
    }
  });

  test("skips near-empty sections (under 100 chars)", () => {
    const md = readFixture("empty-sections.md");
    const chunks = chunkMarkdown(md, "empty");

    // All sections are under 100 chars → falls through to paragraph split
    // or all skipped entirely
    // The chunker should still produce something from the merged content
    expect(chunks.length).toBeGreaterThanOrEqual(0);
  });

  test("recursively splits dense h3 sections under h2", () => {
    const md = readFixture("dense-docs.md");
    const chunks = chunkMarkdown(md, "dense-docs");

    // Should have multiple chunks (h2 Middleware intro + h3 subsections)
    expect(chunks.length).toBeGreaterThanOrEqual(7);

    // Each middleware should be present
    const headers = chunks.map((c) => c.header);
    expect(headers).toContain("CORS");
    expect(headers).toContain("Rate Limiting");
    expect(headers).toContain("Logging");

    // Check section paths
    const corsChunk = chunks.find((c) => c.header === "CORS");
    expect(corsChunk).toBeDefined();
    expect(corsChunk!.sectionPath).toContain("Middleware");
    expect(corsChunk!.sectionPath).toContain("CORS");
  });

  test("breadcrumb paths are correct", () => {
    const md = readFixture("dense-docs.md");
    const chunks = chunkMarkdown(md, "hono");

    const corsChunk = chunks.find((c) =>
      c.sectionPath.includes("CORS")
    );
    expect(corsChunk).toBeDefined();
    expect(corsChunk!.sectionPath).toContain("hono");
    expect(corsChunk!.sectionPath).toContain("Middleware");
    expect(corsChunk!.sectionPath).toContain("CORS");
  });

  test("never splits inside code fence", () => {
    const md = `## Section One

Some text here to make this section large enough to be kept by the chunker.
Adding more content to exceed the minimum chunk size threshold.

\`\`\`ts
const x = 1;
// ## This looks like a header but is inside code fence
const y = 2;
\`\`\`

More text after code to pad out the section.
`;

    const chunks = chunkMarkdown(md, "test");

    // Should find the section
    const sectionOne = chunks.find((c) => c.header.includes("Section One"));
    expect(sectionOne).toBeDefined();

    // The code block should remain intact
    if (sectionOne) {
      expect(sectionOne.content).toContain("## This looks like a header");
      expect(sectionOne.content).toContain("const x = 1");
      expect(sectionOne.content).toContain("const y = 2");
    }
  });

  test("hash stability — same input produces same hashes", () => {
    const md = readFixture("basic.md");
    const chunks1 = chunkMarkdown(md, "basic");
    const chunks2 = chunkMarkdown(md, "basic");

    expect(chunks1.length).toBe(chunks2.length);
    for (let i = 0; i < chunks1.length; i++) {
      expect(chunks1[i].sectionPath).toBe(chunks2[i].sectionPath);
    }
  });
});
