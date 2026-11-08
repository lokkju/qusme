# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.64.1", "websockets==17.4", "pillow==13.0.0"]
# ///
"""The Chrome Web Store and Firefox AMO listing images, from the built extension.

Loads packages/extension/.output/chrome-mv3 in Chromium, seeds a demo queue (a local relay
serving a settings and a destinations event that seed.ts signs with a fixed demo key, plus the
draft cache in storage.session), screenshots the real popup and the real Alt+Q picker, and
composes each onto a 1280x800 canvas with a caption. Also draws the promo tile and the marquee.

Run from the repo root, after `wxt build` in packages/extension:

    mise exec -- uv run scripts/store-screenshots/capture.py

Writes store/screenshots/*.png, store/promo-440x280.png and store/marquee-1400x560.png.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import BrowserContext, Page, sync_playwright
from websockets.asyncio.server import serve

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EXTENSION = ROOT / "packages/extension/.output/chrome-mv3"
STORE = ROOT / "store"
SERVICE_ORIGIN = "https://app.qus.me"
# The tab the popup believes it opened over; matches the bundled X definition's `match`.
TAB_URL = "https://x.com/compose/post"
FRAME_URL = "x.com/compose/post"
# The browser frame's page area, in CSS pixels.
PAGE_W, PAGE_H = 820, 616
SCALE = 2


# --- A minimal NIP-01 relay, so the popup's relay reads (agent approval) get real events. ---


def matches(event: dict, f: dict) -> bool:
    if "ids" in f and event["id"] not in f["ids"]:
        return False
    if "authors" in f and event["pubkey"] not in f["authors"]:
        return False
    if "kinds" in f and event["kind"] not in f["kinds"]:
        return False
    if "since" in f and event["created_at"] < f["since"]:
        return False
    if "until" in f and event["created_at"] > f["until"]:
        return False
    for key, values in f.items():
        if key.startswith("#"):
            name = key[1:]
            if not any(t[0] == name and len(t) > 1 and t[1] in values for t in event["tags"]):
                return False
    return True


def d_tag(event: dict) -> str | None:
    return next((t[1] for t in event["tags"] if t[0] == "d"), None)


class Relay:
    def __init__(self) -> None:
        self.events: list[dict] = []
        self.port = 0
        ready = threading.Event()
        threading.Thread(target=self._run, args=(ready,), daemon=True).start()
        ready.wait(10)

    def add(self, event: dict) -> None:
        kind = event["kind"]
        if 30000 <= kind < 40000 or 10000 <= kind < 20000:
            self.events = [
                e
                for e in self.events
                if not (
                    e["kind"] == kind
                    and e["pubkey"] == event["pubkey"]
                    and d_tag(e) == d_tag(event)
                )
            ]
        self.events.append(event)

    async def _handler(self, ws) -> None:
        async for raw in ws:
            msg = json.loads(raw)
            if msg[0] == "EVENT":
                self.add(msg[1])
                await ws.send(json.dumps(["OK", msg[1]["id"], True, ""]))
            elif msg[0] == "REQ":
                sub, filters = msg[1], msg[2:]
                found = sorted(
                    (e for e in self.events if any(matches(e, f) for f in filters)),
                    key=lambda e: -e["created_at"],
                )
                limit = min((f.get("limit", len(found)) for f in filters), default=len(found))
                for event in found[:limit]:
                    await ws.send(json.dumps(["EVENT", sub, event]))
                await ws.send(json.dumps(["EOSE", sub]))
            elif msg[0] == "CLOSE":
                await ws.send(json.dumps(["CLOSED", msg[1], ""]))

    def _run(self, ready: threading.Event) -> None:
        async def serve_forever() -> None:
            async with serve(self._handler, "127.0.0.1", 0) as server:
                self.port = server.sockets[0].getsockname()[1]
                ready.set()
                await asyncio.Future()

        asyncio.run(serve_forever())


# --- Demo content: plausible, generic, no real people. ---


def demo_drafts(now: int) -> list[dict]:
    claude = {"wrapId": "0" * 63 + "1", "submitter": "a" * 64, "label": "Claude"}
    return [
        {
            "d": "draft-release",
            "updatedAt": now - 300,
            "site": "x",
            "account": "lanternworks",
            "field": "text",
            "status": "active",
            "destination": "dest-x",
            "content": "v2.4 is out: offline mode, faster sync, and a dark theme that follows your "
            "system setting. The full changelog is on the blog.",
            "source": claude,
        },
        {
            "d": "draft-proud",
            "updatedAt": now - 3600,
            "site": "x",
            "account": "lanternworks",
            "field": "text",
            "status": "active",
            "destination": "dest-x",
            "content": "Small thing we're proud of this week: the app now opens in under a second "
            "on a five-year-old phone.",
        },
        {
            "d": "draft-hiring",
            "updatedAt": now - 1800,
            "site": "linkedin.com",
            "account": "Lantern Works",
            "field": "text",
            "status": "active",
            "destination": "dest-linkedin",
            "content": "We're hiring a part-time support engineer: remote, 20 hours a week. If you "
            "like untangling sync bugs and writing clear replies, we'd like to hear from you.",
            "source": claude,
        },
        {
            "d": "draft-maintenance",
            "updatedAt": now - 7200,
            "site": "mastodon.social",
            "account": "lanternworks",
            "field": "text",
            "status": "active",
            "destination": "dest-mastodon",
            "content": "Maintenance window: Saturday 09:00 to 10:00 UTC. Sync pauses for about ten "
            "minutes; nothing you've written is lost.",
        },
    ]


def picker_view(drafts: list[dict]) -> dict:
    """What PickerService.view builds for TAB_URL with this cache (src/insertion/picker.ts)."""
    names = {"x": "X"}

    def item(draft: dict, show_account: bool) -> dict:
        site = names.get(draft["site"], draft["site"])
        parts = [f"{site} as {draft['account']}" if show_account else site, draft["field"]]
        if "source" in draft:
            parts.append(f"from {draft['source']['label']}")
        text = " ".join(draft["content"].split())
        return {"d": draft["d"], "text": text, "meta": " · ".join(parts)}

    active = sorted(drafts, key=lambda d: -d["updatedAt"])
    return {
        "token": "store-screenshots",
        "state": "ready",
        "here": [item(d, False) for d in active if d["site"] == "x"],
        "others": [item(d, True) for d in active if d["site"] != "x"],
        "context": "X as lanternworks",
    }


# Stubs for extension pages only: the active tab, the read-only account detection, the sync
# request (the cache is seeded instead), the service permission prompt and the service's answer
# to an approval code. Everything else is the real extension.
INIT_SCRIPT = """
(() => {
  if (location.protocol !== 'chrome-extension:') return;
  const cfg = %s;
  const def = (obj, name, fn) =>
    obj && Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true });
  def(chrome.tabs, 'query', async () =>
    [{ id: 4242, index: 0, windowId: 1, active: true, url: cfg.tabUrl, title: 'Compose post' }]);
  def(chrome.scripting, 'executeScript', async (injection) =>
    injection.files ? [{ frameId: 0, result: null }] : [{ frameId: 0, result: cfg.detected }]);
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  def(chrome.runtime, 'sendMessage', (message, ...rest) =>
    message && message.type === 'qusme.sync' ? Promise.resolve({ state: 'ok' }) : send(message, ...rest));
  def(chrome.permissions, 'request', async () => true);
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(cfg.serviceOrigin + '/device/authorizations/'))
      return new Response(JSON.stringify(cfg.authorization),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    return realFetch(input, init);
  };
})();
"""


def seed_queue(relay_url: str) -> dict:
    out = subprocess.run(
        ["node", str(HERE / "seed.ts"), relay_url], check=True, capture_output=True, text=True
    )
    return json.loads(out.stdout)


def seed_storage(ctx: BrowserContext, local: dict, session: dict) -> None:
    worker = ctx.service_workers[0]
    # The alarm first: unlocking starts a background sync only when there is no alarm yet, and
    # a sync would replace the seeded draft cache with what the relay holds (no draft wraps).
    worker.evaluate(
        """async ({ local, session }) => {
          await chrome.alarms.create('qusme.sync', { periodInMinutes: 60 });
          await chrome.storage.local.set(local);
          await chrome.storage.session.set(session);
        }""",
        {"local": local, "session": session},
    )


def popup(ctx: BrowserContext, ext_id: str, query: str = "", width: int = 400) -> Page:
    page = ctx.new_page()
    page.set_viewport_size({"width": width, "height": 600})
    page.goto(f"chrome-extension://{ext_id}/popup.html{query}")
    return page


def shoot_popup(page: Page, path: Path) -> Path:
    page.wait_for_timeout(400)
    page.locator("#app > div").screenshot(path=str(path))
    return path


def data_uri(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def font_face() -> str:
    fonts = HERE / "fonts"
    inter = (fonts / "inter-latin-wght-normal.woff2").as_uri()
    newsreader = (fonts / "newsreader-latin-wght-normal.woff2").as_uri()
    return f"""
@font-face {{ font-family: "Inter"; font-weight: 100 900; src: url("{inter}") format("woff2"); }}
@font-face {{ font-family: "Newsreader"; font-weight: 200 800; src: url("{newsreader}") format("woff2"); }}
"""


# The site's palette and type (site/style.css on feat/landing).
BASE_CSS = """
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font-family: "Inter", system-ui, sans-serif; color: #1c1c1a; background: #fbfbf9; overflow: hidden; }
.mark { display: inline-flex; align-items: center; justify-content: center; background: #1f5f4a; color: #fff;
        font-family: "Newsreader", Georgia, serif; font-weight: 500; flex: none; }
"""


def q_mark(size: int) -> str:
    """site/favicon.svg: a #1f5f4a rounded square (rx 7 of 32) with a white serif q."""
    radius = round(size * 7 / 32)
    font = round(size * 0.78)
    pad = round(size * 0.12)
    return (
        f'<span class="mark" style="width:{size}px;height:{size}px;border-radius:{radius}px;'
        f'font-size:{font}px;line-height:1;padding-bottom:{pad}px">q</span>'
    )


def frame(page_img: Path, overlay: str, badge: str) -> str:
    """A plain browser window (no real browser's look) with the extension's toolbar button."""
    icon = data_uri(EXTENSION / "icon/32.png")
    count = f"<b>{badge}</b>" if badge else ""
    return f"""
<div class="win">
  <div class="chrome">
    <span class="dots"><i></i><i></i><i></i></span>
    <span class="url">{FRAME_URL}</span>
    <span class="ext"><img src="{icon}" alt="">{count}</span>
  </div>
  <div class="page"><img src="{data_uri(page_img)}" alt="">{overlay}</div>
</div>"""


FRAME_CSS = f"""
.win {{ position: absolute; right: 48px; top: 64px; width: {PAGE_W}px; border-radius: 14px; overflow: hidden;
        background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 24px 60px -12px rgba(28,28,26,.28);
        border: 1px solid #e2e1db; }}
.chrome {{ height: 56px; background: #f2f1ec; border-bottom: 1px solid #e2e1db; display: flex; align-items: center;
           gap: 16px; padding: 0 16px; }}
.dots i {{ display: inline-block; width: 11px; height: 11px; border-radius: 50%; background: #c9c8c1; margin-right: 7px; }}
.url {{ flex: 1; height: 32px; border-radius: 16px; background: #fff; border: 1px solid #e2e1db; display: flex;
        align-items: center; padding: 0 14px; font-size: 14px; color: #3d3d39; }}
.ext {{ position: relative; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center;
        justify-content: center; background: #e2e1db; }}
.ext img {{ width: 20px; height: 20px; }}
.ext b {{ position: absolute; right: -5px; bottom: -3px; min-width: 16px; height: 16px; border-radius: 8px;
          background: #1F6FEB; color: #fff; font-size: 10px; font-weight: 700; display: flex; align-items: center;
          justify-content: center; padding: 0 4px; }}
.page {{ position: relative; width: {PAGE_W}px; height: {PAGE_H}px; overflow: hidden; }}
.page > img {{ width: {PAGE_W}px; height: {PAGE_H}px; display: block; }}
.page .shade {{ position: absolute; inset: 0; background: rgba(28,28,26,.18); }}
.popup {{ position: absolute; right: 8px; top: 0; border-radius: 0 0 10px 10px; overflow: hidden; background: #fff;
          box-shadow: 0 12px 32px -6px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.08); }}
.popup img, .card img {{ display: block; }}
.card {{ position: absolute; border-radius: 10px; overflow: hidden; background: #fff;
         box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 24px 60px -12px rgba(28,28,26,.28); border: 1px solid #e2e1db; }}
.further {{ position: absolute; font-size: 14px; color: #55554f; }}
.caption {{ position: absolute; left: 56px; top: 0; bottom: 0; width: 300px; display: flex; flex-direction: column;
            justify-content: center; }}
.caption .brand {{ display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 17px; margin-bottom: 36px; }}
.caption h1 {{ font-family: "Newsreader", Georgia, serif; font-weight: 500; font-size: 40px; line-height: 1.12;
               letter-spacing: -0.01em; margin: 0 0 18px; }}
.caption p {{ font-size: 17px; line-height: 1.5; color: #3d3d39; margin: 0; }}
.caption kbd {{ font-family: inherit; font-size: .9em; border: 1px solid #c9c8c1; border-bottom-width: 2px;
                border-radius: 6px; padding: 1px 6px; background: #fff; }}
"""


def image_css_size(img: Path) -> tuple[int, int]:
    with Image.open(img) as im:
        return im.size[0] // SCALE, im.size[1] // SCALE


def popup_overlay(img: Path, max_h: int = 600) -> str:
    """The popup under the toolbar button; Chrome caps a popup at 600 px tall and scrolls the rest."""
    w, h = image_css_size(img)
    return (
        f'<div class="shade"></div><div class="popup" style="width:{w}px;height:{min(h, max_h)}px">'
        f'<img src="{data_uri(img)}" style="width:{w}px;height:{h}px" alt=""></div>'
    )


def split_cards(img: Path, cut: int) -> str:
    """A popup screen too tall for one view, as two cards: its top, and the rest further down."""
    w, h = image_css_size(img)
    uri = data_uri(img)
    rest = h - cut
    with Image.open(img) as im:
        paper = "#%02x%02x%02x" % im.convert("RGB").getpixel((4, 4))
    left = 1280 - 48 - 2 * w - 20
    top = (800 - cut) // 2
    second = top + 120
    return f"""
<div class="card" style="left:{left}px;top:{top}px;width:{w}px;height:{cut}px">
  <img src="{uri}" style="width:{w}px;height:{h}px" alt=""></div>
<div class="further" style="left:{left + w + 20}px;top:{second - 28}px">Further down</div>
<div class="card" style="left:{left + w + 20}px;top:{second}px;width:{w}px;padding-top:10px;background:{paper}">
  <div style="height:{rest}px;overflow:hidden">
    <img src="{uri}" style="width:{w}px;height:{h}px;margin-top:-{cut}px" alt=""></div></div>"""


def screenshot_html(title: str, body: str, right: str) -> str:
    return f"""<!doctype html><html><head><meta charset="utf-8">
<style>{font_face()}{BASE_CSS}{FRAME_CSS}</style></head>
<body style="width:1280px;height:800px;position:relative">
  <div class="caption">
    <div class="brand">{q_mark(30)}<span>qus.me</span></div>
    <h1>{title}</h1>
    <p>{body}</p>
  </div>
  {right}
</body></html>"""


def promo_html(width: int, height: int) -> str:
    big = height >= 500
    mark = q_mark(132 if big else 64)
    name = 104 if big else 50
    tag = 34 if big else 19
    gap = 36 if big else 18
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{font_face()}{BASE_CSS}
body {{ width:{width}px; height:{height}px; background: #f2f1ec; display:flex; flex-direction:column;
        align-items:center; justify-content:center; gap:{gap}px; }}
.row {{ display:flex; align-items:center; gap:{gap}px; }}
.name {{ font-family: "Newsreader", Georgia, serif; font-weight: 500; font-size:{name}px; line-height:1;
         letter-spacing:-0.01em; padding-bottom:{gap // 4}px; }}
.tag {{ font-size:{tag}px; line-height:1.3; color: #1f5f4a; font-weight: 500; }}
</style></head><body><div class="row">{mark}<div class="name">qus.me</div></div>
<div class="tag">Drafts wait in line. You post them.</div></body></html>"""


def render(page: Page, html: str, size: tuple[int, int], out: Path, tmp: Path) -> None:
    src = tmp / (out.stem + ".html")
    src.write_text(html)
    page.set_viewport_size({"width": size[0], "height": size[1]})
    page.goto(src.as_uri())
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(200)
    raw = tmp / (out.stem + "-raw.png")
    page.screenshot(path=str(raw))
    # Rendered at 2x for sharp text, then down to exactly the store's size, with no alpha.
    with Image.open(raw) as im:
        im.convert("RGB").resize(size, Image.LANCZOS).save(out, optimize=True)


def main() -> None:
    if not (EXTENSION / "manifest.json").exists():
        sys.exit(f"{EXTENSION} is missing: run `pnpm -C packages/extension exec wxt build` first")
    tmp = Path(os.environ.get("STORE_TMP") or tempfile.mkdtemp(prefix="qusme-store-"))
    tmp.mkdir(parents=True, exist_ok=True)
    shots = STORE / "screenshots"
    shots.mkdir(parents=True, exist_ok=True)

    relay = Relay()
    relay_url = f"ws://127.0.0.1:{relay.port}"
    queue = seed_queue(relay_url)
    relay.add(queue["settings"])
    relay.add(queue["destinations"])
    now = int(time.time())
    drafts = demo_drafts(now)

    cfg = {
        "tabUrl": TAB_URL,
        "detected": ["lanternworks"],
        "serviceOrigin": SERVICE_ORIGIN,
        "authorization": {
            "agent_pubkey": "7e" * 32,
            "client_id": "https://claude.ai/oauth/mcp-client",
            "client_name": "Claude",
            "redirect_host": "claude.ai",
            "scopes": ["drafts:submit"],
            "expires_at": now + 600,
        },
    }
    local = {
        "qusme.queue": {
            "version": 1,
            "pubkey": queue["pubkey"],
            "ncryptsec": "ncryptsec1storescreenshots",
            "storageRelays": [relay_url],
            "settings": queue["settings"],
        },
        "qusme.firstRun": {"queuePubkey": queue["pubkey"], "dismissed": True},
        "qusme.sync": {
            "version": 1,
            "handled": {},
            "cappedStreak": 0,
            "lastInboxSync": now - 90,
            "last": {
                "at": now - 90,
                "ingested": 2,
                "skipped": 0,
                "deferred": 0,
                "discarded": {},
                "deletionsRequested": 0,
                "cappedStreak": 0,
                "errors": [],
            },
        },
    }
    session = {
        "qusme.unlocked": {"queue": queue["queueKey"], "inbox": queue["inboxKey"]},
        "qusme.drafts": {
            "queuePubkey": queue["pubkey"],
            "syncedAt": now - 90,
            "drafts": drafts,
            "destinations": queue["destinationList"],
        },
    }

    profile = tmp / "profile"
    shutil.rmtree(profile, ignore_errors=True)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile),
            channel="chromium",
            headless=True,
            device_scale_factor=SCALE,
            args=[f"--disable-extensions-except={EXTENSION}", f"--load-extension={EXTENSION}"],
        )
        ctx.add_init_script(INIT_SCRIPT % json.dumps(cfg))
        worker = (
            ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        )
        ext_id = worker.url.split("/")[2]

        # The page behind the popup, and the same page with the real picker open.
        compose = ctx.new_page()
        compose.set_viewport_size({"width": PAGE_W, "height": PAGE_H})
        compose.goto((HERE / "compose.html").as_uri())
        compose.evaluate("document.fonts.ready")
        page_img = tmp / "compose.png"
        compose.screenshot(path=str(page_img))
        compose.focus("#compose")
        # The shortcut can't be pressed from automation and activeTab can't be granted, so the
        # bundled page script goes in directly and opens the picker with the view the background
        # would build for this cache.
        compose.add_script_tag(path=str(EXTENSION / "qusme-page.js"))
        compose.evaluate("view => globalThis.__qusmeInsertion.openPicker(view)", picker_view(drafts))
        compose.wait_for_timeout(300)
        picker_img = tmp / "picker.png"
        compose.screenshot(path=str(picker_img))

        # First run, before any queue exists.
        welcome = shoot_popup(popup(ctx, ext_id), tmp / "welcome.png")

        seed_storage(ctx, local, session)
        home_page = popup(ctx, ext_id)
        home_page.get_by_text("Press Alt+Q").wait_for()
        home_page.locator("[data-draft]").first.wait_for()
        home = shoot_popup(home_page, tmp / "home.png")

        approve_page = popup(ctx, ext_id, "?approve=QK7D-M4XR")
        approve_page.get_by_role("button", name="Look up").click()
        approve_page.get_by_role("button", name="Approve").first.wait_for(timeout=15000)
        approve = shoot_popup(approve_page, tmp / "approve.png")
        # The second card starts between the destination list and the new-destinations box.
        box = approve_page.locator("#app > div").bounding_box()
        listed = approve_page.locator("fieldset ul").first.bounding_box()
        toggle = (
            approve_page.get_by_text("Let it propose new destinations")
            .locator("xpath=ancestor::*[contains(@class, 'border')][1]")
            .bounding_box()
        )
        approve_cut = int((listed["y"] + listed["height"] + toggle["y"]) / 2 - box["y"])

        canvas = ctx.new_page()
        badge = str(len(drafts))
        screens = [
            (
                "01-popup.png",
                "Your drafts, sorted by where they go.",
                "Drafts for the page you're on come first. Insert puts one in the post box in a "
                "single click.",
                frame(page_img, popup_overlay(home), badge),
            ),
            (
                "02-picker.png",
                "Press <kbd>Alt+Q</kbd> in any post box.",
                "Pick a draft, read it over, change it if you like, and click Post yourself. "
                "qus.me never posts anything.",
                frame(picker_img, "", badge),
            ),
            (
                "03-approve-agent.png",
                "You decide what an agent may draft.",
                "Approve Claude or another MCP client with a short code, then choose its "
                "destinations and how many drafts it may add.",
                split_cards(approve, approve_cut),
            ),
            (
                "04-setup.png",
                "A queue only your devices can read.",
                "Drafts are encrypted before they leave your browser. Create a queue, pair another "
                "device, or recover with your recovery code.",
                frame(page_img, popup_overlay(welcome), ""),
            ),
        ]
        for name, title, body, right in screens:
            html = screenshot_html(title, body, right)
            render(canvas, html, (1280, 800), shots / name, tmp)
        render(canvas, promo_html(440, 280), (440, 280), STORE / "promo-440x280.png", tmp)
        render(canvas, promo_html(1400, 560), (1400, 560), STORE / "marquee-1400x560.png", tmp)
        ctx.close()

    for path in sorted(STORE.rglob("*.png")):
        with Image.open(path) as im:
            print(f"{path.relative_to(ROOT)}  {im.size[0]}x{im.size[1]}  {im.mode}")


if __name__ == "__main__":
    main()
