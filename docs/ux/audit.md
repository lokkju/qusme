# UX audit: onboarding and day-to-day usage as built

*2026-11-05. Covers `main` at 0becba4 and open [lokkju/qusme#69](https://github.com/lokkju/qusme/pull/69) (manual destinations, branch `feat/destinations-ui`). Input for a redesign of onboarding, usage patterns and the extension UX; nothing here changes code or proposes a new design yet.*

The baseline is the full run on 2026-11-05, which worked end to end: build with pnpm and load `.output/chrome-mv3` unpacked; create a queue; add the custom connector `https://app.qus.me/mcp` in Claude; copy the code from the authorize page into the extension's "Approve an agent"; with no destinations, turn on "Let it propose new destinations"; ask Claude to `create_draft` for `x/<handle>`; open the popup so it syncs; confirm the pending destination under Agents; on x.com arm the draft and press Insert. Known gaps already filed are referenced where they apply: [#58](https://github.com/lokkju/qusme/issues/58) (edit, dismiss, restore, archive), [#60](https://github.com/lokkju/qusme/issues/60) (edit a grant), [#66](https://github.com/lokkju/qusme/issues/66) (spec wording), [#68](https://github.com/lokkju/qusme/issues/68) (manual destinations, PR #69).

File references are to `packages/extension/` unless they start with `packages/core/` or `docs/`. Line numbers are on `main`.

Each friction point has an id (flow number, then item), a fix, how often a user meets it (**every use**, **weekly**, **once**, **rare**) and the effort of the fix (**S** under a day, **M** a few days, **L** a week or more, or a spec change).

## 1. Install and first run

### As built

1. There is no store listing. The user builds with `pnpm` and loads `.output/chrome-mv3` (or the Firefox build) unpacked. The manifest asks for `activeTab`, `scripting`, `contextMenus`, `storage` and `alarms`, plus the optional host permission `https://app.qus.me/*` (`wxt.config.ts`, `src/permissions.ts`). Nothing opens on install; the user has to find the toolbar icon (pinning it is a browser step the extension never mentions).
2. The popup opens on "Set up qus.me": "Your drafts queue lives encrypted on Nostr relays. This device needs the queue key." Three buttons: "Create a new queue", "Pair with a device that has the queue", "Recover with the recovery code" (`src/ui/app.tsx:108-125`).
3. **Passphrase** (`src/ui/create.tsx:74-97`): two password fields, a live hint, and the loss warning (`src/ui/components.tsx:178-185`). The rule is at least 12 characters and an estimated 60 bits (`src/passphrase.ts:24-25, 72-87`).
4. **Recovery code** (`src/ui/create.tsx:99-130`): 12 BIP-39 words in a three-column grid and the 26-character base32 form, a checkbox "I saved the recovery code", Next. No copy, print or download control.
5. **Confirm** (`src/ui/create.tsx:132-169`): type the whole code back, words or base32.
6. **Relays** (`src/ui/create.tsx:171-235`): two textareas prefilled with `wss://nos.lol`, `wss://relay.ditto.pub` (storage) and `wss://auth.nostr1.com` (inbox) (`src/setup/create.ts:32-33`). "Check relays" runs the probes of spec 9.1 and lists each relay with "(storage)" or "(inbox)" and "passed" or "refused: <check name>" (`src/ui/components.tsx:117-136`). "Create queue" stays disabled until every probe has passed for the exact text in both boxes.
7. **Done** (`src/ui/create.tsx:238-245`): "This device holds the queue key and is unlocked." Done returns to the home screen.
8. **Home** (`src/ui/app.tsx:167-224`): the queue npub in monospace, "On this page" (the insert panel), "Drafts", then "Approve an agent" (the one primary button), "Agents and pending destinations", "Pair a new device", "Lock", and the "Stay unlocked on this device" checkbox with its warning. With PR #69 a "Destinations" button sits under "Approve an agent".

A new user takes five screens, two passphrase entries, one checkbox, a 12-word transcription, two relay clicks and a Done before reaching a home screen that has no drafts, no destinations and no agents.

### Friction

| # | Friction | Fix | Freq | Effort |
|---|---|---|---|---|
| 1.1 | The welcome copy leads with "Nostr relays" and "queue key"; a user who wants drafts from Claude in X's composer has no reason to know either. | Lead with what the extension does ("Drafts from you and your agents, inserted into the page you're on; you still press Post"). Move relays and keys to a "How it works" line. | once | S |
| 1.2 | The passphrase hint says "At least 12 characters; a few unrelated words work well", but twelve lowercase letters score 56 bits and are refused with "Too easy to guess; make it longer." Two short words with a space ("horse table", 11 characters) fail on length. The user learns the real rule by trial. | State the rule the code applies ("12 or more characters; three or four unrelated words, or mix in capitals or digits"), or show a strength bar from `bits` so the user sees how close they are. | once | S |
| 1.3 | The recovery code has no copy, download or print control, though the screen offers the base32 form "for printing". The user has to transcribe 12 words by hand. | Add "Copy" and "Download recovery sheet" (a text or PDF file with the code, the queue npub and the storage relays; see 8.1). Keep the typed confirmation. | once | S |
| 1.4 | The confirm step makes the user type the full 12 words (or 26 characters) straight after writing them down. It proves they wrote something, at the cost of a minute of typing. | Ask for three of the twelve words, chosen at random, or the base32 string, which is shorter to type. Spec 11.3 says "type it back", so a partial check needs the spec changed too. | once | S |
| 1.5 | The relay step is a decision almost no user can make: two textareas of `wss://` URLs, the terms "storage relay" and "inbox relay", and probe results named after their internal checks. | Probe the defaults automatically when the step opens and show one line ("Your queue will be stored on 2 public relays. Checked."). Put the textareas and probe details behind "Use other relays". | once | S |
| 1.6 | "Check relays" and "Create queue" are two clicks for one intent, and editing either textarea after a pass silently disables Create until the user probes again (`probedFor` in `src/ui/create.tsx`). | One "Create queue" button that probes first and creates if every probe passes, or reports the failing relay. | once | S |
| 1.7 | After Done the home screen offers no next step. Nothing in the extension says that agents connect at `https://app.qus.me/mcp`, how to add a connector in Claude, or that the queue needs destinations. The 2026-11-05 run worked because the operator already knew the URL. | A first-run checklist on the home screen until each is done: "Add the place you post (X as @you)", "Connect an agent: add `https://app.qus.me/mcp` as a connector" with a copy button and per-client instructions, "Pair your phone". | once | S |
| 1.8 | The npub at the top of the home screen is the only identifier shown, and it means nothing to the user; yet recovery needs it and setup never asks the user to keep it (8.1). | Drop it from the home screen; show it on the recovery sheet (1.3) and in a settings or "About this queue" view. | every use | S |
| 1.9 | "Stay unlocked on this device" is offered only on the home screen, after the user has already met the unlock cost once, and its warning reads as a reason not to use it. | Ask once at the end of setup, with the trade-off stated in one line each way. Keep the checkbox in settings. | once | S |
| 1.10 | Loading unpacked is the only install path today, and nothing tells the user to pin the icon, which is the only entry point besides the context menu. | For store builds, an onboarding tab on install (`runtime.onInstalled` opening `popup.html` in a tab) that ends with "Pin qus.me to your toolbar". | once | S |

## 2. Unlock and lock

### As built

- The unlocked keys live in `storage.session`, which the browser clears on restart, so every browser start ends in the Unlock screen unless "Stay unlocked" is on (`src/keyStore.ts`, spec 6.1).
- Unlock (`src/ui/app.tsx:127-165`): one password field and an Unlock button. The key is NIP-49 at `log_n` 18: about 1.3 s on a fast machine (spec section 17), several seconds on a slow laptop. The button reads "Unlocking…" meanwhile. A wrong passphrase gives "That passphrase does not unlock this queue." (`src/keyStore.ts:93-95`).
- Lock is a button on the home screen; it deletes the keys, the decrypted drafts and the armed draft. There is no automatic lock on idle.
- The sync alarm exists only while unlocked (`entrypoints/background.ts:26-37`), so a locked browser receives nothing; drafts wait on the inbox relay until the next unlock.
- An approval link (`popup.html?approve=CODE`) goes to the approval screen after unlock (`src/ui/app.tsx:39`, `entrypoints/popup/main.tsx:17`), but nothing produces that link (4.4).

### Friction

| # | Friction | Fix | Freq | Effort |
|---|---|---|---|---|
| 2.1 | Every browser start costs a passphrase and a multi-second scrypt before the first insert. For a daily user that is the most frequent cost in the product after inserting itself. | Keep the passphrase, but let the user choose the lock policy at setup (1.9): "on browser restart" (today), "after N hours idle", or "never on this device". With the default unchanged this is a choice, not a weaker baseline. | weekly | M |
| 2.2 | The context menu on a locked browser: "qus.me: choose a draft to insert…" opens the popup on the Unlock screen, and after unlocking the user lands on home with the drafts still syncing; the insert they started is forgotten. | After unlock, return to the screen the user came from (the insert panel scrolled to this page's drafts), and wait for the first sync before showing "No drafts for this page". | weekly | S |
| 2.3 | Unlock shows no sign of what it is waiting on beyond "Unlocking…", and on a slow machine several seconds read as a hang. | A determinate or at least animated indicator, and the text "Opening your queue (a few seconds)". | weekly | S |
| 2.4 | "Lock" sits among the main actions with the same weight as "Pair a new device", one click, no confirmation, and it discards decrypted drafts and the armed draft. | Move it to a menu or the header as an icon; nothing is lost that a sync cannot restore, so no confirmation is needed, only less prominence. | rare | S |
| 2.5 | While locked nothing syncs, so drafts an agent sent overnight appear only after unlock plus one sync, with no indication on the toolbar that anything is waiting. | Nothing can be read without the key, but the badge can say "locked" (a lock glyph) so the user knows why the count is missing. | weekly | S |

## 3. Adding destinations

### As built on `main`

There is no way for the user to add a destination. A destination exists only when an agent whose grant allows new destinations submits for a site and account the queue doesn't have; ingestion then creates it as `pending` with the label `<site> / <account>` (`packages/nostr/src/ingest.ts:298-311`). The user confirms or rejects it under "Agents and pending destinations" (`src/ui/agents.tsx:449-481`, `src/agents/destinations.ts:53-111`). This is why the 2026-11-05 run had to turn on "Let it propose new destinations": with no destinations, nothing else lets an agent draft.

### As built on PR #69

- A "Destinations" screen lists every destination, confirmed first, then pending ones, which point to Agents for confirm or reject (`src/ui/destinations.tsx`).
- Add: a site `<select>` from the registry definitions (today only X), an account field, "Detect from this tab" (runs the site's account locator under activeTab, `src/insertion/detect.ts`), and a label that defaults to `<site name> / <account>`. "Custom…" asks for a site id ("Lowercase letters and digits, such as myblog") and match patterns ("One per line, such as https://blog.example/*").
- Edit: label and "Override (JSON)" ("Merged over the site's definition. Empty for none.").
- Remove: asks first, then dismisses the destination's active drafts and removes it.
- The insert panel offers "Add <account> on <site> as a destination" when the tab is on a registry site, an account is detected there, and no destination has it.

### Friction

| # | Friction | Fix | Freq | Effort |
|---|---|---|---|---|
| 3.1 | On `main` a fresh queue has no way to get a destination, so the first approval has nothing to share and the user must grant an open-ended "propose anything" to make the agent useful. | Merge PR #69. | once | S |
| 3.2 | Adding or confirming a destination doesn't change any agent's grant, and grants can't be edited ([#60](https://github.com/lokkju/qusme/issues/60)). An agent approved before the destination existed never sees it in `list_destinations`, and with "propose new" off it gets `destination_not_granted`. The only remedy today is to revoke the agent and approve it again. | After adding or confirming a destination, offer "Share with: [ ] Claude [ ] …" listing current agents, and republish their grants. This is #60's grant editing reached from the place the user is already in. | weekly | M |
| 3.3 | Accounts are compared exactly in ingestion and at the service (`ingest.ts:298-300`, `packages/core/src/mcp/server.ts:157-159`), while the extension compares them without `@` and without case (`src/insertion/matching.ts:52-53`) and PR #69 stores them without `@`. An agent that writes `@lokkju` or `Lokkju` for a destination stored as `lokkju` gets `destination_not_granted`, or, with "propose new" on, creates a second pending destination for the same account. | Normalize accounts once in `@qusme/nostr` (strip a leading `@`, lowercase for sites whose handles are case-blind, a flag in the site definition) and use it in the service's `findDestination`, in ingestion's lookup and in `pendingDestinationId`. Say in `list_destinations` and `get_definition` how accounts are written. | weekly | S |
| 3.4 | Pending destinations are reachable only through "Agents and pending destinations", a secondary button with no count on it. The home screen doesn't say anything is waiting. | Show "1 new place an agent proposed" on the home screen with Confirm and Reject inline, and fold the count into the badge (5.2). | weekly | S |
| 3.5 | Confirming has less effect than the screen implies. Drafts for a pending destination already show in the popup's "On this page" (`draftsForPage` ignores status, `src/insertion/matching.ts:96-128`); only the context menu is limited to confirmed destinations (`documentUrlPatterns`, line 141). The user is asked to decide without being told what the decision changes. | Either treat pending drafts the same everywhere and make confirmation only about keeping the destination, or hide pending drafts from insertion until confirmed. Then say which in one line on the pending item. | weekly | S |
| 3.6 | On PR #69, "Custom…" asks for a site id and match patterns, and Edit asks for override JSON. Both assume the user knows WebExtension match patterns and the site definition format. | For custom destinations, ask for a URL ("the page where you write") and derive the pattern from its origin; keep raw patterns and override JSON under "Advanced". | rare | S |
| 3.7 | The insert panel's "Add <account> on <site>" offer is good, but appears only on a site the registry knows and only while drafts or registry sites match the tab; there is no prompt on first run to go to X and use it. | Name it in the first-run checklist (1.7): "Open x.com and click the qus.me icon to add your account". | once | S |
| 3.8 | A pending destination proposed for a site the registry lacks gets no `match` (its override is the agent grant's, usually null), so its drafts land under "drafts for other sites" and the context menu never appears. Nothing tells the user why. | On the pending item, say "qus.me doesn't know where this site's composer is; add the page address" and take a URL as in 3.6. | rare | S |

## 4. Connecting an agent

### As built

1. In the MCP client (Claude: Settings, Connectors, add custom connector), the user enters `https://app.qus.me/mcp`. Nothing in the extension or on app.qus.me tells them this URL (1.7).
2. The client opens the authorize page (`packages/core/src/oauth/pages.ts:90-129`): "Approve on a qus.me device", "<client name> (<host>) wants to submit drafts to your queue.", "Open qus.me on a paired device and enter this code, or scan it.", the code `XXXX-XXXX`, a QR of `https://app.qus.me/approve?code=…`, and a status line that polls every 2 s: "Waiting for your device…", then "Waiting for approval on your device…" once a device has fetched it, "Approved. Returning to the app…", or "This request expired. Start again from the app." The request expires after 10 minutes (`docs/oauth.md`, "Lifetimes"); the page receives `expiresAt` but doesn't show it.
3. The user opens the popup (unlocking first if needed), presses "Approve an agent", and types or pastes the code (`src/ui/agents.tsx:268-322`). Pasting the QR's link works too (`src/agents/code.ts`). "Look up" first requests the optional host permission for app.qus.me (the browser's own prompt, the first time only), then fetches the request.
4. The review screen (`src/ui/agents.tsx:65-97, 100-247, 365-381`): the client name, "Client ID host (who published this client):" in large type, then Client ID, "Returns to", "Scope: drafts:submit", "Agent key: npub1…"; the trust warning when name and host differ. Then the grant form: Label (defaults to the client name), "Where it may draft" (a checkbox per confirmed destination, each with a free-text fields input defaulting to `text`), "Let it propose new destinations" (off), Quota (50) and Period (per day), "Unread submissions expire after (days)" (30, 1 to 90), "Access ends on" (a date, empty for none). Approve and Deny.
5. Approve re-reads the queue from every storage relay, publishes the submitters list and the grant to all of them, and posts the approval, retrying a 409 for about 7.5 s (`src/agents/approve.ts`, `APPROVAL_RETRY_MS`). The screen then says "Go back to the client's page; it finishes signing in on its own." The authorize page's next poll redirects to the client.

The user switches between two windows (the client and the authorize tab) and the popup, copies or retypes one code, makes up to six decisions, and confirms twice.

### Friction

| # | Friction | Fix | Freq | Effort |
|---|---|---|---|---|
| 4.1 | The code has to be read off one page and typed into the popup. The popup can read the authorize tab already: opening the popup grants activeTab on it, and the page is the service's own. | When the active tab is `https://app.qus.me/authorize/*`, have the popup read the code from that page (`scripting.executeScript` under activeTab, or put the code in a `data-` attribute for it) and open straight on the review screen with the code filled in. The `?approve=` route already exists for this. | once per agent | S |
| 4.2 | The authorize page assumes qus.me is installed and that the user knows what "a paired device" is; a user without the extension reaches a dead end. | Say "Open the qus.me extension in this browser and click Approve an agent", with a link to install it (store listing once there is one) for a user who doesn't have it, and show the time left from `expiresAt`. | once per agent | S |
| 4.3 | The QR is for the PWA; on the desktop flow, which is the common one, it takes space and invites a scan that leads only to the help page (`pages.ts:139-147`). | Keep the QR, below the code and labeled "On your phone, scan with the qus.me app". Add a "Copy code" button (the page already runs a nonce'd script). | once per agent | S |
| 4.4 | The popup closes as soon as the user clicks back into the authorize tab to check the code, losing what was typed. | Solved by 4.1; otherwise by the side panel (section 10). | once per agent | S |
| 4.5 | The review screen shows Client ID, Scope `drafts:submit` and an agent npub. Only the host matters for the trust decision, and the spec (11.8) asks for the label, the host and the destinations, not the rest. | Keep the host prominent, move Client ID, scope and agent key under "Details". | once per agent | S |
| 4.6 | Six controls (label, destinations with field names, propose-new, quota, period, expiry days, end date) for a decision most users make with the defaults. The fields input asks for internal field names (`text`). | Show destinations and the propose-new toggle; put quota, expiry and end date under "Limits" with the defaults stated in one line ("Up to 50 drafts a day; unread drafts expire after 30 days"). Show fields as checkboxes from the site definition, not a comma list. | once per agent | S |
| 4.7 | The form lets the user approve an agent that can do nothing: no destinations ticked and propose-new off. The agent then gets `destination_not_granted` on every call, and the grant can't be edited (#60), so the fix is revoke and approve again. | When no destination is ticked and the toggle is off, say so above Approve and ask "Approve anyway?"; when the queue has no confirmed destinations, start with the toggle on and say why. | once per agent | S |
| 4.8 | When the queue has destinations, none is ticked by default, so the common case (share my one X account) needs a click the user can miss, leading to 4.7. | Tick every confirmed destination by default when there are three or fewer. | once per agent | S |
| 4.9 | Error messages expose the protocol: "The service did not find the agent on the queue's submitters list (agent_not_in_submitters_list). The list was published; try approving again in a moment.", "Could not reach wss://… Every storage relay must be reachable.", "The agent grant was not saved on every storage relay: …" (`src/agents/approve.ts`, `src/agents/queue.ts:74-93, 191-203`). | Lead with what the user can do ("Couldn't save the approval. Check your connection and press Approve again."), with the relay detail under "Details". | rare | S |
| 4.10 | "Go back to the client's page; it finishes signing in on its own." is right, but the popup can't take the user there and Claude then shows a connector with no hint of what to ask. | After approval, show "Now ask your agent to draft something, for example: 'Draft a post for X as @you about …'" with the destination names filled in. | once per agent | S |

## 5. Drafts arriving and the draft list

### As built

- An agent's `create_draft` publishes a gift wrap to the inbox relay. The extension picks it up only on a sync: when the popup opens (`src/ui/drafts.tsx:101-133`) or on the 5-minute alarm while unlocked (`src/sync/messages.ts`, `entrypoints/background.ts`). In the 2026-11-05 run the user opened the popup to make it sync.
- The home screen lists active drafts twice: in "On this page" (drafts matching the tab, with Arm) and in "Drafts" (every active draft, read-only) (`src/ui/app.tsx:182-183`). A "Drafts" item shows `site / account · field`, the first line cut to 80 characters, and "from <agent label>" (`src/ui/drafts.tsx:62-75`). No date, no full text, no actions.
- Under the list, "Last sync: N new from agents, M junk discarded, K waiting for the next sync." and any relay errors verbatim (`src/ui/drafts.tsx:77-98`). The empty states are "Not synced yet." and "No active drafts.".
- The badge shows `!` only for an insertion not yet recorded on the relays (`src/insertion/browser.ts:93-96`).
- Editing, dismissing, restoring and an archive view are missing ([#58](https://github.com/lokkju/qusme/issues/58)). So is "Save to qus.me" from a field (spec 11.7).

### Friction

| # | Friction | Fix | Freq | Effort |
|---|---|---|---|---|
| 5.1 | Nothing signals that a draft arrived. The user has to open the popup to find out, and if the alarm hasn't run, the draft appears only after the popup's own sync finishes. | Set the badge to the number of active drafts after each sync, and to the number for the current site when the tab matches (the background knows the tab only after a gesture, so the global count is the reliable one). | every use | S |
| 5.2 | Pending destinations, unrecorded insertions and new drafts have no shared indicator; only the last gets the `!`. | One badge rule: count of active drafts, with a distinct colour when something needs the user (pending destination, unrecorded insertion, rotated queue). | every use | S |
| 5.3 | The same drafts appear twice on the home screen, once with Arm and once without, so the user can't tell which list to act on. | One list, grouped "For this page" and "Elsewhere", each row with its action. The current "Show drafts for other sites" toggle becomes the second group. | every use | S |
| 5.4 | Only the first 80 characters of the first line are shown, so a user can't review a thread or a long post before inserting it; "the human insertion step is the review gate" (spec 13), but the review happens in the composer after insertion. | Expand a row to show the full text (as text, never HTML), with the character count against the field's limit from the `validation` tag. | every use | S |
| 5.5 | No way to discard a draft the user doesn't want, short of inserting it somewhere and deleting it, or rejecting a pending destination (which dismisses every draft for it). | #58: Dismiss on each row, Restore in an archive view. | weekly | M |
| 5.6 | No time on a draft, so two drafts from the same agent for the same account can't be told apart except by text. | Show a relative time ("2 h ago") from `updatedAt`. | every use | S |
| 5.7 | "Last sync: 0 new from agents" shows on every open and relay errors appear verbatim ("wss://auth.nostr1.com refused AUTH as the inbox key: …"). | Show the sync line only when something happened or failed; turn errors into "Couldn't check for new drafts (1 relay unreachable)" with the detail behind it. | every use | S |
| 5.8 | "The inbox has had more submissions than one sync opens for N syncs in a row. If you didn't expect that many, rotate the inbox key." names an action the extension doesn't offer. | Offer the rotation as a button when it exists; until then, say "An agent may be sending too many drafts; revoke it under Agents." | rare | S |
| 5.9 | "This queue has been rotated to a new key. Pair this device with one that holds it." appears inside the Drafts section and offers no button. | Make it a full-screen state with "Pair this device" leading to the pairing screen. | rare | S |

## 6. Arming and inserting

### As built

1. The user opens the popup on the destination's page. Under activeTab the popup reads the tab URL and runs the read-only account detection (`src/ui/insert.tsx:245-286`, `src/insertion/browser.ts:62-83`).
2. "On this page" shows "Signed in to x as lokkju." or "Couldn't tell which x account is signed in; showing drafts for every account.", then matching drafts, each with an "Arm" button, and "N drafts for other accounts hidden." (`src/ui/insert.tsx:120-163`).
3. Arm puts the draft in a box "Armed:" with Insert and Disarm and the line "Insert puts it into the field focused on the page. Right-clicking a field also offers it." (`src/ui/insert.tsx:165-184`). The context menu title becomes "Insert: <first 40 characters>…" on the destinations' pages (`src/insertion/menu.ts`).
4. Insert sends the tab id to the background, which injects the insertion script and runs the field's chain: focused element first, then the field's locators, then "click into the field" (`src/insertion/service.ts:116-169`, `src/insertion/page/run.ts`).
5. The status line reads "Inserted (paste). The draft is archived.", "Click into the field where the draft should go.", "The draft is on the clipboard. Click into the field and press Ctrl+V.", "The field changed but doesn't match the draft. Check it before posting." or another failure (`src/ui/insert.tsx:42-72`).
6. On success the draft is archived at once (`archived:inserted`), whether or not the user then posts.

For the common case (one draft for X, composer open) this is: open popup, Arm, Insert, then click Post on X. Three clicks in the extension, of which one (Arm) is bookkeeping.

### Friction

| # | Friction | Fix | Freq | Effort |
|---|---|---|---|---|
| 6.1 | Arm and Insert are two steps for one intent. Arming exists for the context menu, but from the popup the user always wants both. | An "Insert" button on each row that arms and inserts in one click; keep arming as the side effect so the context menu still offers it afterwards. | every use | S |
| 6.2 | The popup closes when the user clicks into the page. If the composer wasn't focused before the popup opened, the user has to read "Click into the field…", click (which closes the popup), and trust the page notice. The order "open composer first, then open the popup" is never stated. | Say it before it matters: on a page with matching drafts and no focused field, "Open the composer first, or press Insert and then click into it". Longer term, the side panel (section 10) removes the problem. | every use | S |
| 6.3 | No keyboard path. Every insert needs the mouse on the toolbar icon or a right-click. | A `commands` shortcut (for example Alt+Shift+Q) that inserts the armed draft into the focused field, or opens the popup when nothing is armed. A command grants activeTab in Chrome and Firefox, so it stays within spec 11.2. | every use | M |
| 6.4 | Strategy names appear in the success message ("Inserted (paste)."). | "Inserted. Review it and press Post." The strategy goes in the `inserted` tag already. | every use | S |
| 6.5 | Insertion archives the draft immediately. A user who inserts, edits, then abandons the post has lost the draft from the active list with no way back (#58). | Keep archiving on insert (spec 4, 11.5), and add "Undo" in the status line for the rest of the popup session plus Restore in the archive view. | weekly | S |
| 6.6 | The context menu appears only on confirmed destinations' sites (`documentUrlPatterns`, `src/insertion/matching.ts:135-148`), so after an agent proposes a destination the right-click path is missing until the user confirms it under Agents; nothing explains this. | Follows from 3.5; if pending drafts are insertable, include pending destinations' patterns in the menu. | weekly | S |
| 6.7 | When detection fails, drafts for every account are shown with the account appended, but nothing warns that inserting a draft meant for another account would post it from the wrong one. | When detection fails and drafts for more than one account match, show the account prominently on each row and say "qus.me couldn't see which account you're signed in as". | weekly | S |
| 6.8 | "This tab can't take drafts." appears on every non-http page, including the new tab page, where the user may have opened the popup only to approve an agent or check drafts. | Hide the "On this page" section entirely on such tabs. | weekly | S |
| 6.9 | "N insertions not recorded on the relays yet. Retry" asks the user to understand relays to judge whether it matters. | "N inserted drafts couldn't be marked done yet; they may show again on your other devices. Retry." | rare | S |

## 7. Second device pairing

### As built

Existing device (source), from home, "Pair a new device" (`src/ui/pair.tsx:306-460`):

1. "Connecting…", then a QR of the `nostrpair://` URI, "Copy pairing link", and "The new device has no camera: use a typed code". The typed code (8 characters) comes with "It will then ask for your recovery code instead of your passphrase."
2. "Compare the codes": a six-digit code, "Yes, they match" or "No".
3. "Sent. Waiting for the new device to confirm…", then "Paired" or "Transfer sent: check your other device".

New device (target), from Welcome, "Pair with a device that has the queue" (`src/ui/pair.tsx:28-155`):

1. Paste the link or type the code ("A nostrpair:// link, or 8 letters and digits."). A code first requests the app.qus.me permission.
2. "Compare the codes": the same six digits, confirm.
3. "Receiving the key…"
4. "Unlock the received key" (`src/ui/pair.tsx:161-303`): the other device's passphrase (QR or link) or the recovery code (typed code), then a new passphrase for this device twice, the loss warning, and, if the relay list didn't match, a relay URL field. Finish.

Both sides must finish within the NIP-AB session (120 s for a typed code, spec 8.3), and the source waits 30 s for `complete`. Both screens offer "Open in a tab so this stays open while you use your other device." (`src/ui/app.tsx:96-103`).

### Friction

| # | Friction | Fix | Freq | Effort |
|---|---|---|---|---|
| 7.1 | Desktop to desktop, the QR is useless (no camera) and the link has to get from one computer to the other by some channel the user supplies (chat, email). The typed code avoids that but then asks for the recovery code, which a user may have filed away. Neither path is easy for the most common second device, a second computer. | State the choice plainly on the source: "Your other device has a camera (phone): scan this. Another computer: use a code (you'll need your recovery code)." For computers, the typed code is the main path; say on the setup recovery sheet (1.3) that pairing a computer needs it. | rare | S |
| 7.2 | The popup closes when the user switches to the other device's window or clicks anywhere, which kills the source session. "Open in a tab" is a footnote, and it opens `popup.html` on the home screen, so the user must press "Pair a new device" again and the session they had is gone (`src/ui/browserDeps.ts`, `openInTab`). | Start the source side in a tab by default (`popup.html#pair-source`), and make `openInTab` keep the route for every screen it appears on. | rare | S |
| 7.3 | The target asks for three secrets in one form: the other device's passphrase, then a new passphrase twice. Users will reasonably wonder whether they may reuse the same passphrase, and the form doesn't say. | Ask in two steps: "Passphrase you use on your other device" (unlock), then "Use the same passphrase here?" with a default of yes and a field only if they choose a new one. | rare | S |
| 7.4 | The six-digit comparison is required by NIP-AB, but neither screen says what to do if the user can't see both screens at once, or that "No" aborts on both. | One line: "Check that both screens show the same six digits; if not, press No and start again." | rare | S |
| 7.5 | Copy mentions "nostrpair:// link" and the hint expects users to recognise it. | "The pairing link (it starts with nostrpair://)". | rare | S |
| 7.6 | "The queue's settings were not found, so agent drafts can't be read here yet." gives no next step. | Say what to do (sync again from the source device, or check its relays) and retry on the next sync automatically. | rare | S |
| 7.7 | A timeout reads "Pairing timed out. Start again on both devices." without saying how long the user had. | Show a countdown on the source screen while waiting for the new device. | rare | S |

## 8. Recovery

### As built

From Welcome, "Recover with the recovery code" (`src/ui/recover.tsx`): three fields, "One of the queue's storage relays" (placeholder `wss://nos.lol`), "The queue's npub", and "Recovery code"; "Recover" fetches the backup with a throwaway key (`src/setup/recover.ts:54-85`) and opens it. Then "Choose a passphrase" (twice) and the loss warning. The result screen may add "The queue's relay list was not found, so this device uses the relay you entered." or "The queue's settings were not found, so agent drafts can't be read here yet."

### Friction

| # | Friction | Fix | Freq | Effort |
|---|---|---|---|---|
| 8.1 | Recovery needs the npub and a storage relay, but setup never asks the user to keep either. The create flow shows only the recovery code (`src/ui/create.tsx:99-130`); the npub appears only on the home screen of a device the user may have lost. A user with only the 12 words is stuck at the second field. | Put the npub and the storage relays on the recovery screen at setup and in the recovery sheet (1.3), and check them in the confirm step. Longer term, make the code alone sufficient: derive a lookup tag from the recovery code and publish the backup on the default relays under it (a spec change to 6.1 with its own privacy review). | rare | S (L for code-only) |
| 8.2 | The relay field defaults to nothing, though most users will have kept the defaults. | Prefill `wss://nos.lol` and try the other default relay as well if the first has no backup. | rare | S |
| 8.3 | "That is not an npub." and "No recovery backup for that npub on that relay." assume the user knows what an npub is. | "Queue ID (starts with npub1, on your recovery sheet)". | rare | S |
| 8.4 | The recovery screen doesn't say that recovering a lost device should be followed by rotating the queue key (spec 6.1), and rotation isn't built. | Once rotation exists, end recovery with "If a device was lost or stolen, rotate the queue key" and a button. | rare | M |
| 8.5 | "Recover with the recovery code" on Welcome is also the path for a forgotten passphrase on an existing device, but the Unlock screen offers no link to it; the user has to know to remove the extension's data first. | Add "Forgot your passphrase? Use your recovery code" under Unlock, which replaces the local key after recovery. | rare | S |

## 9. Agent revocation

### As built

Under "Agents and pending destinations" (`src/ui/agents.tsx:541-624`), each agent shows its label, client host, "calls itself …" when the label differs, a short agent npub, "N destinations, may propose new ones, up to 50 per day", and "Revoke…", which asks "Revoke now" or "Keep". Revoking first requests the app.qus.me permission, then publishes the submitters list without the agent, a deletion request for its grant, and tells the service (`src/agents/revoke.ts:50-93`). The result is a sentence assembled from parts: "Removed from the submitters list; its drafts are refused from now on. The service destroyed its key." or "The service was not told (no permission)."

### Friction

| # | Friction | Fix | Freq | Effort |
|---|---|---|---|---|
| 9.1 | The result message speaks in protocol terms ("submitters list", "The service destroyed its key") and assembles up to four sentences. | "Claude can no longer send drafts. Remove the connector in Claude too." with details behind it. | rare | S |
| 9.2 | If the user declines the permission prompt, the service keeps the agent's tokens; on a relay that ignores the grant deletion the agent still finds its grant, and `create_draft` keeps returning receipts while devices silently discard the drafts at ingestion. From the agent's side, and so from the user talking to it, everything works. | Don't offer revocation without the service step: request the permission at approval time (the first approval already needs it), and if revocation can't reach the service, say plainly that the agent will still appear to work and retry on the next sync. | rare | S |
| 9.3 | The agent row shows an npub and offers no other management: no "last draft received", no grant details, no edit (#60). | Show destinations shared, quota use, last submission time; add "Edit access" with #60. | rare | M |
| 9.4 | After revocation, Claude's connector fails with an authorization error the next time it is used, and Claude will offer to reconnect, which starts a fresh authorize page that the user may approve without remembering why they revoked. | On the authorize page, show "You revoked this client on <date>" when the client id matches a revoked binding for the queue, if the service can know it without learning the queue at fetch time; otherwise say on the extension's review screen "You revoked an agent from this host before". | rare | M |

## 10. The surface: popup, Chrome side panel, Firefox sidebar

### How the popup fits "pick a draft, click into the composer, insert"

The popup is opened by the action click, which grants activeTab on the current tab; everything the extension does to the page follows from that grant (spec 11.2, `src/permissions.ts`). The popup closes when the user clicks anywhere outside it, including into the page. The current flow works around this: the composer must already be focused when the popup opens, and Insert targets "the field focused on the page"; otherwise the insertion script asks for a click and waits up to two minutes (`src/insertion/page/run.ts:49`), reporting back to the background after the popup is gone. Approving an agent and pairing suffer the same closing: the user has to look at another window while the popup holds state.

### Side panel (Chrome) and sidebar (Firefox)

| Aspect | Popup (today) | Chrome side panel | Firefox sidebar |
|---|---|---|---|
| Manifest | `action.default_popup` | `side_panel.default_path`, permission `sidePanel` (no install warning) | `sidebar_action.default_panel`, no permission |
| WXT | `entrypoints/popup` | `entrypoints/sidepanel`, which WXT emits as `side_panel` for Chrome and `sidebar_action` for Firefox (to verify against the pinned WXT version) | same entrypoint |
| Opening | Action click | `sidePanel.open()` inside a user gesture, or `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` | `sidebarAction.open()` inside a user gesture, or the sidebar menu |
| Stays open while the user clicks into the page | No | Yes, per window or per tab | Yes, per window |
| activeTab | Granted by the action click that opens it | Granted by the action click, context menu and keyboard commands; a click inside the panel does not grant it. Whether the action click still grants it when it opens the panel through `openPanelOnActionClick` must be tested | Same: action click, context menu, commands grant it; a click in the sidebar does not |
| When the grant ends | The popup closes first | On navigation or when the user moves to another tab; X is a single-page app, so whether its in-app route changes end the grant must be tested | Same |

What this means for the flow:

- A side panel can hold the draft list while the user moves between the composer and the list, which removes 6.2 and 4.4. It also suits approval (the code stays visible beside the authorize tab) and pairing (the session survives switching windows).
- It cannot insert by itself: a click in the panel grants nothing. Insertion would still need a granting gesture on the page: the context menu (already built), the keyboard command of 6.3, or the action click. The natural pattern is "pick in the panel, which arms; then right-click or press the shortcut in the composer". That is two gestures in two places, against one Insert button in the popup when the composer was focused first.
- The alternative that lets a panel button insert directly is a host permission for each destination's origin, requested when the destination is added. That contradicts spec 11.2 ("no host permissions for any site the user posts to"), shows a per-site permission prompt, and in Chrome shows as "Read and change your data on x.com". It is the user's call whether the convenience is worth it; it should be an opt-in per destination, if at all.
- Account detection on page load would also need either a grant or a host permission, so a panel opened before the user's gesture shows drafts without the "Signed in as" filter until a gesture happens.

The cheapest change with the largest effect is the keyboard command (6.3), which works with either surface. A side panel is worth building for approval, pairing and draft review; the popup stays for the quick insert on a page where the composer is already open. Both can share the same Preact screens.

## 11. What the authorize page and the MCP tools tell the user and the agent

### Authorize page (`packages/core/src/oauth/pages.ts`)

| State | User sees | Gap |
|---|---|---|
| Opened | Title, "<client> (<host>) wants to submit drafts to your queue.", "Open qus.me on a paired device and enter this code, or scan it.", code, QR | Assumes qus.me is installed and paired; no install link; no time limit shown (4.2, 4.3) |
| Device fetched the request | "Waiting for approval on your device…" | Good: confirms the code reached the extension |
| Approved | "Approved. Returning to the app…", then redirect | Good |
| Denied | Redirect with `error=access_denied`; the page shows nothing first | The client decides what to show; a line "Denied on your device" before the redirect would help |
| Expired | "This request expired. Start again from the app." | No time shown before it happens |
| QR opened in a plain browser | "Approve in qus.me", "Open the qus.me extension or app on a device paired with your queue, choose to approve an agent, and enter this code." | Correct; the same install link would help here |

### MCP server instructions (`packages/core/src/mcp/server.ts:398-406`)

"Drafts for the user to review and post: list_destinations shows where you may draft, get_definition the constraints of a field, create_draft submits a value. Nothing is posted until the user inserts it." This tells the agent nothing about how accounts are written (3.3), that drafts reach the user only when the extension syncs, that a draft for a new destination waits for the user's confirmation, or what to do when the grant has no destinations.

### Tools, per step

| Step | Tool response as built | What the agent can tell the user | Fix |
|---|---|---|---|
| First call, no destinations, propose-new off | `list_destinations`: `destinations: []`, `allow_new_destinations: false`, quota | Nothing useful; it will try `create_draft` and fail | Add a `hint` string: "The user has shared no destinations with you. Ask them to share one in the qus.me extension (Agents)." |
| First call, no destinations, propose-new on | Same with `allow_new_destinations: true` | It must guess the site id (from `list_registry`) and the account form | Hint: "Use a site id from list_registry and the account handle without @; the user confirms new destinations in qus.me." |
| `create_draft` succeeds | JSON with `gift_wrap_id`, `created_at`, `expires_at`, `relays` (wss URLs), `validation`, `pending_destination` (`server.ts:387-395`); the text content is the same JSON | The agent tends to report the gift wrap id and relay URLs, which mean nothing to the user | Add a plain `message`: "Queued for X as @lokkju. It shows in the qus.me extension within 5 minutes, or when the user opens it; nothing is posted until they insert it." When `pending_destination` is true: "This is a new destination; the user confirms it in qus.me." |
| Value too long | `constraint_violation` with violations, the validation JSON and `lenient_allowed` | Enough for the agent to shorten and retry | Fine as is |
| Destination not shared | `destination_not_granted`, "this destination is not in the agent grant" | The agent can't tell the user how to fix it | Add: "Ask the user to share <site>/<account> with this agent in qus.me." Pair with 3.2 so the user can |
| Grant missing or relays down | `grant_not_found`, "no grant for this agent was found on the queue's storage relays" | Exposes relays; doesn't distinguish "revoked" from "relay unreachable" | Two codes: `grant_not_found` ("The user may have revoked this agent; ask them to reconnect") and `grant_unreachable` ("qus.me couldn't reach the user's storage; try again later") |
| Quota used | `quota_exhausted` with `resets_at` | Enough | Fine |
| Publish failed | `publish_failed` with each relay's message | Enough for retry; relay text may confuse a user | Add "Try again in a minute" |
| `list_submissions` | Receipts: gift wrap id and times | The agent can say how many it sent, not whether the user saw or used them | By design (spec 8.4); say so in the description, which it already does |

## 12. The ten highest-value changes

Ranked by how often a user meets the problem, how badly it blocks them, and the effort.

1. Arming and inserting: one "Insert" button per draft row that arms and inserts in one click (6.1).
2. Arming and inserting: a keyboard command that inserts the armed draft into the focused field or opens the picker, granting activeTab (6.3).
3. Drafts arriving: badge with the active draft count after every sync, distinct colour when something needs the user (5.1, 5.2).
4. Install and first run: a first-run checklist with the MCP URL `https://app.qus.me/mcp` and a copy button, "add your X account", "pair your phone" (1.7).
5. Recovery: show the npub and storage relays with the recovery code at setup and in a downloadable recovery sheet, since recovery can't proceed without them (8.1, 1.3).
6. Connecting an agent: read the code from the authorize tab under activeTab and open the review screen pre-filled (4.1).
7. Connecting an agent: refuse to approve, without a warning, an agent with no destinations and propose-new off; tick confirmed destinations by default (4.7, 4.8).
8. Adding destinations: merge PR #69 and, after adding or confirming a destination, offer to share it with existing agents (3.1, 3.2, #60).
9. MCP and destinations: normalize accounts (strip `@`, case per site) at the service and in ingestion, and return a plain `message` from `create_draft` saying where and when the draft will appear (3.3, section 11).
10. Draft list: one list grouped "For this page" and "Elsewhere", full text on expand, and the npub off the home screen (5.3, 5.4, 1.8).
