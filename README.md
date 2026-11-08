# qus.me

qus.me is a queue of values waiting to be placed into fields on web pages. People and agents submit drafts, each naming a destination (a site and an account) and a field; a browser extension lets you pick a draft and insert it into the matching field on the live page, and you still click Post yourself. Drafts are stored end-to-end encrypted on a private Nostr relay, and the qus.me service handles MCP for agents, agent keys and device pairing without ever holding the key that reads the queue.

The specification is [docs/spec.md](docs/spec.md).

## Layout

A pnpm workspace, laid out as in section 8.5 of the spec:

| Package | What it is |
| --- | --- |
| `packages/core` | The service as a Hono `createApp(deps)` factory, using Web-standard APIs only: OAuth for MCP clients, the MCP tools at `/mcp`, agent key custody and the pairing rendezvous |
| `packages/nostr` | Event builders and parsers shared by the service, extension and PWA. NIP-44 encryption, NIP-49 `ncryptsec` and NIP-59 gift wraps so far, behind a `Signer` interface |
| `packages/store-sql` | Drizzle schema for the service's own state and its SQL migrations, with drivers for D1 (`@qusme/store-sql/d1`) and a SQLite file (`@qusme/store-sql/sqlite`) |
| `packages/entry-worker` | The Cloudflare Workers entrypoint and `wrangler.jsonc` |
| `packages/entry-node` | The Node entrypoint (`@hono/node-server`, better-sqlite3), for local development |
| `packages/extension` | The browser extension (WXT, Chrome and Firefox MV3) |
| `packages/pwa` | The mobile PWA (Preact, Vite, Tailwind v4) |

The site registry is its own repository, lokkju/qusme-registry. Builds bundle its signed snapshot from `registry/snapshot.json`; to take a new one, build it in a registry checkout (`pnpm snapshot`) and run `pnpm registry:update [<checkout>]` here (default `../qusme-registry`), which verifies it against the pinned publisher key before writing (spec 10.3).

## Running it locally

```sh
mise install                    # node, pnpm and wrangler at the pinned versions
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

The service, either way:

```sh
pnpm -C packages/entry-worker db:migrate:local   # once, and after each new migration
pnpm -C packages/entry-worker dev                # wrangler dev, local D1
pnpm -C packages/entry-node dev                  # Node on :8787, SQLite in ./qusme.db
```

`wrangler dev` reads secrets from `packages/entry-worker/.dev.vars` (`QUSME_AGENT_KEY_SECRET=...`). The Worker routes by Host, so locally put `QUSME_PUBLIC_ORIGIN=http://localhost:8787` in `.dev.vars` for the service, or `QUSME_SITE_ORIGIN=http://localhost:8787` for the landing site; any other host gets a 404. The Node entrypoint reads `QUSME_AGENT_KEY_SECRET`, `QUSME_DB_PATH` and `PORT` from the environment; its `dev` script fills in a throwaway secret when none is set. `QUSME_AGENT_KEY_SECRET` is 32 random bytes in standard base64 (`openssl rand -base64 32`); both entrypoints refuse to start without one, or with anything else.

The clients:

```sh
pnpm -C packages/extension dev           # Chrome; dev:firefox for Firefox
pnpm -C packages/pwa dev
```

A schema change is an edit to `packages/store-sql/src/schema.ts` followed by `pnpm -C packages/store-sql generate`, which writes the next migration into `packages/store-sql/migrations`. Commit it with the schema change. Wrangler applies those files to D1 and drizzle's migrator applies them to the Node entrypoint's SQLite file at startup.

## Deploying

The service is served at `https://app.qus.me`, with MCP at `/mcp`, from Cloudflare Workers. The same Worker serves the landing site and privacy policy (`site/`, static files) at `https://qus.me` as Workers static assets, routing by Host: `qus.me` gets the site, `www.qus.me` redirects to it, `app.qus.me` gets the service and never the site, and any other host gets a 404. The Node entrypoint and its image are for self-hosting and local development.

### Workers

The Worker is the `qusme` script on Cloudflare. The Pulumi stack in [lokkju/infra](https://github.com/lokkju/infra) owns the script's existence, its custom domains `app.qus.me` and `qus.me`, the D1 database `qusme`, the Worker secret `QUSME_AGENT_KEY_SECRET`, and the deploy token and account id this repo deploys with (the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` Actions secrets). This repo owns the code and the migrations.

`.github/workflows/deploy.yml` ships the code on every merge to `main` that touches the Worker or anything it builds from (`packages/core`, `packages/nostr`, `packages/store-sql`, `packages/entry-worker`, `registry/`, the lockfile and workspace files, the pinned tools and the workflow itself), and by hand (`workflow_dispatch`). It applies pending D1 migrations, then runs `wrangler deploy`, which replaces the script's code and keeps its secrets. One deploy runs at a time; a newer one waits. CI runs `wrangler deploy --dry-run` on every PR.

`wrangler.jsonc` declares no routes or custom domains and sets `workers_dev` to `false`, because Pulumi attaches app.qus.me and qus.me. The `assets` block keeps `main`: an assets-only deploy would upload a version with no bindings and drop the Worker's secrets. A change to the domain, the database, a binding or a secret is a change in lokkju/infra first.

`/healthz` reports the deployed commit. Releases of the service will be CalVer (`vYYYY.MM.DD[.N]`) once release automation exists.

### Limits

The service rate-limits its own routes and caps what it will spend (spec 8.5, "Limits"), on top of the per-IP rule at Cloudflare's edge that lokkju/infra owns. The numbers live in `packages/core/src/limits.ts`: `RATE_CLASSES` for the rate limits, `TIERS` for what each queue gets (one tier, `free`, for now), and `DEFAULT_LIMITS` for the service-wide caps.

- Rate limits go through the Workers Rate Limiting binding on Workers, one `ratelimits` entry in `wrangler.jsonc` per rate class with the same limit and period (a test fails if they drift apart), and through an in-memory counter on Node. The binding needs no Cloudflare resource created ahead of the deploy; its `namespace_id` is a number we pick. A binding the account or deploy doesn't provide falls back to in-memory counting in each isolate, with one `ratelimit_binding_unavailable name=<binding>` warning per isolate, so the Worker keeps serving.
- The caps (open authorizations per IP and in all, agents per queue, drafts per queue per day, and the service-wide daily draft ceiling) are counted in D1 or the SQLite file and refuse the request if counting fails.
- `QUSME_DAILY_DRAFT_CEILING` sets the service-wide ceiling: a plain var in `wrangler.jsonc` on Workers (2000), the environment on Node (2000 when unset). Anything but a whole number stops the service from starting; 0 refuses every draft.

A client over a limit gets 429 with `Retry-After`; an agent gets the MCP tool error `rate_limited` or `quota_exhausted`, with `retry_after` in seconds.

### Rotating the agent key secret

`QUSME_AGENT_KEY_SECRET` encrypts every agent key at rest (spec 6.2), and each key records the version of the secret it is under. Losing the secret loses every agent key, so the old one stays configured until every key has moved. To rotate from version N to N+1:

1. Set `QUSME_AGENT_KEY_SECRET_PREVIOUS` to the current secret, `QUSME_AGENT_KEY_SECRET` to a new one, and `QUSME_AGENT_KEY_VERSION` to N+1 (unset means 1, so the first rotation sets it to 2). New keys are encrypted under N+1 at once, and keys still under N keep working.
2. Re-encrypt. On Workers the five-minute cron runs a pass while `QUSME_AGENT_KEY_SECRET_PREVIOUS` is set. On Node, `pnpm -C packages/entry-node rotate-agent-keys` (in the image, `node packages/entry-node/src/rotateAgentKeys.ts`) does it once with the server's environment and prints the count and the ids of any key it could not move; the server also runs a pass every five minutes under the same condition.
3. When a pass reports nothing left to move and no failures, remove `QUSME_AGENT_KEY_SECRET_PREVIOUS`. Revoked keys have no ciphertext and are never re-encrypted.

Only one previous version is held, so finish a rotation before starting the next. On Workers the secrets are Pulumi's Worker secrets in lokkju/infra, and each new variable is a change there first. A self-hosted Node server takes them from its environment.

### Self-hosting (Node)

`packages/entry-node` serves the same app with a SQLite file in place of D1, for local development and the SQLite tests. There is no published image; anyone self-hosting runs the entrypoint under Node 24 with `QUSME_AGENT_KEY_SECRET` (and optionally `QUSME_VERSION`, which `/healthz` reports) in its environment.

## CI

`.github/workflows/ci.yml` runs install, typecheck, lint, test and build on GitHub-hosted runners (`ubuntu-24.04`), and `deploy.yml` deploys the Worker on the same runners. GitHub never passes secrets to workflows run from forks, so a fork's pull request gets CI but can't deploy.

## License

[PolyForm Shield 1.0.0](LICENSE).
