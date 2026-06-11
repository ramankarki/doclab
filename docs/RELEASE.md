# Release Pipeline

Every push to `main` triggers an automated release pipeline. No manual version bumping or changelog writing.

## Overview

```
git push main
  │
  ├─ CI workflow runs (typecheck + test + build)
  │
  ├─ release-please reads conventional commits
  │   ├─ Creates/updates a Release PR
  │   │   ├─ Bumps version in package.json
  │   │   └─ Updates CHANGELOG.md
  │   │
  │   └─ You review the PR → merge
  │       │
  │       └─ push to main triggers release-please again
  │           │
  │           ├─ GitHub Release created + Git tag pushed
  │           │
  │           └─ same workflow publishes to npm
  │               ├─ bun install --frozen-lockfile
  │               ├─ bun publish --provenance (signed by GitHub Actions)
  │               └─ smoke test (doclab --version)
```

Release-please and npm publish run in a **single combined workflow** using step outputs (`release_created`) to gate publication. No cross-workflow event chaining. No PAT needed.

## Commit Conventions

Every commit message drives the release. Follow [Conventional Commits](https://www.conventionalcommits.org/).

**Enforced by:**
- `.husky/commit-msg` — runs `bunx commitlint` on every commit
- `.husky/pre-commit` — runs `bun test` before every commit
- CI workflow — checks commit messages on push and PR

### Format

```
feat: auto-expand llms.txt TOC into full docs
fix: handle empty array in fetchAndConcat
perf: boost header keyword match weight 3→10
docs: add release pipeline documentation
chore: update dependencies
```

| Prefix | Version bump | Changelog section |
|--------|-------------|-------------------|
| `feat:` | Minor (1.3.0 → 1.4.0) | Features |
| `fix:` | Patch (1.3.0 → 1.3.1) | Bug Fixes |
| `perf:` | Patch | Performance |
| `docs:` | — (no bump) | Documentation |
| `chore:` | — (no bump) | Hidden |
| `refactor:` | — (no bump) | Hidden |
| `test:` | — (no bump) | Hidden |
| `feat!:` / `fix!:` | Major (1.3.0 → 2.0.0) | Breaking change |

Breaking change: add `!` after the type or `BREAKING CHANGE:` in the body.

## Release PR

After pushing to `main`, release-please opens or updates a Release PR. It looks like:

```
Title: chore(main): release 1.4.0

Body:
## 1.4.0 (2025-06-10)

### Features
* llms.txt auto-expansion (abc123)
* fetch retry with backoff (def456)

### Bug Fixes
* handle empty array in fetchAndConcat (ghi789)
```

**Before merging:**
1. Review the version bump (is it correct?)
2. Review the changelog (anything missing or wrong?)
3. Check CI passed on the PR

**After merging:** Everything else is automatic.

## Manual Release (emergency)

If release-please isn't working:

```bash
git checkout main && git pull
npm version minor -m "chore: release %s"
git push --follow-tags
# Then publish manually:
bun publish --provenance --access public
```

## npm Provenance

Every package published via `bun publish --provenance` is signed with [npm provenance](https://docs.npmjs.com/generating-provenance-statements). The npm package page shows:

> Built and signed on GitHub Actions

Source → Build → Publish chain is verifiable. No one can tamper with the package between the GitHub release and the npm registry.

## Workflow Files

| File | Purpose |
|------|---------|
| `.github/workflows/ci.yml` | Typecheck + test + build on push/PR |
| `.github/workflows/release-please.yml` | Release PR + GitHub Release + npm publish |

## Checklist Before Publishing a Major Version (2.0.0)

- [ ] Breaking changes documented in CHANGELOG
- [ ] Migration guide added (if needed)
- [ ] README updated for new API
- [ ] `engines.bun` updated if new minimum version
- [ ] Tested with `bun run publish:dry` locally
