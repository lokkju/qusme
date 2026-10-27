import { expect, it } from 'vitest';
import { KIND_DRAFT_WRAP } from '../src/index.ts';

it('uses the NIP-37 draft wrap kind', () => {
  expect(KIND_DRAFT_WRAP).toBe(31234);
});
