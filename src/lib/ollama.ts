/**
 * Ollama API client
 *
 * Handles:
 * - Health check (GET /api/tags)
 * - Batch embedding (POST /api/embed)
 */

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export interface OllamaModel {
  name: string;
  size?: number;
}

export async function checkOllama(
  ollamaUrl: string = DEFAULT_OLLAMA_URL
): Promise<{
  reachable: boolean;
  models: OllamaModel[];
  error?: string;
}> {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { reachable: false, models: [], error: `HTTP ${response.status}` };
    }
    const data = await response.json();
    const models: OllamaModel[] = (data.models ?? []).map((m: any) => ({
      name: m.name,
      size: m.size,
    }));
    return { reachable: true, models };
  } catch (e: any) {
    return { reachable: false, models: [], error: e.message };
  }
}

export async function ollamaEmbed(
  texts: string[],
  model: string,
  ollamaUrl: string = DEFAULT_OLLAMA_URL
): Promise<Float32Array[]> {
  const response = await fetch(`${ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Ollama embed failed: HTTP ${response.status} — ${errorBody.slice(0, 200)}`
    );
  }

  const data = await response.json();
  const embeddings: number[][] = data.embeddings ?? [];

  if (embeddings.length !== texts.length) {
    throw new Error(
      `Ollama returned ${embeddings.length} embeddings for ${texts.length} inputs`
    );
  }

  return embeddings.map((e) => new Float32Array(e));
}

export async function detectDimensions(
  model: string,
  ollamaUrl: string = DEFAULT_OLLAMA_URL
): Promise<number> {
  const result = await ollamaEmbed(["test"], model, ollamaUrl);
  return result[0].length;
}
