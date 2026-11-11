// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { pageScheme } from '../src/insertion/page/scheme.ts';

afterEach(() => {
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
});

describe('page colour scheme', () => {
  it('reads a dark or light page from its opaque background', () => {
    document.body.style.backgroundColor = 'rgb(21, 24, 28)';
    expect(pageScheme(document)).toBe('dark');
    document.body.style.backgroundColor = 'rgb(255, 255, 255)';
    expect(pageScheme(document)).toBe('light');
  });

  it('falls back to the root background, then leaves it to the browser', () => {
    document.body.style.backgroundColor = 'rgba(0, 0, 0, 0)';
    document.documentElement.style.backgroundColor = 'rgb(10, 10, 10)';
    expect(pageScheme(document)).toBe('dark');
    document.documentElement.style.backgroundColor = 'transparent';
    expect(pageScheme(document)).toBeUndefined();
  });

  it('changes nothing on the page', () => {
    document.body.style.backgroundColor = 'rgb(21, 24, 28)';
    const before = document.documentElement.outerHTML;
    pageScheme(document);
    expect(document.documentElement.outerHTML).toBe(before);
  });
});
