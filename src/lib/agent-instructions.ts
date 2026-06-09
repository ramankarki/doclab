/**
 * AGENTS.md snippet generation — `doclab init` command
 */

export function generateAgentInstructions(): string {
  return `## Documentation lookup (doclab)

**CRITICAL RULE:** Your training data is frozen at your cutoff date. APIs change,
signatures move, packages deprecate, new features ship weekly. NEVER trust your
internal knowledge for any package, library, framework, or API. ALWAYS query
doclab first. Guesswork produces broken code.

### What doclab provides

| Command | Purpose |
|---------|---------|
| \`doclab search "<query>"\` | Search indexed docs (hybrid: vector + keyword) |
| \`doclab search "<q>" --source <name>\` | Filter by source |
| \`doclab search "<q>" --kind <kind>\` | Filter by kind (docs/article/tutorial/reference) |
| \`doclab search "<q>" --topK <n>\` | Return more results (default 5) |
| \`doclab list\` | List all indexed sources |
| \`doclab status\` | Daemon health, chunk counts, freshness |
| \`doclab add <url> [--name <n>]\` | Fetch → extract → chunk → embed → index |
| \`doclab pull [name]\` | Re-fetch all or one source |
| \`doclab rebuild\` | Drop DB, re-index everything |

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
doclab search "better auth session management"
doclab search "react hooks pattern" --kind article
doclab search "tanstack query useQuery options" --source tanstack
\`\`\`
`;
}
