import { describe, test, expect } from "bun:test";
import { checkOllama } from "../src/lib/ollama";

describe("ollama", () => {
  test("checkOllama returns unreachable for bad URL", async () => {
    const result = await checkOllama("http://localhost:19999");
    expect(result.reachable).toBe(false);
  });

  test("checkOllama with default URL when ollama not running", async () => {
    const result = await checkOllama();
    // Ollama may or may not be running in test env
    // Just verify the shape of the response
    expect(result).toHaveProperty("reachable");
    expect(result).toHaveProperty("models");
  });
});
