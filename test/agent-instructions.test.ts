import { describe, test, expect } from "bun:test";
import { generateAgentInstructions } from "../src/lib/agent-instructions";

describe("agent-instructions", () => {
  test("generates instructions with doclab branding", () => {
    const instructions = generateAgentInstructions();
    expect(instructions).toContain("doclab");
    expect(instructions).toContain("## Documentation lookup (doclab)");
  });

  test("includes usage examples", () => {
    const instructions = generateAgentInstructions();
    expect(instructions).toContain("doclab search");
    expect(instructions).toContain("doclab add");
    expect(instructions).toContain("doclab list");
    expect(instructions).toContain("doclab pull");
    expect(instructions).toContain("--source");
    expect(instructions).toContain("--topK");
  });

  test("contains mandatory language", () => {
    const instructions = generateAgentInstructions();
    expect(instructions).toContain("NEVER");
    expect(instructions).toContain("training data is frozen");
    expect(instructions).toContain("ALWAYS query doclab first");
    expect(instructions).toContain("Guesswork produces broken code");
  });

  test("contains all command references", () => {
    const instructions = generateAgentInstructions();
    expect(instructions).toContain("doclab rebuild");
    expect(instructions).toContain("doclab status");
    expect(instructions).toContain("doclab search");
  });

  test("no server URL (agent uses CLI)", () => {
    const instructions = generateAgentInstructions();
    expect(instructions).not.toContain("http://");
    expect(instructions).not.toContain("127.0.0.1");
  });

  test("covers degraded mode", () => {
    const instructions = generateAgentInstructions();
    expect(instructions).toContain("degraded");
    expect(instructions).toContain("keyword-only fallback");
    expect(instructions).toContain("ollama");
  });

  test("covers missing results guidance", () => {
    const instructions = generateAgentInstructions();
    expect(instructions).toContain("no results");
    expect(instructions).toContain("stale");
    expect(instructions).toContain("⚠");
  });
});
