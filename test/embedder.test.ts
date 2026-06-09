import { describe, test, expect } from "bun:test";
import { Embedder } from "../src/lib/embedder";
import type { EmbeddingConfig } from "../src/types";

describe("embedder", () => {
  test("creates embedder with ollama provider", () => {
    const config: EmbeddingConfig = {
      provider: "ollama",
      model: "nomic-embed-text",
      ollamaUrl: "http://localhost:11434",
    };

    const embedder = new Embedder(config);
    expect(embedder.provider).toBe("ollama");
    expect(embedder.model).toBe("nomic-embed-text");
  });

  test("creates embedder with openai provider", () => {
    const config: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
    };

    const embedder = new Embedder(config);
    expect(embedder.provider).toBe("openai");
    expect(embedder.model).toBe("text-embedding-3-small");
  });

  test("creates embedder with voyage provider", () => {
    const config: EmbeddingConfig = {
      provider: "voyage",
      model: "voyage-3-lite",
      apiKey: "vp-test",
    };

    const embedder = new Embedder(config);
    expect(embedder.provider).toBe("voyage");
    expect(embedder.model).toBe("voyage-3-lite");
  });

  test("uses default model when not specified", () => {
    const config: EmbeddingConfig = {
      provider: "ollama",
    };

    const embedder = new Embedder(config);
    expect(embedder.model).toBe("nomic-embed-text");
  });

  test("getDimensions returns cached value after first call", async () => {
    const config: EmbeddingConfig = {
      provider: "openai",
      apiKey: "sk-test",
    };

    const embedder = new Embedder(config);
    const dims = await embedder.getDimensions();
    expect(dims).toBe(1536);

    // Second call should return cached
    const dims2 = await embedder.getDimensions();
    expect(dims2).toBe(1536);
  });

  test("detect returns reachable false for ollama when unreachable", async () => {
    const config: EmbeddingConfig = {
      provider: "ollama",
      model: "nomic-embed-text",
      ollamaUrl: "http://localhost:19999", // non-existent port
    };

    const embedder = new Embedder(config);
    const info = await embedder.detect();

    expect(info.reachable).toBe(false);
    expect(info.provider).toBe("ollama");
  });

  test("embedBatch handles empty array", async () => {
    const config: EmbeddingConfig = {
      provider: "ollama",
    };

    const embedder = new Embedder(config);
    const results = await embedder.embedBatch([]);
    expect(results.length).toBe(0);
  });
});
