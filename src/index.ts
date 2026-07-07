/**
 * pubky-messenger-ts
 *
 * End-to-end encrypted private messaging over the Pubky network. A TypeScript
 * port of the Rust `pubky-messenger` crate, built on `@synonymdev/pubky`.
 */

export { PrivateMessengerClient } from './client.js';
export type { PubkyProfile, FollowedUser, Wordlist } from './client.js';

export { PrivateMessage } from './message.js';
export type { DecryptedMessage, PrivateMessageJson } from './message.js';

// Re-export pubky identity primitives for convenience (the Rust crate re-exports
// pkarr's Keypair / PublicKey).
export { Keypair, PublicKey } from '@synonymdev/pubky';
export type { Session } from '@synonymdev/pubky';

// The default BIP39 wordlist, for `PrivateMessengerClient.fromRecoveryPhrase`.
export { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
