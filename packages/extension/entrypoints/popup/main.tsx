import { render } from 'preact';
import { browser } from 'wxt/browser';
import { browserInsertionUiDeps } from '../../src/insertion/browser.ts';
import { RegistryDefinitionSource } from '../../src/insertion/registry.ts';
import { App } from '../../src/ui/app.tsx';
import { browserDeps, openInTab } from '../../src/ui/browserDeps.ts';
import './style.css';

const root = document.getElementById('app');
// The bundled definitions and the background's last refresh, from storage.local, before the
// first render.
const definitions = new RegistryDefinitionSource({ local: browser.storage.local });
if (root) {
  // Every user- and network-supplied string is a JSX text child, which Preact sets as text,
  // never as HTML (spec 11.5, CLAUDE.md).
  // `popup.html?approve=ABCD-1234` opens the agent approval screen with the code filled in.
  const approveCode = new URLSearchParams(location.search).get('approve') ?? undefined;
  const app = (
    <App
      deps={browserDeps()}
      openInTab={openInTab}
      {...(approveCode !== undefined && { approveCode })}
      insertion={browserInsertionUiDeps(definitions)}
    />
  );
  void definitions
    .load()
    .catch(() => undefined)
    .then(() => render(app, root));
}
