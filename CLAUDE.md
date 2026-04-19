# electricity-usage — Claude Instructions

## Git Workflow

Always commit and push after completing any code changes. Never leave changes uncommitted.

1. Stage and commit with a clear conventional message (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)
2. Push to `origin main` immediately after committing
3. Never wait to be reminded to push

## README Sync

Keep `README.md` up to date whenever code changes:

- New dashboard sections → update the Features list
- New environment variables or secrets → update the Setup table
- New scripts or npm commands → update the Local development section
- Architecture changes → update the Architecture diagram

## Python

- Use Python 3 with `ruff` for linting. Run `ruff check scripts/` before committing Python changes.
- Use local imports for intra-package references.

## Data Files

`public/data/*.json` are generated at build time and must never be committed (already in `.gitignore`).
