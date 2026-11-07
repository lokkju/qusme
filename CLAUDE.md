# CLAUDE.md

Guidance for coding agents working in this repository.

## Source of truth

`docs/spec.md` is the specification. Read the relevant section before changing behavior, and change the spec in the same PR when a decision changes it.

## Commands

```sh
mise install && pnpm install
pnpm typecheck        # tsc in every package
pnpm lint             # biome ci; `pnpm format` fixes formatting
pnpm test             # vitest, every package as a project
pnpm build            # wrangler dry-run bundle, extension (chrome + firefox), PWA
pnpm -C packages/store-sql generate          # new migration after a schema change
pnpm -C packages/entry-worker build          # wrangler deploy --dry-run
```

CI (`.github/workflows/ci.yml`) runs install, typecheck, lint, test and build on the `homelab` self-hosted runners; its build includes `wrangler deploy --dry-run`, which keeps the Workers entrypoint from rotting. `.github/workflows/image.yml` builds the entry-node image on `homelab-build`. Never switch a job to GitHub-hosted runners.

## Layout

- `packages/core`: Hono `createApp(deps)`. Web-standard APIs only; no `node:` imports and no Workers globals. Runtime-specific things arrive through `AppDeps`.
- `packages/nostr`: event builders and parsers shared by the service, extension and PWA.
- `packages/store-sql`: Drizzle schema (`src/schema.ts`) and the generated migrations in `migrations/`. Never edit a migration that has been merged; generate a new one.
- `packages/entry-worker`: Workers entrypoint and `wrangler.jsonc`.
- `packages/entry-node`: Node entrypoint and Dockerfile. `image.yml` pushes the image to zot (`registry.lab.lokkju.com/builds/qusme`) only; never to ghcr.io.
- `packages/extension`: WXT. Its permissions are exactly `activeTab`, `scripting`, `contextMenus`, `storage`, `alarms` (spec 11.2, `src/permissions.ts`, tested). No host permissions, no `tabs`.
- `packages/pwa`: Preact, Vite, Tailwind v4 with the CSS-first `@theme` in `src/index.css`.
- `site/`: the landing site and privacy policy at qus.me, plain static HTML, one stylesheet, self-hosted fonts and one script file (`copy.js`), no build step. The Worker serves it as static assets on the qus.me host only, with a strict CSP (`SITE_HEADERS` in `packages/entry-worker/src/index.ts`), so no inline styles or scripts and nothing from other origins; `packages/entry-worker/test/site.test.ts` checks it.

Workspace packages export TypeScript source directly (`"exports": "./src/index.ts"`); bundlers and Node 24's type stripping consume it, so relative imports carry the `.ts` extension and only erasable TypeScript syntax is allowed (no enums, no parameter properties).

## Deploy model

Workers first: app.qus.me (the service) and qus.me (the landing site) are the `qusme` Worker, which routes by Host. `deploy.yml` ships the code on every push to `main` that touches the Worker's packages, `site/`, `registry/`, the lockfile and workspace files, `.mise/config.toml` or the workflow itself (and by hand): D1 migrations, then `wrangler deploy`, one run at a time. A new package the Worker imports goes into its `paths` list too. The Node entrypoint and the image `image.yml` builds are for self-hosting and local development; the homelab no longer runs them.

## What lokkju/infra owns and what this repo owns

lokkju/infra's Pulumi stack owns the `qusme` Worker script's existence, its custom domains `app.qus.me` and `qus.me`, the D1 database `qusme`, the Worker secret `QUSME_AGENT_KEY_SECRET` and the deploy token (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). lokkju/infra also owns the registry credentials (`REGISTRY_HOST`, `REGISTRY_USER`, `REGISTRY_PASSWORD` from `build_repos`) and the runners. This repo owns the code and the migrations, and its deploy workflow ships them on merge to `main`.

- Never declare `routes`, `route`, custom domains or a `workers_dev` route for app.qus.me or qus.me in `wrangler.jsonc`. Keep `workers_dev: false`, and keep `main` next to `assets`: an assets-only deploy drops the Worker's secrets.
- Never set or rotate secrets with `wrangler secret`; that is a lokkju/infra change.
- A new binding (KV, R2, queue, another database) needs a lokkju/infra change first. Pairing sessions are D1 rows with `expires_at`, not KV (spec 8.5).

## Conventions

- Conventional commits. No AI attribution in commits, PRs or files.
- Pin exact dependency versions; the lockfile is committed and CI installs with `--frozen-lockfile`.
- Agent-supplied text is untrusted: render it with `textContent`, never as HTML.
