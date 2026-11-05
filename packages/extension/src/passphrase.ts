/**
 * The passphrase strength check at setup (spec 11.3). The passphrase protects only the local
 * `ncryptsec` (6.1), which an attacker needs the device to reach, and every guess costs one scrypt
 * at `log_n` 18; the check keeps out the passphrases a guesser tries first. It estimates entropy
 * from length and character classes, refuses anything under {@link MIN_PASSPHRASE_LENGTH}
 * characters or {@link MIN_PASSPHRASE_BITS} bits, and refuses repeats, runs and a short list of
 * the most common choices.
 */
export const MIN_PASSPHRASE_LENGTH = 12;
export const MIN_PASSPHRASE_BITS = 60;

const COMMON = [
  'password',
  'qwerty',
  'letmein',
  'iloveyou',
  'admin',
  'welcome',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'abc123',
  '123456',
  'qusme',
  'correct horse battery staple',
];

export interface PassphraseCheck {
  ok: boolean;
  /** A rough entropy estimate in bits. */
  bits: number;
  /** Why it was refused, for the UI. */
  problem?: string;
}

function poolSize(text: string): number {
  let pool = 0;
  if (/[a-z]/.test(text)) pool += 26;
  if (/[A-Z]/.test(text)) pool += 26;
  if (/[0-9]/.test(text)) pool += 10;
  if (/[ ]/.test(text)) pool += 1;
  if (/[^a-zA-Z0-9 ]/.test(text)) pool += 33;
  return Math.max(pool, 1);
}

function isRun(text: string): boolean {
  if (text.length < 3) return false;
  const codes = [...text].map((c) => c.codePointAt(0) as number);
  const step = (codes[1] as number) - (codes[0] as number);
  if (Math.abs(step) > 1) return false;
  return codes.every((c, i) => i === 0 || c - (codes[i - 1] as number) === step);
}

export function checkPassphrase(passphrase: string): PassphraseCheck {
  const text = passphrase.normalize('NFKC');
  const length = [...text].length;
  const unique = new Set(text.toLowerCase()).size;
  const bits = Math.round(length * Math.log2(poolSize(text)) * Math.min(1, unique / 8));
  const fail = (problem: string): PassphraseCheck => ({ ok: false, bits, problem });
  if (length < MIN_PASSPHRASE_LENGTH) {
    return fail(`Use at least ${MIN_PASSPHRASE_LENGTH} characters; a few unrelated words work.`);
  }
  const lower = text.toLowerCase();
  if (isRun(lower) || unique < 4) return fail('Too repetitive.');
  if (COMMON.some((word) => lower.replace(/[^a-z0-9]/g, '').includes(word.replace(/ /g, '')))) {
    return fail('Contains a very common password.');
  }
  if (bits < MIN_PASSPHRASE_BITS) return fail('Too easy to guess; make it longer.');
  return { ok: true, bits };
}
