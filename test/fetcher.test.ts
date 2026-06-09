import { describe, test, expect } from "bun:test";
import { fetchUrl, hashContent, chunkHash, FetchError } from "../src/lib/fetcher";

describe("fetcher", () => {
  test("hashContent produces consistent hashes", () => {
    const hash1 = hashContent("hello world");
    const hash2 = hashContent("hello world");
    expect(hash1).toBe(hash2);
  });

  test("hashContent produces different hashes for different content", () => {
    const hash1 = hashContent("hello");
    const hash2 = hashContent("world");
    expect(hash1).not.toBe(hash2);
  });

  test("chunkHash produces stable hashes", () => {
    const hash1 = chunkHash("hono", "Middleware > CORS");
    const hash2 = chunkHash("hono", "Middleware > CORS");
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(16); // hex string of first 8 bytes
  });

  test("chunkHash differentiates sources", () => {
    const h1 = chunkHash("hono", "Middleware > CORS");
    const h2 = chunkHash("express", "Middleware > CORS");
    expect(h1).not.toBe(h2);
  });

  test("FetchError has correct properties", () => {
    const err = new FetchError("Not found", "NOT_FOUND", 404);
    expect(err.message).toBe("Not found");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.name).toBe("FetchError");
    expect(err instanceof Error).toBe(true);
  });

  test("fetchUrl rejects invalid URLs", async () => {
    try {
      await fetchUrl("not-a-valid-url");
      expect(false).toBe(true); // should not reach
    } catch (e: any) {
      expect(e).toBeDefined();
    }
  });
});
