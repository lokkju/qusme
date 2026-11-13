/**
 * One queue's life in the real extension, in order: create it on the harness's relays, add a
 * destination for the local compose page, approve an agent by its code and get its MCP draft,
 * insert that draft into the page, change the archive's retention in Settings, and recover the
 * queue on a fresh profile from the recovery code. Each test builds on the one before, so they run
 * serially in one profile.
 */
import { expect, type Page, test } from '@playwright/test';
import { INBOX_RELAYS, STORAGE_RELAYS } from '../harness/constants.ts';
import { type Agent, startAuthorization } from './agent.ts';
import { harness, launchProfile, type Profile } from './browser.ts';

test.describe.configure({ mode: 'serial' });

const PASSPHRASE = 'plum anchor violet seventeen harbor';
const SITE = 'e2epage';
const ACCOUNT = 'tester';
/**
 * How the popup names the destination: host · account, the host from the definition's match
 * pattern once it has one, the site id before.
 */
const ADDED = `${SITE} · ${ACCOUNT}`;
const DESTINATION = `127.0.0.1 · ${ACCOUNT}`;
const DRAFT = 'Hello from the e2e agent: this text came through the inbox relay.';

/**
 * The test-only site definition, entered the way a user would: as a custom destination's override
 * on the Accounts screen. It matches the harness's compose page and nothing else; no build of the
 * extension carries it.
 */
const DEFINITION = {
  id: SITE,
  version: '2026.11.1',
  name: 'E2E compose page',
  match: ['http://127.0.0.1/*'],
  fields: [
    {
      name: 'text',
      label: 'Post text',
      locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
      inject: ['insertText', 'native'],
    },
  ],
};

let profile: Profile;
let recoveryCode = '';
let agent: Agent | undefined;

test.beforeAll(async () => {
  profile = await launchProfile();
});

test.afterAll(async () => {
  await agent?.close();
  await profile?.close();
});

async function openMenuItem(popup: Page, name: string): Promise<void> {
  await popup.getByRole('button', { name: /^Menu/ }).click();
  await popup.getByRole('menuitem', { name }).click();
}

test('first run: create a queue on local relays and see the checklist', async () => {
  const popup = await profile.popup();
  await expect(popup.getByRole('heading', { name: 'Set up qus.me' })).toBeVisible();
  await popup.getByRole('button', { name: 'Create a new queue' }).click();

  await popup.getByLabel('Passphrase for this device').fill(PASSPHRASE);
  await popup.getByLabel('Type it again').fill(PASSPHRASE);
  await popup.getByRole('button', { name: 'Next' }).click();

  await expect(popup.getByRole('heading', { name: 'Storage servers' })).toBeVisible();
  // The screen checks the default servers as it opens; let that finish before typing ours.
  const check = popup.getByRole('status').filter({ hasText: /servers?/ });
  await expect(check).not.toContainText('Checking', { timeout: 30_000 });
  const storage = popup.getByLabel('Storage servers, one per line');
  if (!(await storage.isVisible())) await popup.getByText('Use other servers').click();
  await storage.fill(STORAGE_RELAYS.join('\n'));
  await popup.getByLabel('Inbox server').fill(INBOX_RELAYS.join('\n'));
  await popup.getByRole('button', { name: 'Check servers' }).click();
  await expect(check).toContainText('2 servers, checked', { timeout: 30_000 });
  await popup.getByRole('button', { name: 'Next' }).click();

  await expect(popup.getByRole('heading', { name: 'Save your recovery sheet' })).toBeVisible();
  const printed = popup
    .getByText('The same code, for printing:')
    .locator('xpath=following-sibling::p[1]');
  recoveryCode = (await printed.textContent())?.trim() ?? '';
  expect(recoveryCode).toMatch(/^[0-9A-Z-]{26,}$/);
  await popup.getByRole('button', { name: 'Next' }).click();

  await expect(popup.getByRole('heading', { name: 'Confirm and create' })).toBeVisible();
  await popup.getByRole('button', { name: 'Type the whole code instead' }).click();
  await popup.getByLabel('Type the recovery code').fill(recoveryCode);
  await popup.getByLabel(/I saved the recovery code/).check();
  await popup.getByRole('button', { name: 'Create queue' }).click();

  // The create flow's last screen and the checklist inside it share the heading; take the inner one.
  const checklist = popup.getByRole('region', { name: 'Your queue is ready' }).last();
  await expect(checklist).toBeVisible({ timeout: 60_000 });
  await expect(checklist.getByText('Queue stored on 2 servers')).toBeVisible();
  await expect(checklist.getByText('Connect an agent', { exact: true })).toBeVisible();
  await expect(checklist.getByText('Add the account you post from', { exact: true })).toBeVisible();
  await expect(checklist.getByLabel('Connector address')).toHaveValue('https://app.qus.me/mcp');
  await popup.close();
});

test('agent approval by code, and the MCP draft shows in the popup', async () => {
  const popup = await profile.popup();

  // A custom destination for the compose page, then its full definition as the override.
  await popup.getByRole('button', { name: 'Add by hand' }).click();
  const add = popup.getByRole('form', { name: 'Add an account' });
  await add.getByRole('combobox', { name: 'Site' }).selectOption({ label: 'Custom…' });
  await add.getByRole('textbox', { name: 'Site id' }).fill(SITE);
  await add.getByRole('textbox', { name: 'Account', exact: true }).fill(ACCOUNT);
  await add.getByRole('textbox', { name: 'Match patterns' }).fill(DEFINITION.match.join('\n'));
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(popup.getByRole('status')).toHaveText(`Added ${ADDED}.`);
  const item = popup.getByRole('listitem').filter({ hasText: ADDED });
  await item.getByRole('button', { name: 'Edit' }).click();
  await popup
    .getByRole('textbox', { name: 'Override (JSON)' })
    .fill(JSON.stringify(DEFINITION, null, 2));
  await popup.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(popup.getByRole('status')).toHaveText(`Saved ${DESTINATION}.`);

  // The agent starts OAuth; the user types its code into the popup and approves.
  const authorization = await startAuthorization();
  await popup.getByRole('button', { name: 'Back' }).click();
  await openMenuItem(popup, 'Agents');
  await popup.getByRole('button', { name: 'Approve an agent' }).click();
  await popup.getByLabel('Code or link').fill(authorization.code);
  await popup.getByRole('button', { name: 'Look up' }).click();
  await expect(popup.getByText('E2E Agent').first()).toBeVisible();
  await popup.getByRole('checkbox', { name: DESTINATION }).check();
  await popup.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(popup.getByRole('heading', { name: 'Agent approved' })).toBeVisible({
    timeout: 30_000,
  });

  // The agent drafts through MCP; the popup's sync brings the draft in from the inbox relay.
  agent = await authorization.connect();
  const listed = await agent.call('list_destinations');
  expect(listed.isError).toBeFalsy();
  expect(listed.structuredContent).toMatchObject({
    destinations: [{ site: SITE, account: ACCOUNT, fields: [{ name: 'text' }] }],
  });
  const created = await agent.call('create_draft', {
    site: SITE,
    account: ACCOUNT,
    field: 'text',
    value: DRAFT,
  });
  expect(created.isError, JSON.stringify(created.structuredContent)).toBeFalsy();
  await popup.close();

  await expect(async () => {
    const home = await profile.popup();
    try {
      await expect(home.getByText(DRAFT)).toBeVisible({ timeout: 5_000 });
    } finally {
      await home.close();
    }
  }).toPass({ timeout: 45_000 });
});

test('insert: the popup puts the draft into the local compose page', async () => {
  const compose = await profile.context.newPage();
  await compose.goto(`http://127.0.0.1:${harness().page}/compose`);
  const field = compose.getByRole('textbox', { name: 'Post text' });
  await expect(field).toHaveValue('');

  // The toolbar popup over the compose tab: the draft is listed for this page, and Insert puts it
  // in the field the definition's locator names.
  const popup = await profile.toolbarPopup(compose);
  try {
    await popup.waitFor(
      (text) => {
        const heading = [...document.querySelectorAll('h2')].find(
          (h) => h.textContent?.trim() === 'For this page'
        );
        const item = [...(heading?.closest('section')?.querySelectorAll('li') ?? [])].find((li) =>
          li.textContent?.includes(text)
        );
        const insert = [...(item?.querySelectorAll('button') ?? [])].find(
          (b) => b.textContent?.trim() === 'Insert' && !b.disabled
        );
        insert?.click();
        return insert !== undefined;
      },
      DRAFT,
      'the draft was never listed for this page with an Insert button'
    );
    await popup.waitFor(
      (status) => document.body.textContent?.includes(status) === true,
      'Inserted. Check it, then post.',
      'the popup never said the draft went in'
    );
    await expect(field).toHaveValue(DRAFT);
  } finally {
    await popup.close();
    await compose.close();
  }
});

test('settings: the archive retention change is saved to the queue', async () => {
  const popup = await profile.popup();
  await openMenuItem(popup, 'Settings');
  const retention = popup.getByRole('combobox', { name: 'Keep archived drafts' });
  await expect(retention).toBeEnabled();
  await expect(retention.locator('option:checked')).toHaveText('90 days (default)');
  const save = popup.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await retention.selectOption({ label: '180 days' });
  await save.click();
  await expect(popup.getByRole('status')).toHaveText(
    'Saved. Archived drafts are deleted 180 days after they were archived.',
    { timeout: 30_000 }
  );
  await popup.close();

  // A new popup reads the saved value back, and the archive says it.
  const again = await profile.popup();
  await openMenuItem(again, 'Settings');
  await expect(
    again.getByRole('combobox', { name: 'Keep archived drafts' }).locator('option:checked')
  ).toHaveText('180 days');
  await again.getByRole('button', { name: 'Back' }).click();
  await openMenuItem(again, 'Archive');
  await expect(
    again.getByText('Archived drafts are kept 180 days (change in Settings).', { exact: false })
  ).toBeVisible({ timeout: 30_000 });
  await again.close();
});

test('recovery from the recovery code alone, on a fresh profile', async () => {
  const fresh = await launchProfile();
  try {
    const popup = await fresh.popup();
    await popup.getByRole('button', { name: 'Recover with the recovery code' }).click();
    await popup.getByLabel('Your recovery sheet').fill(recoveryCode);
    await popup.getByRole('button', { name: 'Recover' }).click();

    // The default servers hold no backup for this queue, so recovery asks for its server.
    const server = popup.getByLabel('Another storage server (optional)');
    await expect(server).toBeVisible({ timeout: 30_000 });
    await server.fill(STORAGE_RELAYS[0] as string);
    await popup.getByRole('button', { name: 'Recover' }).click();

    await expect(popup.getByRole('heading', { name: 'Choose a passphrase' })).toBeVisible({
      timeout: 60_000,
    });
    await popup.getByLabel('Passphrase for this device').fill(PASSPHRASE);
    await popup.getByLabel('Type it again').fill(PASSPHRASE);
    await popup.getByRole('button', { name: 'Finish' }).click();
    await expect(popup.getByRole('heading', { name: 'Queue recovered' })).toBeVisible({
      timeout: 60_000,
    });
    await popup.getByRole('button', { name: 'Done' }).click();

    // The recovered queue is the same one: its destination and its agent came back with it.
    await openMenuItem(popup, 'Accounts');
    await expect(popup.getByRole('listitem').filter({ hasText: DESTINATION })).toBeVisible();
    await popup.getByRole('button', { name: 'Back' }).click();
    await openMenuItem(popup, 'Agents');
    await expect(popup.getByText('E2E Agent').first()).toBeVisible();
    // So did the retention the first profile chose (D30).
    await popup.getByRole('button', { name: 'Back' }).click();
    await openMenuItem(popup, 'Settings');
    await expect(
      popup.getByRole('combobox', { name: 'Keep archived drafts' }).locator('option:checked')
    ).toHaveText('180 days', { timeout: 30_000 });
  } finally {
    await fresh.close();
  }
});
