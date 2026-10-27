import { renderToString } from 'preact-render-to-string';
import { expect, it } from 'vitest';
import { App } from '../src/app.tsx';

it('renders the shell', () => {
  expect(renderToString(<App />)).toContain('qus.me');
});
