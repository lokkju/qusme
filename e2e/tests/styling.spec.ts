/**
 * The popup's stylesheet in the built extension: it loads, the theme's tokens resolve, and the
 * buttons get their shape and color. Unit tests render markup without CSS, so a build that drops
 * or mangles the Tailwind output (square, unstyled buttons) passes them; this doesn't.
 */
import { expect, test } from '@playwright/test';
import { launchProfile, type Profile } from './browser.ts';

let profile: Profile;

test.beforeAll(async () => {
  profile = await launchProfile();
});

test.afterAll(async () => {
  await profile?.close();
});

test('the popup stylesheet loads and its classes resolve', async () => {
  const popup = await profile.popup();

  const sheets = await popup.evaluate(() =>
    [...document.styleSheets].map((sheet) => ({
      href: sheet.href ?? '',
      rules: sheet.cssRules.length,
    }))
  );
  const popupSheet = sheets.find((s) => /\/assets\/popup-[\w-]+\.css$/.test(s.href));
  expect(popupSheet, JSON.stringify(sheets)).toBeDefined();
  expect(popupSheet?.rules).toBeGreaterThan(10);

  // The theme's tokens (entrypoints/popup/style.css, @theme), in light mode.
  const tokens = await popup.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      accent: root.getPropertyValue('--color-accent').trim(),
      radius: root.getPropertyValue('--radius-control').trim(),
    };
  });
  expect(tokens).toEqual({ accent: '#1f5f4a', radius: '6px' });
  await expect(popup.locator('body')).toHaveCSS('background-color', 'rgb(251, 251, 249)');
  await expect(popup.getByRole('heading', { name: 'Set up qus.me' })).toHaveCSS(
    'font-family',
    /^Newsreader/
  );

  // A primary and a plain button: rounded, padded, the accent fill on the primary one.
  const primary = popup.getByRole('button', { name: 'Create a new queue' });
  await expect(primary).toHaveCSS('border-top-left-radius', '6px');
  await expect(primary).toHaveCSS('background-color', 'rgb(31, 95, 74)');
  await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(primary).toHaveCSS('font-family', /^Inter/);
  const plain = popup.getByRole('button', { name: 'Recover with the recovery code' });
  await expect(plain).toHaveCSS('border-top-left-radius', '6px');
  await expect(plain).not.toHaveCSS('background-color', 'rgb(31, 95, 74)');
  const box = await primary.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(30);
  expect(
    await primary.evaluate((b) => Number.parseFloat(getComputedStyle(b).paddingLeft))
  ).toBeGreaterThan(0);

  // The bundled fonts load from the extension.
  expect(
    await popup.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('16px Inter') && document.fonts.check('16px Newsreader');
    })
  ).toBe(true);
  await popup.close();
});
