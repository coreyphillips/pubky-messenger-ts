/**
 * pubky-messenger-ts
 *
 * End-to-end encrypted private messaging over the Pubky network. A TypeScript port of the Rust
 * `pubky-messenger` crate 0.5.0, built on `@synonymdev/pubky`.
 */

export { PrivateMessengerClient, DEFAULT_CLIENT_ID } from './client.js';
export type {
  PubkyProfile,
  FollowedUser,
  Wordlist,
  PeerKey,
  PrivateMessengerOptions,
  OperationOptions,
} from './client.js';

export { PrivateMessage } from './message.js';
export type { DecryptedMessage, PrivateMessageJson } from './message.js';

export { PreparedMessage } from './prepared.js';
export type { PreparedMessageJson } from './prepared.js';

export { ReceiveState, ChangePolicy } from './incremental.js';
export type {
  MessageId,
  PendingMessage,
  ReceivedMessage,
  ReceivedMessages,
  Discovery,
  ReceiveStateJson,
} from './incremental.js';

export type { MessageFetch } from './conversation.js';
export type { MessageDeletion } from './clear.js';

export {
  DEFAULT_FETCH_CONFIG,
  resolveFetchConfig,
  describeFetchFailure,
  FetchFailureError,
  messageUuid,
} from './engine.js';
export type { FetchConfig, FetchFailure, FailureReason } from './engine.js';

export type { RequestStats, RequestCounts } from './metrics.js';

export { StorageError, createPubkyStorage, storageErrorInfo, parseRetryAfter } from './storage.js';
export type {
  MessengerStorage,
  ConditionalGetResult,
  StorageErrorOptions,
  StorageErrorInfo,
} from './storage.js';

export { ConversationKey, generateSharedSecret, generateConversationPath } from './crypto.js';

// Re-export pubky identity primitives for convenience (the Rust crate re-exports pkarr's
// Keypair / PublicKey).
export { Keypair, PublicKey, Pubky } from '@synonymdev/pubky';
export type { Session } from '@synonymdev/pubky';

// The default BIP39 wordlist, for `PrivateMessengerClient.fromRecoveryPhrase`.
export { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
