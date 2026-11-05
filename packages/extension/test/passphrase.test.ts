import { describe, expect, it } from 'vitest';
import { checkPassphrase } from '../src/passphrase.ts';

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
