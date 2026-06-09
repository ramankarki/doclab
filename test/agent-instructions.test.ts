import { describe, test, expect } from "bun:test";
import { generateAgentInstructions } from "../src/lib/agent-instructions";

describe("agent-instructions", () => {
  test("generates instructions with correct port", () => {
    const instructions = generateAgentInstructions(8475);
    expect(instructions).toContain("doclab");
    expect(instructions).toContain("8475");
    expect(instructions).toContain("http://127.0.0.1:8475");
  });

  test("includes usage examples", () => {
    const instructions = generateAgentInstructions(9999);
    expect(instructions).toContain("doclab search");
    expect(instructions).toContain("doclab add");
    expect(instructions).toContain("doclab list");
    expect(instructions).toContain("doclab pull");
    expect(instructions).toContain("--source");
  });
});
