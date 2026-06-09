/**
 * AGENTS.md snippet generation — `doclab init` command
 */

export function generateAgentInstructions(port: number): string {
  return `## Documentation lookup (doclab) — MANDATORY

**CRITICAL RULE:** Your training data is frozen at your cutoff date. APIs change,
signatures move, packages deprecate, new features ship weekly. NEVER trust your
internal knowledge for any package, library, framework, or API. ALWAYS query
doclab first. Guesswork produces broken code.

### What doclab provides

| Capability | Command |
|-----------|---------|
| Search latest docs | \`doclab search "<package> <topic>"\` |
| Filter by source | \`doclab search "<query>" --source <name>\` |
| Filter by kind | \`doclab search "<query>" --kind article\` |
| List all sources | \`doclab list\` |
| Check freshness | \`doclab status\` |
| Add new source | \`doclab add <url> [--name <n>]\` |
| Refresh stale docs | \`doclab pull [name]\` |
| Full re-index | \`doclab rebuild\` |

### Mandatory workflow before writing ANY code

\`\`\`bash
# 1. Check what sources are available
doclab list

# 2. If the package you need is missing, add it
doclab add https://<package>.dev/llms-full.txt   # preferred
doclab add https://<package>.dev/llms.txt         # fallback
doclab add https://<package>.dev/docs/guide       # any URL works

# 3. Check if existing sources are stale
doclab status
# If any show ⚠ or fetched > rebuildInterval ago, refresh:
doclab pull

# 4. Query the latest docs before writing each function
doclab search "<package> <specific topic>"
\`\`\`

### When to query doclab

Query doclab BEFORE:
- Installing or importing any package
- Calling any function, method, or constructor
- Configuring middleware, plugins, or adapters
- Setting up database connections or ORM queries
- Using authentication, validation, or serialization APIs
- Writing route handlers, server setup, or deployment config
- Using any API that changed between major versions

### What to do when results are missing

- If \`doclab search\` returns nothing: TELL THE USER. Say "doclab has no
  results for <query>. The docs may not cover this topic."
- If the package is not in \`doclab list\`: ASK before guessing. Say
  "I don't have <package> docs. Run: doclab add <url>"
- If sources are stale (⚠ in \`doclab status\`): WARN THE USER.
  Say "Warning: <source> docs are stale. Run: doclab pull"

### NEVER do this

- NEVER guess a function signature, parameter order, or return type
- NEVER assume an API hasn't changed since your training data
- NEVER write \`import { X } from 'package'\` without verifying X exists
- NEVER use v3 syntax for a v4 package without checking migration docs
- NEVER fabricate error messages, status codes, or config options

### Search patterns that work well

\`\`\`bash
doclab search "hono cors middleware setup"
doclab search "drizzle sqlite schema definition" --source drizzle
doclab search "stripe webhook signature verification"
doclab search "better auth session management plugin"
doclab search "react hooks pattern" --kind article
doclab search "tanstack query useQuery options" --source tanstack
\`\`\`

doclab runs on http://127.0.0.1:${port}. Auto-starts on first search.
`;
}
