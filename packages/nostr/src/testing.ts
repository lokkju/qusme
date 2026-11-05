/**
 * Test helpers for packages that use `@qusme/nostr`: an in-process relay network. Not part of the
 * main entry, so no build pulls it in by accident.
 */
export { FakeRelay, FakeRelayNetwork, type FakeRelayOptions } from './fakeRelay.ts';
