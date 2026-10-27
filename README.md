# qus.me

qus.me is a queue of values waiting to be placed into fields on web pages. People and agents submit drafts, each naming a destination (a site and an account) and a field; a browser extension lets you pick a draft and insert it into the matching field on the live page, and you still click Post yourself. Drafts are stored end-to-end encrypted on a private Nostr relay, and the qus.me service handles MCP for agents, agent keys and device pairing without ever holding the key that reads the queue.

The specification is [docs/spec.md](docs/spec.md).

## Layout

A pnpm workspace, laid out as in section 8.5 of the spec:

| Package | What it is |
| --- | --- |
| `packages/core` | The service as a Hono `createApp(deps)` factory, using Web-standard APIs only. `GET /healthz` and a `/mcp` stub (501) so far |
| `packages/nostr` | Event builders and parsers shared by the service, extension and PWA. NIP-44 encryption, NIP-49 `ncryptsec` and NIP-59 gift wraps so far, behind a `Signer` interface |
| `packages/store-sql` | Drizzle schema for the service's own state and its SQL migrations, with drivers for D1 (`@qusme/store-sql/d1`) and a SQLite file (`@qusme/store-sql/sqlite`) |
| `packages/entry-worker` | The Cloudflare Workers entrypoint and `wrangler.jsonc` |
| `packages/entry-node` | The Node entrypoint (`@hono/node-server`, better-sqlite3) and a Dockerfile |
| `packages/extension` | The browser extension (WXT, Chrome and Firefox MV3) |
| `packages/pwa` | The mobile PWA (Preact, Vite, Tailwind v4) |

The site registry will be its own repository.

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

`wrangler dev` reads secrets from `packages/entry-worker/.dev.vars` (`QUSME_AGENT_KEY_SECRET=...`). The Node entrypoint reads `QUSME_AGENT_KEY_SECRET`, `QUSME_DB_PATH` and `PORT` from the environment; its `dev` script fills in a throwaway secret when none is set. `QUSME_AGENT_KEY_SECRET` is 32 random bytes in standard base64 (`openssl rand -base64 32`); both entrypoints refuse to start without one, or with anything else.

The clients:

```sh
pnpm -C packages/extension dev           # Chrome; dev:firefox for Firefox
pnpm -C packages/pwa dev
```

A schema change is an edit to `packages/store-sql/src/schema.ts` followed by `pnpm -C packages/store-sql generate`, which writes the next migration into `packages/store-sql/migrations`. Commit it with the schema change. Wrangler applies those files to D1 and drizzle's migrator applies them to the Node entrypoint's SQLite file at startup.

## Deploying

The service is served at `https://app.qus.me`, with MCP at `/mcp`. It runs on the homelab first and on Cloudflare Workers later; the hostname is the same either way, so moving between them is a DNS change in lokkju/infra.

### Homelab (now)

`packages/entry-node` runs on the homelab's k3s cluster behind the Cloudflare tunnel at app.qus.me, deployed by [lokkju/infra](https://github.com/lokkju/infra) ([lokkju/infra#660](https://github.com/lokkju/infra/issues/660)). This repo builds the image:

- `.github/workflows/image.yml` builds `packages/entry-node/Dockerfile` on the `homelab-build` runner and, on every push to `main` (or by hand), pushes it to zot as `registry.lab.lokkju.com/builds/qusme`, tagged with the full and the short commit SHA. The job summary has the digest. Pull requests that touch the image's packages build it without pushing.
- lokkju/infra owns the registry credentials this repo pushes with (`REGISTRY_HOST`, `REGISTRY_USER`, `REGISTRY_PASSWORD`, from its `build_repos`), the runner, the deployment, its `QUSME_AGENT_KEY_SECRET`, the SQLite volume and the tunnel route. Images go to zot only, never to ghcr.io.

To build it locally: `docker build -f packages/entry-node/Dockerfile --build-arg QUSME_VERSION=$(git rev-parse --short HEAD) .`, then `docker run -e QUSME_AGENT_KEY_SECRET=... -p 8787:8787 <image>` serves `/healthz` on :8787.

### Rotating the agent key secret

`QUSME_AGENT_KEY_SECRET` encrypts every agent key at rest (spec 6.2), and each key records the version of the secret it is under. Losing the secret loses every agent key, so the old one stays configured until every key has moved. To rotate from version N to N+1:

1. Set `QUSME_AGENT_KEY_SECRET_PREVIOUS` to the current secret, `QUSME_AGENT_KEY_SECRET` to a new one, and `QUSME_AGENT_KEY_VERSION` to N+1 (unset means 1, so the first rotation sets it to 2). New keys are encrypted under N+1 at once, and keys still under N keep working.
2. Re-encrypt. On Node, `pnpm -C packages/entry-node rotate-agent-keys` (in the image, `node packages/entry-node/src/rotateAgentKeys.ts`) does it once with the server's environment and prints the count and the ids of any key it could not move; the server also runs a pass every five minutes while `QUSME_AGENT_KEY_SECRET_PREVIOUS` is set. On Workers the five-minute cron runs a pass under the same condition.
3. When a pass reports nothing left to move and no failures, remove `QUSME_AGENT_KEY_SECRET_PREVIOUS`. Revoked keys have no ciphertext and are never re-encrypted.

Only one previous version is held, so finish a rotation before starting the next. The secrets are lokkju/infra's to set: SOPS for the homelab deployment, Pulumi's Worker secrets on Workers (each new variable is a change there first).

### Workers (later)

The Worker is the `qusme` script on Cloudflare. The Pulumi stack in lokkju/infra owns the script's existence, its custom domain `app.qus.me`, the D1 database `qusme`, the Worker secret `QUSME_AGENT_KEY_SECRET`, and the Actions secrets this repo deploys with (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). This repo owns the code.

`.github/workflows/deploy.yml` runs only by hand (`workflow_dispatch`): it applies pending D1 migrations, then runs `wrangler deploy`, which replaces the script's code and keeps its secrets. Nothing deploys the Worker automatically. CI still runs `wrangler deploy --dry-run` on every PR so the Workers entrypoint keeps building.

For that reason `wrangler.jsonc` declares no routes or custom domains and sets `workers_dev` to `false`. A change to the domain, the database or a secret is a change in lokkju/infra.

`/healthz` reports the deployed commit. Releases of the service will be CalVer (`vYYYY.MM.DD[.N]`) once release automation exists.

## License

[PolyForm Shield 1.0.0](LICENSE).
