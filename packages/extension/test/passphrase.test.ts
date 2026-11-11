import { RECOVERY_WORDLIST } from '@qusme/nostr';
import { describe, expect, it } from 'vitest';
import {
  checkPassphrase,
  MIN_PASSPHRASE_BITS,
  PASSPHRASE_RULE,
  passphraseStrength,
  SUGGESTED_WORDS,
  suggestPassphrase,
} from '../src/passphrase.ts';

describe('passphrase strength (spec 11.3)', () => {
  it.each(['plum anchor violet seventeen', 'Tr0ub4dor&3-extended', 'kettle-mango-orbit-41'])(
    'accepts %s',
    (p) => {
      expect(checkPassphrase(p).ok).toBe(true);
    }
  );

  it.each([
    ['short', /12 characters/],
    ['aaaaaaaaaaaaaaaa', /repetitive/],
    ['abcdefghijklmnop', /repetitive/],
    ['MyPassword2026!!', /common/],
    ['correct horse battery staple', /common/],
    ['abababababab', /repetitive|guess/],
    ['121212343434', /repetitive|guess/],
  ])('refuses %s', (p, problem) => {
    const check = checkPassphrase(p);
    expect(check.ok).toBe(false);
    expect(check.problem).toMatch(problem);
  });
});

describe('passphrase rule, strength and suggestions (#73)', () => {
  it('states the rule in plain words', () => {
    expect(PASSPHRASE_RULE).toBe(
      'Use four or more random words, or 16 or more characters mixing letters, digits and symbols.'
    );
  });

  it('always accepts a suggested passphrase: five words from the BIP-39 list', () => {
    const words = new Set(RECOVERY_WORDLIST);
    for (let i = 0; i < 500; i += 1) {
      const phrase = suggestPassphrase();
      expect(phrase.split(' ')).toHaveLength(SUGGESTED_WORDS);
      expect(phrase.split(' ').every((w) => words.has(w))).toBe(true);
      expect(checkPassphrase(phrase)).toMatchObject({ ok: true });
    }
  });

  it('draws again when a draw holds a common password', () => {
    const monkey = RECOVERY_WORDLIST.indexOf('monkey');
    const draws = [
      [monkey, 1, 2, 3, 4],
      [10, 200, 300, 400, 500],
    ];
    let calls = 0;
    const phrase = suggestPassphrase((array) => {
      array.set(draws[calls++] as number[]);
      return array;
    });
    expect(calls).toBe(2);
    expect(phrase).not.toContain('monkey');
    expect(checkPassphrase(phrase).ok).toBe(true);
  });

  it('accepts any 16 random characters mixing letters, digits and symbols', () => {
    const classes = [
      'abcdefghijklmnopqrstuvwxyz',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      '0123456789',
      '!@#$%^&*-_=+?',
    ];
    // mulberry32 with a fixed seed: the same 300 strings on every run.
    let seed = 0x5eed_0016;
    const next = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
    const pick = (set: string): string => set[next() % set.length] as string;
    const all = classes.join('');
    let accepted = 0;
    for (let i = 0; i < 300; i += 1) {
      const chars = classes.map(pick);
      while (chars.length < 16) chars.push(pick(all));
      const check = checkPassphrase(chars.join(''));
      // Strength is never the reason: the estimate always clears the minimum.
      expect(check.bits).toBeGreaterThanOrEqual(MIN_PASSPHRASE_BITS);
      // A random string may still hold a run, a repeat or a common word, which the rule refuses
      // on purpose; anything else must pass.
      if (check.ok) accepted += 1;
      else expect(check.problem).toMatch(/^(Too repetitive|Contains a very common password)/);
    }
    expect(accepted).toBeGreaterThan(290);
  });

  it('refuses 12 lowercase letters and says how many it needs', () => {
    const check = checkPassphrase('kqzvjwmxrpbt');
    expect(check.ok).toBe(false);
    expect(check.problem).toBe(
      'Too easy to guess. With only lowercase letters it needs 13 or more characters: add another word, or mix in capitals, digits or symbols.'
    );
    // And it is right: 13 lowercase letters pass.
    expect(checkPassphrase('kqzvjwmxrpbta').ok).toBe(true);
  });

  it.each([
    ['', 0, PASSPHRASE_RULE],
    ['short', 1, /^Weak\. Too short/],
    ['kqzvjwmxrpbt', 2, /^Almost\. Too easy to guess/],
    ['cat dog sun hat', 3, 'Strong enough.'],
    ['plum anchor violet seventeen', 4, 'Strong.'],
  ] as const)('feedback for %j is level %i', (p, level, label) => {
    const strength = passphraseStrength(p);
    expect(strength.level).toBe(level);
    if (typeof label === 'string') expect(strength.label).toBe(label);
    else expect(strength.label).toMatch(label);
  });
});
