# qus.me store listing text

This file is the source for the Chrome Web Store and Firefox Add-ons (AMO) listings. The release
workflow uploads builds only, so after changing anything here, paste it into both store dashboards
by hand. The images are in this directory; see README.md.

Checked against the 2026.11.9 manifest: permissions activeTab, scripting, contextMenus,
storage, alarms; optional host permission https://app.qus.me/*; no host permissions; no
remote code.

## Basics (both stores)

- Name: qus.me
- Summary (manifest, 132 max): Drafts from you and from your agent, in a queue only you can read. Press Alt+Q in a post box, pick one and click Post yourself.
- Category: Chrome "Productivity" (Workflow & planning); AMO "Social & Communication"
- Homepage: https://qus.me
- Support email: info@qus.me
- Privacy policy: https://qus.me/privacy
- Images: screenshots/01-04 (1280x800), promo-440x280.png, marquee-1400x560.png, icon-128.png

## Description

A queue of drafts for your browser. Drafts wait in line. You post them.

Tell your agent what to write and the drafts land in your queue, encrypted so that only your devices
can read them. On X, Bluesky, Mastodon or LinkedIn, press Alt+Q in the post box, pick a draft,
fix what you want and click Post. Nothing goes out until you click it; qus.me never posts.

How it works
1. Create your queue. Pick a passphrase. The extension makes your queue's key on this device,
   locks it with that passphrase and shows you a 12-word recovery code once, with a recovery
   sheet you can save. Write the code down: it, or a device you've already set up, is the only
   way onto a new device.
2. Connect your agent. Add https://app.qus.me/mcp to your AI app (Claude or another MCP client).
   Your agent shows a short code; type it into the extension, then choose which accounts it may
   draft for and how many drafts it may add per day, week or month. Each agent you connect gets
   its own approval.
3. Insert and post. Click into the post box and press Alt+Q (or click Insert in the popup, or
   use the right-click menu). Pick a draft, read it, change what you like and click Post.

Nobody else can read your queue
- Each draft is encrypted on your device with a key only your devices hold, then stored on public
  Nostr relays (servers anyone can use to pass messages along). A relay holds data it can't open.
- An agent you approve can add drafts to your queue and sees only what it wrote. It can't list
  the queue or read your other drafts. You set its accounts and its limit, and you can revoke it
  from the popup.
- No analytics, no ads, no selling your data. app.qus.me sees an agent's draft only while it
  checks and encrypts it, then forgets it, and it never holds the key to your queue.

The extension asks for no access to any site: it touches a page only when you press Alt+Q, click
Insert or use the right-click menu on that page.

Works with X, Bluesky, Mastodon and LinkedIn; you can add other sites as destinations yourself.
Free while in beta.

## Chrome: Privacy practices tab

Single purpose:
Keep an encrypted queue of drafts written by you or by AI agents you approve, and put the draft
you pick into the post box on the page you are on. You click Post yourself; the extension never
posts.

activeTab:
Gives the extension access to the current tab only after the user acts: pressing Alt+Q, clicking
Insert in the popup, or choosing the context-menu item. It is used to find the focused text field
and put the chosen draft into it. The extension has no access to any site otherwise.

scripting:
Injects the draft picker and the insertion code into the active tab, only after one of those user
actions (activeTab), so the chosen draft can be placed in the focused field.

contextMenus:
Adds a right-click menu item on editable fields to insert a draft from the queue.

storage:
Stores the queue key (encrypted with the user's passphrase), the user's settings and destinations,
and a local cache of the queue's drafts so the popup opens quickly. Nothing is stored for any site.

alarms:
Runs a periodic sync of the queue from its Nostr relays while the queue is unlocked, so drafts that
agents submitted appear without opening the popup.

Host permission (optional, https://app.qus.me/*):
Requested only when the user pairs a device with a typed code, approves or revokes an AI agent;
never at install. The extension uses it to look up the pending agent request and to confirm
revocations with the qus.me service.

Remote code: No. All code ships in the package; site definitions are signed data, never code.

Data usage (D22): declare "Personal communications" (the drafts). They leave the device only
end-to-end encrypted, to relays the user chooses; neither the developer nor the relays can read
them. Tick all three certifications (not sold; not used or transferred for purposes unrelated to
the single purpose; not used for creditworthiness or lending).

## AMO

- Source code: yes, upload qusme-<version>-sources.zip. It holds the whole repo; build steps are in
  packages/extension/README.md ("Building from source"): pnpm install --frozen-lockfile, then
  pnpm --filter @qusme/extension exec wxt build -b firefox.
- Data collection: the manifest declares none (D22).
- License: as in the repo's LICENSE.
- Notes to reviewer: Drafts are encrypted on the device and synced through public Nostr relays the
  user picks. The only server the extension contacts is app.qus.me, behind an optional host
  permission requested when the user pairs a device or approves an agent.
