/**
 * The look the in-page picker and notice share: the qus.me site's palette and type, as CSS custom
 * properties for a closed shadow root. The page can't load the extension's bundled fonts without
 * a web-accessible resource, which pages can probe to detect the extension, so Inter and
 * Newsreader are used only when the system has them and system fonts stand in otherwise.
 */

/** The site's light tokens, then its dark ones (site/style.css). */
export const LIGHT_TOKENS =
  '--bg: #fbfbf9; --surface: #ffffff; --band: #f2f1ec; --fg: #1c1c1a; --muted: #55554f; ' +
  '--line: #e2e1db; --edge: #c9c8c1; --accent: #1f5f4a; --accent-hover: #123a2d; ' +
  '--tint: #eaf2ee; --on-accent: #ffffff; --danger: #a8321f; --shadow: rgba(28, 28, 26, .22);';

export const DARK_TOKENS =
  '--bg: #131513; --surface: #1b1e1b; --band: #181b18; --fg: #ecebe6; --muted: #aeada5; ' +
  '--line: #2f332f; --edge: #4a4f4a; --accent: #8fd1b4; --accent-hover: #b5e3cd; ' +
  '--tint: #1f3a2f; --on-accent: #0d1a14; --danger: #f0a294; --shadow: rgba(0, 0, 0, .55);';

export const SANS =
  '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
export const SERIF = '"Newsreader", Georgia, "Times New Roman", serif';
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * Token rules for `selector`: the page's own scheme when it can be read (`.light` or `.dark` on
 * the element), else the browser's preference.
 */
export function schemeRules(selector: string): string {
  return `
${selector} { ${LIGHT_TOKENS} }
@media (prefers-color-scheme: dark) { ${selector}:not(.light) { ${DARK_TOKENS} } }
${selector}.dark { ${DARK_TOKENS} }
`;
}

const parseRgb = (value: string): [number, number, number, number] | undefined => {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/.exec(value);
  if (!m) return undefined;
  const alphaText = m[4];
  const alpha =
    alphaText === undefined
      ? 1
      : alphaText.endsWith('%')
        ? Number.parseFloat(alphaText) / 100
        : Number(alphaText);
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
};

/**
 * Whether the page looks dark or light: its body's or root's opaque background first, then its
 * declared `color-scheme`. Undefined when neither says, so the browser's preference decides.
 * Reads computed styles only; it changes nothing on the page.
 */
export function pageScheme(doc: Document): 'light' | 'dark' | undefined {
  const view = doc.defaultView;
  if (!view?.getComputedStyle) return undefined;
  try {
    for (const node of [doc.body, doc.documentElement]) {
      if (!node) continue;
      const rgb = parseRgb(view.getComputedStyle(node).backgroundColor ?? '');
      if (rgb && rgb[3] >= 0.5) {
        const [r, g, b] = rgb;
        const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        return luma < 0.45 ? 'dark' : 'light';
      }
    }
    const declared = view.getComputedStyle(doc.documentElement).colorScheme ?? '';
    const words = declared.split(/\s+/);
    if (words.includes('dark') && !words.includes('light')) return 'dark';
    if (words.includes('light') && !words.includes('dark')) return 'light';
  } catch {
    // A page that breaks getComputedStyle gets the browser's preference.
  }
  return undefined;
}
