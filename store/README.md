# Store listing

`LISTING.md` is the listing text for the Chrome Web Store and Firefox Add-ons (AMO): summary,
description, Chrome's privacy practices answers and the AMO notes. The release workflow uploads
builds only, so a change to it goes into both store dashboards by hand.

The images are in the table below. Every screenshot shows the
real extension UI, from the build in `packages/extension/.output/chrome-mv3`, set on a 1280x800
canvas with a caption in the landing site's type and colors. All files are PNG with no alpha.

| File | Size | Purpose |
| --- | --- | --- |
| `screenshots/01-popup.png` | 1280x800 | The popup over a compose page: drafts for this page first, the rest under Elsewhere, one-click Insert. |
| `screenshots/02-picker.png` | 1280x800 | The Alt+Q picker open at a compose field. |
| `screenshots/03-approve-agent.png` | 1280x800 | Approving Claude over MCP: the request, its destinations and its limits. The screen is taller than a popup, so it is shown as two cards. |
| `screenshots/04-setup.png` | 1280x800 | First run: create a queue, pair a device or recover. |
| `promo-440x280.png` | 440x280 | Chrome's small promo tile. |
| `marquee-1400x560.png` | 1400x560 | Chrome's marquee promo tile. |

Both stores take the screenshots; only Chrome uses the promo tile and the marquee.

## Regenerating

After a UI change, build the extension and run the capture script from the repo root:

```sh
mise exec -- pnpm -C packages/extension exec wxt build
mise exec -- uv run scripts/store-screenshots/capture.py
```

The script (`scripts/store-screenshots/capture.py`) loads the build in Chromium through Playwright,
serves a demo queue from a local relay (`seed.ts` signs its settings and destinations events with
a fixed demo key), puts the demo drafts in the draft cache, and screenshots the popup and the
picker. The page behind them is `scripts/store-screenshots/compose.html`, a neutral compose page
that copies no real site.

A few things are stubbed, because a script can't do them in a browser it drives:

- The popup sees `https://x.com/compose/post` as its active tab and gets the account detection's
  answer from the stub, since `activeTab` is only granted by a real click or shortcut.
- The popup's sync request returns at once; the drafts come from the seeded cache, not from a sync.
- The agent approval's code lookup gets its answer from a stub instead of app.qus.me. The
  destinations it lists come from the local relay through the extension's own relay code.
- The picker is opened by injecting the built `qusme-page.js` into the compose page and calling
  its `openPicker` with the list the background would build, because the Alt+Q command can't be
  pressed from automation.

The demo content (Lantern Works, `@lanternworks`) is made up.
