# @qusme/extension

The qus.me browser extension: it holds your queue's key, shows the queue in its popup, approves and revokes agents, and puts the draft you pick into the post box when you press Alt+Q, click Insert or use the right-click menu. The reverse works too: right-click a post box you've typed into on X, Bluesky, Mastodon or LinkedIn and choose "Save to qus.me", and the text goes into your queue as a draft of your own, encrypted like any other, for the destination the page is signed in to. Its permissions are `activeTab`, `scripting`, `contextMenus`, `storage` and `alarms`, with no host permissions: it reaches a page only on one of those actions (saving a field is one of them), and the only server it ever contacts is app.qus.me, through an optional host permission asked for when you pair a device or approve an agent. WXT, Preact and Tailwind v4, Manifest V3 for Chrome and Firefox. Run it with `pnpm -C packages/extension dev` (Chrome) or `dev:firefox`.

## Building from source

The Firefox sources zip is the whole repository less `node_modules`, tests and build output, because the extension builds from the workspace packages (`@qusme/nostr`) and the root lockfile. With Node 24 and pnpm (the version in the root `package.json`'s `packageManager`), from the unzipped root:

```sh
pnpm install --frozen-lockfile
pnpm -C packages/extension exec wxt build -b firefox   # output in packages/extension/.output/firefox-mv3
```

## Releasing

The `release-extension` workflow runs on every push to main that changes what ships in the extension: `packages/extension`, `packages/nostr` (the one workspace package it bundles), `registry/snapshot.json`, the lockfile, the root `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.base.json`, `.mise/config.toml` and the workflow itself. A push that touches only tests, `packages/nostr/scripts` or Markdown files doesn't start one. You can also run it by hand from main (Actions, "release-extension", "Run workflow").

Every run starts with a `plan` job, which lists in the run's summary the commits since the last `extension-v*` tag that change what ships, with a link to the full diff, so you can see what you're approving. The `release` job then waits for lokkju's approval on the `release` environment, which admits main only. Nothing ships without that approval; to skip a release, reject the run or leave it waiting.

A newer run replaces an older one that hasn't been approved: its `plan` job cancels every older run whose `release` job hasn't started, so only the newest push waits for approval, and approving it ships everything before it too. An approved release is never cancelled; a run that arrives while one is releasing waits until it finishes. A newer push also cancels a manual run (a `dry_run` included) that is still waiting. Once approved, the `release` job:

1. picks the version at that moment, not when the run started: today's UTC date as `YYYY.M.D` with no leading zeros (`2026.11.8`), or `2026.11.8.1`, `.2` and so on when a release or tag `extension-v<version>` already exists. It refuses a version that isn't greater than the one in `package.json`;
2. writes that version into `package.json` inside the job only; main keeps the version it has, and nothing is committed back;
3. typechecks, tests, and runs `wxt zip` and `wxt zip -b firefox` (Chrome zip, Firefox zip, sources zip);
4. creates a draft GitHub release `extension-v<version>` with the three zips;
5. runs `wxt submit` once per store whose secrets are all set, skipping the others with a notice;
6. publishes the draft.

The run's summary has one line per store: submitted, skipped (secrets unset), busy (in review) or failed.

The Chrome Web Store reviews one version at a time. While an earlier version is still in review it refuses an upload with `NOT_UPDATEABLE` ("You may not edit or publish an item that is in review"), which the job reports as busy: a warning, not a failure. The release is still published as long as every other store succeeded, so Chrome stays a version behind until the next release submits it again. To ship the skipped version sooner, wait for the review to finish and upload the Chrome zip from its GitHub release in the developer dashboard.

Any other store failure fails the job, after every store has been tried, and leaves the draft in place with its version taken; the next run moves on to the next suffix, or you can delete the draft first. Tick `dry_run` to run `wxt submit --dry-run` instead, which checks the store credentials, uploads nothing and makes no release.

The secrets live on the `release` environment:

| Store | Secrets |
| --- | --- |
| Chrome Web Store (API v2) | `CHROME_EXTENSION_ID`, `CHROME_PUBLISHER_ID`, `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL`, `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` |
| Firefox Add-ons | `FIREFOX_EXTENSION_ID`, `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET` |

Chrome uses the Web Store API v2 with a service account, because API v1.1 (client id, client secret and refresh token) shut down on 2026-10-15. `wxt submit init` walks through creating the service account and finding the publisher id.

`wxt submit` only updates an item that already exists in a store. The first Chrome Web Store upload was made by hand in the developer dashboard, and so is the first listing in any new store.
