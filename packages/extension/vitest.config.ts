import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    // The extension suites run scrypt, fake relays and happy-dom; under load a few sit near the
    // 5 s default (lokkju/qusme#64).
    testTimeout: 20_000,
  },
});
