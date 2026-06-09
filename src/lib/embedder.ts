/**
 * Multi-provider embedding abstraction
 *
 * Supports: Ollama (default), OpenAI, Voyage
 * Handles: batch embedding, dimension detection, error retry
 */

import { ollamaEmbed, checkOllama } from "./ollama";
import type { EmbeddingConfig } from "../types";

const BATCH_SIZE = 100; // Ollama batch limit
const OPENAI_BATCH = 2048;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // ms

export interface EmbedderInfo {
  provider: string;
  model: string;
  dimensions: number;
  reachable: boolean;
}

export class Embedder {
  private config: EmbeddingConfig;
  private _dimensions: number | null = null;

  constructor(config: EmbeddingConfig) {
    this.config = config;
  }

  get provider(): string {
    return this.config.provider;
  }

  get model(): string {
    return (
      this.config.model ??
      (this.config.provider === "ollama"
        ? "nomic-embed-text"
        : this.config.provider === "openai"
          ? "text-embedding-3-small"
          : "voyage-3-lite")
    );
  }

  async detect(): Promise<EmbedderInfo> {
    if (this.config.provider === "ollama") {
      const ollamaUrl = this.config.ollamaUrl ?? "http://localhost:11434";
      const status = await checkOllama(ollamaUrl);

      if (!status.reachable) {
        return {
          provider: "ollama",
          model: this.model,
          dimensions: 0,
          reachable: false,
        };
      }

      // Check if model exists
      const modelExists = status.models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`)
      );

      if (!modelExists) {
        return {
          provider: "ollama",
          model: this.model,
          dimensions: 0,
          reachable: false,
        };
      }

      // Detect dimensions
      try {
        const dims = await this.getDimensions();
        return {
          provider: "ollama",
          model: this.model,
          dimensions: dims,
          reachable: true,
        };
      } catch {
        return {
          provider: "ollama",
          model: this.model,
          dimensions: 768, // assume default
          reachable: true,
        };
      }
    }

    // OpenAI / Voyage — check API key
    const apiKey = resolveApiKey(this.config.apiKey);
    if (!apiKey) {
      return {
        provider: this.config.provider,
        model: this.model,
        dimensions: this.config.provider === "openai" ? 1536 : 512,
        reachable: false,
      };
    }

    return {
      provider: this.config.provider,
      model: this.model,
      dimensions: this.config.provider === "openai" ? 1536 : 512,
      reachable: true,
    };
  }

  async getDimensions(): Promise<number> {
    if (this._dimensions) return this._dimensions;

    if (this.config.provider === "ollama") {
      // Embed a test string to get dimensions
      const embeds = await this.embedBatch(["test"]);
      this._dimensions = embeds[0].length;
    } else if (this.config.provider === "openai") {
      this._dimensions = 1536;
    } else {
      this._dimensions = 512;
    }

    return this._dimensions!;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Split into batches
    const batchSize =
      this.config.provider === "ollama" ? BATCH_SIZE : OPENAI_BATCH;
    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await this.embedWithRetry(batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async embedWithRetry(texts: string[]): Promise<Float32Array[]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (this.config.provider === "ollama") {
          const ollamaUrl =
            this.config.ollamaUrl ?? "http://localhost:11434";
          return await ollamaEmbed(texts, this.model, ollamaUrl);
        } else if (this.config.provider === "openai") {
          return await openaiEmbed(texts, this.model, this.config.apiKey!);
        } else {
          return await voyageEmbed(texts, this.model, this.config.apiKey!);
        }
      } catch (e: any) {
        lastError = e;
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAYS[attempt]);
        }
      }
    }

    throw lastError ?? new Error("Embedding failed after retries");
  }
}

// ─── OpenAI embedding ───

async function openaiEmbed(
  texts: string[],
  model: string,
  apiKey: string
): Promise<Float32Array[]> {
  const key = resolveApiKey(apiKey);
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `OpenAI embed failed: HTTP ${response.status} — ${errorBody.slice(0, 200)}`
    );
  }

  const data = await response.json();
  return data.data.map((d: any) => new Float32Array(d.embedding));
}

// ─── Voyage embedding ───

async function voyageEmbed(
  texts: string[],
  model: string,
  apiKey: string
): Promise<Float32Array[]> {
  const key = resolveApiKey(apiKey);
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Voyage embed failed: HTTP ${response.status} — ${errorBody.slice(0, 200)}`
    );
  }

  const data = await response.json();
  return data.data.map((d: any) => new Float32Array(d.embedding));
}

// ─── Helpers ───

function resolveApiKey(key?: string): string {
  if (!key) return "";
  // Support $ENV_VAR syntax
  if (key.startsWith("$")) {
    const envVar = key.slice(1);
    return process.env[envVar] ?? "";
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
