/**
 * The code an MCP client's authorize page shows (spec 8.2 step 2, `docs/oauth.md`): 8 Crockford
 * base32 characters shown as `XXXX-XXXX`, and in its QR as `https://app.qus.me/approve?code=`.
 */
import { CROCKFORD_ALPHABET } from '@qusme/nostr';

export const APPROVAL_CODE_LENGTH = 8;

/**
 * Reads what the user typed or pasted: the code in any case, with or without the hyphen or
 * spaces, Crockford's confusable letters read as digits (I and L as 1, O as 0), or the approve
 * link from the QR. A link must be the service's own `/approve` page; anything else is refused,
 * so a pasted link cannot point the extension somewhere else. Returns the code as `XXXX-XXXX`.
 */
export function parseApprovalCode(input: string, serviceOrigin: string): string | undefined {
  let text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    if (url.origin !== serviceOrigin || url.pathname !== '/approve') return undefined;
    text = url.searchParams.get('code') ?? '';
  }
  const code = text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (code.length !== APPROVAL_CODE_LENGTH) return undefined;
  for (const ch of code) if (!CROCKFORD_ALPHABET.includes(ch)) return undefined;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
