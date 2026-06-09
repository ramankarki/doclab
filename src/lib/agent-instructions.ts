/**
 * AGENTS.md snippet generation — `doclab init` command
 */

export function generateAgentInstructions(port: number): string {
  return `## Documentation lookup (doclab)

Before writing code with any framework or library, query doclab for current docs:

\`\`\`bash
doclab search "<framework> <topic>"
\`\`\`

This returns documentation snippets with exact code examples from the latest sources.

Tips:
- Include framework name: "hono cors middleware"
- Filter: doclab search "migrations" --source drizzle
- Add sources: doclab add https://docs.example.com/guide
- List sources: doclab list
- Check freshness: doclab status
- Re-fetch: doclab pull

doclab runs on http://127.0.0.1:${port}. Auto-starts on first search.
`;
}
