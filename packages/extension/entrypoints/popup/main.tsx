import { render } from 'preact';
import { App } from '../../src/ui/app.tsx';
import { browserDeps, openInTab } from '../../src/ui/browserDeps.ts';
import './style.css';

const root = document.getElementById('app');
if (root) {
  // Every user- and network-supplied string is a JSX text child, which Preact sets as text,
  // never as HTML (spec 11.5, CLAUDE.md).
  // `popup.html?approve=ABCD-1234` opens the agent approval screen with the code filled in.
  const approveCode = new URLSearchParams(location.search).get('approve') ?? undefined;
  render(
    <App
      deps={browserDeps()}
      openInTab={openInTab}
      {...(approveCode !== undefined && { approveCode })}
    />,
    root
  );
}
