# Contributing to LogSetu

Thanks for helping! Issues, docs fixes and PRs are all welcome. For anything larger than a bug fix, open an
issue first so we can agree on the approach.

## Dev setup

Requirements: Node 20+, pnpm 12 (`corepack enable` or `npm i -g pnpm`), Python 3.9+ (for the Django SDK), Docker (optional).

```bash
git clone https://github.com/itsrajverma/logsetu && cd logsetu
pnpm install                                   # installs server, logsetu-js and the example Next.js app
cp apps/server/.env.example apps/server/.env   # set LOGSETU_ADMIN_PASSWORD
pnpm --filter @logsetu/server prisma:generate
pnpm --filter @logsetu/server db:push          # creates apps/server/data/logsetu.db
pnpm dev                                       # http://localhost:8686
```

Django SDK:

```bash
cd packages/logsetu-django
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
pytest
```

## Repository layout

| Path | What |
|---|---|
| `apps/server` | Next.js app: API routes under `app/api`, dashboard under `app/dashboard`, DB access in `lib/` |
| `apps/server/prisma/{sqlite,postgres}` | One Prisma schema per provider (same models). Both clients are generated; `lib/db.ts` picks one from `DATABASE_URL`. |
| `apps/server/prisma/migrations` | Plain SQL migrations applied at container start by `scripts/migrate.mjs` |
| `packages/logsetu-js` | npm SDK, built with tsup (`src/index.ts`, `src/react.tsx`, `src/next.ts`) |
| `packages/logsetu-django` | PyPI SDK (`src/logsetu`) |
| `examples/*` | Throwaway apps used for end-to-end testing of the SDKs |

## Changing the database schema

1. Edit **both** `apps/server/prisma/sqlite/schema.prisma` and `apps/server/prisma/postgres/schema.prisma` (keep the models identical).
2. `pnpm --filter @logsetu/server db:diff <name>` — writes `prisma/migrations/{sqlite,postgres}/000N_<name>.sql` and updates the schema snapshots.
3. `pnpm --filter @logsetu/server prisma:generate && pnpm --filter @logsetu/server db:migrate`.
4. Commit the schema files, the SQL files and the snapshots.

## Checks before opening a PR

```bash
pnpm -r typecheck
pnpm -r test
pnpm --filter @logsetu/server build
cd packages/logsetu-django && pytest
```

CI runs the same plus a Docker build. Please keep PRs focused and include a test for behaviour changes.

## Releasing

- **Server image**: every push to `main` publishes `ghcr.io/itsrajverma/logsetu:latest`; tags `vX.Y.Z` publish versioned images.
- **logsetu-js**: bump `packages/logsetu-js/package.json`, tag `js-vX.Y.Z` → published to npm by CI (needs `NPM_TOKEN`).
- **logsetu-django**: bump `packages/logsetu-django/pyproject.toml` (and `__version__` in `client.py`), tag `django-vX.Y.Z` → published to PyPI by CI (needs `PYPI_TOKEN`).

Manual publish, if you prefer:

```bash
pnpm --filter logsetu-js publish --access public
cd packages/logsetu-django && python -m build && twine upload dist/*
```
