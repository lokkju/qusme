/**
 * The passphrase strength check at setup (spec 11.3). The passphrase protects only the local
 * `ncryptsec` (6.1), which an attacker needs the device to reach, and every guess costs one scrypt
 * at `log_n` 18; the check keeps out the passphrases a guesser tries first. It estimates entropy
 * from length and character classes, refuses anything under {@link MIN_PASSPHRASE_LENGTH}
 * characters or {@link MIN_PASSPHRASE_BITS} bits, and refuses repeats, runs and a short list of
 * the most common choices.
 *
 * {@link PASSPHRASE_RULE} is the advice the UI shows; anything that follows it passes (tested).
 * The refusals name what is missing in the same terms, with the length this passphrase's mix of
 * characters would need, so the user never learns the threshold by trial.
 */
import { RECOVERY_WORDLIST } from '@qusme/nostr';

export const MIN_PASSPHRASE_LENGTH = 12;
export const MIN_PASSPHRASE_BITS = 60;

/** The rule as the setup screens state it. */
export const PASSPHRASE_RULE =
  'Use four or more random words, or 16 or more characters mixing letters, digits and symbols.';

/** How many words {@link suggestPassphrase} draws. */
export const SUGGESTED_WORDS = 5;

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

/** The bits per character the estimate gives this text, repeats discounted. */
function bitsPerChar(text: string): number {
  const unique = new Set(text.toLowerCase()).size;
  return Math.log2(poolSize(text)) * Math.min(1, unique / 8);
}

/** Words of lowercase letters only, as most passphrases made of words are. */
const onlyLowercase = (text: string): boolean => /^[a-z ]+$/.test(text);

export function checkPassphrase(passphrase: string): PassphraseCheck {
  const text = passphrase.normalize('NFKC');
  const length = [...text].length;
  const unique = new Set(text.toLowerCase()).size;
  const perChar = bitsPerChar(text);
  const bits = Math.round(length * perChar);
  const fail = (problem: string): PassphraseCheck => ({ ok: false, bits, problem });
  if (length < MIN_PASSPHRASE_LENGTH) {
    return fail(
      `Too short: use at least ${MIN_PASSPHRASE_LENGTH} characters. Four random words work well.`
    );
  }
  const lower = text.toLowerCase();
  if (isRun(lower) || unique < 4) {
    return fail('Too repetitive: avoid repeated characters and runs like abcd or 1234.');
  }
  if (COMMON.some((word) => lower.replace(/[^a-z0-9]/g, '').includes(word.replace(/ /g, '')))) {
    return fail('Contains a very common password; choose something else.');
  }
  if (bits < MIN_PASSPHRASE_BITS) {
    // The shortest length this mix of characters reaches the minimum at, by the same estimate.
    let needed = length + 1;
    while (Math.round(needed * perChar) < MIN_PASSPHRASE_BITS && needed < 200) needed += 1;
    const what = onlyLowercase(text)
      ? 'With only lowercase letters'
      : 'With this mix of characters';
    return fail(
      `Too easy to guess. ${what} it needs ${needed} or more characters: add another word, or mix in capitals, digits or symbols.`
    );
  }
  return { ok: true, bits };
}

export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export interface PassphraseStrength {
  /** 0 empty, 1 weak, 2 almost, 3 strong enough, 4 strong; the meter fills this many quarters. */
  level: StrengthLevel;
  /** What the meter says, in words, for the live region. */
  label: string;
  check: PassphraseCheck;
}

/** Bits at which the meter calls an accepted passphrase "strong" rather than "strong enough". */
export const STRONG_BITS = 90;

/** The live strength feedback for what the user has typed so far. */
export function passphraseStrength(passphrase: string): PassphraseStrength {
  const check = checkPassphrase(passphrase);
  if (passphrase === '') return { level: 0, label: PASSPHRASE_RULE, check };
  if (!check.ok) {
    const almost = check.bits >= MIN_PASSPHRASE_BITS * 0.75;
    return {
      level: almost ? 2 : 1,
      label: `${almost ? 'Almost.' : 'Weak.'} ${check.problem ?? ''}`.trim(),
      check,
    };
  }
  return check.bits >= STRONG_BITS
    ? { level: 4, label: 'Strong.', check }
    : { level: 3, label: 'Strong enough.', check };
}

/**
 * A passphrase of {@link SUGGESTED_WORDS} words drawn uniformly from the BIP-39 English list with
 * `crypto.getRandomValues` (2048 words, 11 bits each). A draw the strength check refuses (one
 * holding a word on the common list, like "monkey") is drawn again.
 */
export function suggestPassphrase(
  random: (array: Uint16Array<ArrayBuffer>) => Uint16Array = (a) => crypto.getRandomValues(a)
): string {
  for (;;) {
    const picks = random(new Uint16Array(SUGGESTED_WORDS));
    // 2048 is a power of two, so the low 11 bits of a uniform 16-bit value are uniform.
    const words = [...picks].map((n) => RECOVERY_WORDLIST[n & 0x7ff] as string);
    const phrase = words.join(' ');
    if (checkPassphrase(phrase).ok) return phrase;
  }
}
