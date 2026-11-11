/**
 * The service's authorize page as an MCP client's sign-in tab shows it, for the store screenshot
 * of approving an agent (scripts/store-screenshots/capture.py). Prints the HTML on stdout.
 *
 * Run: node scripts/store-screenshots/authorize-page.ts
 */
import { authorizePage } from '../../packages/core/src/oauth/pages.ts';

const code = 'QK7D-M4XR';
process.stdout.write(
  authorizePage({
    userCode: code,
    qrUrl: `https://app.qus.me/approve?code=${code}`,
    clientName: 'Claude',
    clientHost: 'claude.ai',
    statusPath: '/authorize/demo/status',
    expiresAt: 0,
  }).html
);
