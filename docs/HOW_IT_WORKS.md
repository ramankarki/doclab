# How doclab Works — A Beginner's Guide

If you've never worked with search engines, embeddings, or vector databases before — this is for you. We'll walk through what doclab does step by step, in plain English.

---

## The Problem doclab Solves

You're coding. You need to use Hono's CORS middleware. You ask your AI coding agent. It writes:

```ts
app.use(cors())
```

But Hono v4 changed the API. The correct code is:

```ts
app.use('*', cors())
```

Your agent didn't know because its training data is frozen in time.

**doclab fixes this.** It downloads the latest Hono docs, stores them locally, and lets your agent search them — getting current, correct information every time.

---

## The Big Picture

When you run `doclab add https://hono.dev/llms-full.txt`, here's what happens behind the scenes:

```
1. Fetch     Download the page
2. Clean     Convert HTML to readable markdown  
3. Chunk     Split into small, self-contained pieces
4. Embed     Turn each piece into a list of numbers
5. Store     Save everything in a database
6. Search    Find the right piece when asked
```

Let's go through each step.

---

## Step 1: Fetch — Download the Page

doclab visits the URL you gave it and downloads the content. Just like your browser does.

```ts
const response = await fetch("https://hono.dev/llms-full.txt")
const raw = await response.text()
```

If the page is already markdown (`.md` or `.txt`), we're done with this step. If it's HTML (a web page), we need to clean it up.

Some websites are "Single Page Apps" (SPAs) — the content only loads after JavaScript runs. doclab detects these and uses a service called Jina AI to render the page before downloading.

---

## Step 2: Clean — HTML to Markdown

Raw HTML looks like this:

```html
<html>
  <head><title>Hono Docs</title></head>
  <body>
    <nav><a href="/">Home</a></nav>
    <article>
      <h1>CORS Middleware</h1>
      <p>Use <code>cors()</code> to handle cross-origin requests.</p>
      <pre><code>import { cors } from 'hono/cors'</code></pre>
      <table>
        <tr><th>Option</th><th>Type</th></tr>
        <tr><td>origin</td><td>string</td></tr>
      </table>
    </article>
    <footer>Copyright 2025</footer>
  </body>
</html>
```

doclab cleans this up using a library called **turndown**:

1. Removes useless parts: `<nav>`, `<footer>`, `<script>`, `<style>`
2. Converts HTML tags to markdown:
   - `<h1>` → `# Heading`
   - `<p>` → plain text
   - `<table>` → `| col | col |` pipe table
   - `<pre><code>` → ` ``` code ``` `
   - `<a href="...">` → `[text](url)`
   - `<code>` → `` `code` ``
   - `<strong>` → `**bold**`

Result — clean, readable markdown:

~~~markdown
# CORS Middleware

Use `cors()` to handle cross-origin requests.

```ts
import { cors } from 'hono/cors'
```

| Option | Type   |
| ------ | ------ |
| origin | string |
~~~

---

## Step 3: Chunk — Split into Pieces

You can't search a 300KB document as one giant block. Imagine searching a 500-page book by reading the whole thing every time. Instead, you'd flip to the right chapter.

Chunking splits the document into small, self-contained sections.

### How splitting works

doclab looks at the markdown headings:

```markdown
# Hono Documentation

## Middleware                          ← h2: becomes a section
Some intro text about middleware...

### CORS Middleware                    ← h3: sub-section of Middleware
Content about CORS...

### Basic Auth                         ← h3: another sub-section
Content about basic auth...

## Routing                             ← h2: another top-level section
Content about routing...
```

**Rule 1: Split on `##` (h2) headers.** Each becomes its own chunk candidate.

**Rule 2: If a section is too big (>2500 characters), split deeper.** Look for `###` (h3) headers inside it.

**Rule 3: If still too big, split on `####` (h4).**

**Rule 4: If still too big and no more headers, split on paragraph breaks.** But NEVER split in the middle of a code block. doclab checks: "is this split point inside ` ``` ` marks?" If yes, it keeps those paragraphs together.

**Rule 5: Merge tiny neighbors.** If splitting creates chunks under 200 characters, merge them with adjacent chunks. Also, adjacent chunks get packed together up to ~2250 characters (90% of the 2500 target) to reduce fragmentation.

### What each chunk contains

```ts
{
  header: "CORS Middleware",                           // the section title
  sectionPath: "hono > Middleware > CORS Middleware",  // breadcrumb trail
  content: "### CORS Middleware\n\nUse `cors()`...",   // the actual markdown
  hasCodeBlocks: true                                   // does it contain code?
}
```

The `sectionPath` is like a breadcrumb — it tells you exactly where in the docs this chunk came from. The `header` is the heading text. The `content` is the markdown for that section.

A 300KB document might become anywhere from 100 to 2000 chunks, depending on how it's structured.

---

## Step 4: Embed — Turn Text into Numbers

This is the most important step. Embeddings are the "magic" that makes semantic search work.

### What's an embedding?

An embedding is a list of 768 numbers that represents what a piece of text is *about*.

```
"CORS middleware for Hono"     → [0.12, -0.45, 0.78, ..., 0.33]  (768 numbers)
"Authentication in Hono"       → [0.09, -0.42, 0.81, ..., 0.29]  (768 numbers)  
"Banana bread recipe"          → [-0.89, 0.21, -0.15, ..., 0.67] (768 numbers)
```

Here's the key insight: **similar text produces similar numbers.** The first two examples are close together in number-space (both about web frameworks). The banana bread vector is far away.

### How doclab embeds

doclab takes each chunk and combines the section path + header + content into one string:

```ts
// What gets embedded:
"hono > Middleware > Basic Auth\nBasic Auth\n\nUse basic authentication to protect routes..."

// sectionPath gives the embedding model location context:
// "where in the docs is this chunk?" → better vector placement
```

It sends this text to **Ollama**, a program running on your computer that hosts AI models. Specifically, it uses a model called `nomic-embed-text` which is trained to convert text to embeddings.

```ts
const embedTexts = chunks.map(c => `${c.sectionPath}\n${c.header}\n\n${c.content}`)
const embeddings = await ollama.embed(embedTexts)
```

Ollama returns a list of 768 numbers for each chunk. No internet needed — it all runs locally.

### Why 768 numbers?

The `nomic-embed-text` model was trained to map text into a 768-dimensional space. Each dimension represents some abstract feature of the text — things like "is this about programming?", "is this about authentication?", "is this a tutorial or reference?". We don't know exactly what each dimension means. The model learned these from millions of examples.

### Same model, same "world"

This is critical: **every chunk and every search query must use the same embedding model.** Think of the model as defining a shared coordinate system — like a giant map where every document gets a location. If you used a different model for chunks vs queries, their vectors would live in different "worlds" — like trying to measure distance between a point on a map of Paris and a point on a map of Tokyo. Same model = same coordinate system = meaningful distance comparisons.

Here's a simplified 3D view (real version has 768 dimensions):

~~~
         ↑ middleware axis
         |
         |  ● "CORS Middleware" (chunk 42)
         |  ● "Basic Auth" (chunk 43)
         |
         |                    ● "Select schema" (drizzle chunk 7)
         |
         └──────────────────────────→ database axis
~~~

"CORS Middleware" and "Basic Auth" are neighbors (both Hono middleware). "Select schema" is far away (different domain — database queries). When you later search for "hono cors", your query gets placed in this same space and finds its neighbors.

---

## Step 5: Store — Save to Database

Now we save everything to SQLite — a single file on your computer.

### The chunks table

```
┌────┬────────┬──────────────────────────┬────────────────────────┐
│ id │ source │ section_path             │ header                 │
├────┼────────┼──────────────────────────┼────────────────────────┤
│ 1  │ hono   │ Middleware > CORS        │ CORS Middleware        │
│ 2  │ hono   │ Middleware > Basic Auth  │ Basic Auth             │
│ 3  │ drizzle │ Select > schema         │ Select schema          │
└────┴────────┴──────────────────────────┴────────────────────────┘
```

Each row links to its embedding stored in a special vector index (sqlite-vec):

```
vec0 virtual table (one row per chunk)
┌────────┬──────────────────────────────────────┐
│ rowid  │ embedding (768 floats)                │
├────────┼──────────────────────────────────────┤
│ 1      │ [0.12, -0.45, 0.78, ..., 0.33]      │
│ 2      │ [0.09, -0.42, 0.81, ..., 0.29]      │
│ 3      │ [-0.89, 0.21, -0.15, ..., 0.67]     │
└────────┴──────────────────────────────────────┘
```

sqlite-vec lets us do fast "find nearest neighbors" searches — give it a vector, it finds the most similar ones in milliseconds.

---

## Step 6: Search — Find the Right Chunk

You type `doclab search "hono cors configuration"`. Here's what happens:

### 6a. Turn your query into an embedding

Your query goes through the same embedding process as chunks (Step 4). Same model, same 768-dimensional space.

```ts
// src/server.ts — handleSearch
const embeddings = await state.embedder.embedBatch(["hono cors configuration"])
const queryEmbedding = embeddings[0]
// → Float32Array(768): [0.11, -0.43, 0.79, 0.02, -0.55, ..., 0.31]
```

This places your query into the same coordinate system as your indexed chunks — right near "CORS Middleware" and "Basic Auth", far from "Select schema".

**One difference from chunk embedding:** chunks get `sectionPath + header + content` so the model understands where the section lives in the documentation hierarchy. Queries are just raw text — what the user typed. The query IS the context, so there's nothing to prepend.

```ts
// Chunk embedding (Step 4):
"CORS Middleware\n\nUse `cors()` to handle..."

// Query embedding (Step 6):
"hono cors configuration"
```

### 6b. Vector search — find similar chunks

sqlite-vec finds chunks whose embeddings are closest to your query:

```sql
SELECT chunks.*, distance(embedding, queryEmbedding)
FROM chunks JOIN vec0 ON chunks.id = vec0.rowid  
ORDER BY distance ASC
LIMIT 10
```

"Distance" means how far apart two vectors are. Smaller distance = more similar.

This finds chunks that are *semantically* related — even if they don't contain the exact words you typed. A query for "cors config" might find a chunk titled "Cross-Origin Resource Sharing Options" because the embeddings are similar.

But vector search has a weakness: it might miss exact API names, function signatures, or error codes.

### 6c. Keyword search — find exact matches

At the same time, doclab runs a keyword search using **FTS5** (SQLite's full-text search engine) with **BM25 ranking**:

```sql
SELECT *, bm25(chunks_fts, 1.0, 0.5, 0.25) AS rank
FROM chunks_fts
WHERE chunks_fts MATCH 'cors OR middleware OR configuration'
ORDER BY rank
```

**BM25** is a statistical ranking formula:

```
BM25 score = term_frequency × inverse_doc_frequency ÷ document_length
```

- **Term frequency**: "cors" appears 8 times in this chunk? Higher score.
- **Inverse doc frequency**: "cors" appears in only 3 out of 1000 chunks? Rare = important.
- **Document length**: Short chunk? Higher density = higher score.

The column weights (`1.0, 0.5, 0.25`) mean: matches in `content` count fully, `header` at half weight, `section_path` at quarter weight. This replaces the old `LIKE '%word%'` approach which had no real ranking — just substring matching.

### 6d. Merge the results

Both searches return ranked lists. doclab combines them using **weighted Reciprocal Rank Fusion (RRF)** with quality gates:

```
Vector contribution  = 0.6 / (60 + vector_rank)    ← semantic similarity matters more
Keyword contribution = 0.4 / (60 + keyword_rank)   ← exact terms are supplementary
```

Vector search carries more weight (0.6 vs 0.4) because semantic understanding is the stronger signal. But keyword search catches exact API names and function signatures that embeddings might miss.

**Distance penalty:** When vector search finds a chunk but with poor semantic distance (above 0.5), the keyword contribution is penalized. This prevents coincidental word overlap from dominating. For example, a query for "project structure best practices" won't rank a page about "HEAD Request Best Practices" just because both contain the words "best" and "practices" — the vector distance tells us it's not actually about project structure.

**Mutual confirmation boost (1.3×):** When both vector AND keyword independently find the same chunk AND the vector distance is strong (≤ 0.3), the score gets boosted. This rewards chunks that are both semantically relevant AND contain the query terms. But only when the vector is confident — if vector distance is weak, the overlap is probably coincidental and no boost is applied.

Example scores:
- A chunk ranked #1 in vector (distance 0.08) and #3 in keyword → `0.6/61 + 0.4/64 = 0.016` → boosted to `0.021`
- A chunk ranked #1 in keyword but #45 in vector (distance 0.80) → keyword contribution penalized to `0.08/61 = 0.001` → total `0.008` → falls behind more relevant results

### 6e. Return results

```json
{
  "results": [
    {
      "header": "CORS Middleware",
      "sectionPath": "hono > Middleware > CORS Middleware",
      "content": "### CORS Middleware\n\nUse `cors()` with options...",
      "source": "hono",
      "fusionScore": 0.032
    }
  ],
  "queryTimeMs": 34,
  "degraded": false
}
```

`queryTimeMs: 34` means the whole search took 34 milliseconds. `degraded: false` means both vector and keyword search are working. If Ollama is offline, it falls back to keyword-only and sets `degraded: true`.

---

## The Full Loop — Adding a Real Source

Let's trace what happens when you add real documentation:

```bash
doclab add https://hono.dev/llms-full.txt
```

| Step | What happens | Result |
|------|-------------|--------|
| **Fetch** | Download llms-full.txt | 580KB of markdown |
| **Clean** | Already markdown, skip HTML conversion | No change |
| **Chunk** | Split on h2→h3→h4 headers, paragraph fallback | 382 chunks |
| **Embed** | Send each chunk to Ollama (`nomic-embed-text`) | 382 vectors of 768 numbers |
| **Store** | Insert into SQLite + sqlite-vec | ~27MB on disk |
| **Search** | Hybrid vector + keyword | Results in 34ms |

---

## Why This Design?

| Decision | Reason |
|----------|--------|
| **Markdown, not HTML** | Clean text, predictable structure. Headings (`##`) make chunking easy. |
| **Semantic chunks, not fixed-size** | A section about CORS is one idea. Splitting it mid-sentence would lose context. |
| **Section path + header + content embedded** | The section path and header give context ("hono > Middleware > CORS") that helps the embedding understand where the chunk lives. |
| **Hybrid search, not just vector** | Vector search is great for concepts. But if you search for `cors()`, you want the exact function — keyword search catches that. |
| **Local, not cloud** | No API costs. No internet required. Your docs stay on your machine. 34ms latency because there's no network round-trip. |
| **SQLite, not Elasticsearch** | One file. Zero setup. WAL mode handles concurrent reads. sqlite-vec adds vector search without leaving SQLite. |

---

## Glossary

| Term | What it means |
|------|---------------|
| **Chunk** | A small, self-contained piece of a document. Usually one section with its heading. |
| **Embedding** | A list of 768 numbers that represents what text is "about". Similar text = similar numbers. |
| **Vector** | Same as embedding. A point in 768-dimensional space. |
| **Distance** | How far apart two vectors are. Smaller = more similar. |
| **sqlite-vec** | A SQLite extension for vector search. Lets you do "find nearest" queries. |
| **Hybrid search** | Combining two search methods (vector + keyword) for better results. |
| **RRF** | Reciprocal Rank Fusion. A math formula that merges two ranked lists into one. doclab uses weighted RRF (vector 0.6, keyword 0.4) with a distance-based quality gate to prevent coincidental keyword matches from outranking semantically relevant results. |
| **Ollama** | A program that runs AI models on your computer. doclab uses it for embeddings. |
| **turndown** | A JavaScript library that converts HTML to clean markdown. |
| **GFM** | GitHub Flavored Markdown — markdown with table support, task lists, strikethrough. |
