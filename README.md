# pubky-messenger-ts

End-to-end encrypted, one-to-one private messaging over the [Pubky](https://github.com/pubky) network.

This is a **TypeScript port** of the Rust [`pubky-messenger`](https://github.com/coreyphillips/pubky-messenger) crate 0.5.0, built on the official [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) client. It is **wire-compatible** with the Rust implementation: messages encrypted and signed by one can be read and verified by the other. A known-answer fixture written by the Rust crate (0.3.0) is decrypted, re-signed and re-encrypted byte for byte in the unit tests.

## Features

- End-to-end encrypted 1:1 messaging (X25519 ECDH + XSalsa20-Poly1305), with small-order key rejection
- Ed25519 message signatures with verification
- Identity from a `.pkarr` recovery file, a 12-word BIP39 recovery phrase or a `Keypair`
- Session grants (`signIn`, `signUp`, `ensureSession`), signing in on the first write when needed
- Durable sending: `prepareMessage` before any I/O, `publishMessage` with the same ID and bytes on every retry
- Incremental receive with a serializable `ReceiveState`, at-least-once delivery
- Bounded, concurrent storage requests: shared budget, per-attempt deadlines, retries for timeouts, network errors, 429 and 5xx
- Selected deletion and conversation clearing with per-message reports
- Pluggable storage (`MessengerStorage`), with a default adapter over `@synonymdev/pubky`
- Request counters (`requestStats`)
- Profile and follow helpers over the `pubky.app` schema
- ESM + CommonJS + type declarations; runs in Node 18+ and in browsers (via the pubky WASM). No Node-only APIs in the library.

## Installation

```sh
npm install pubky-messenger-ts @synonymdev/pubky@0.17.1
```

`@synonymdev/pubky` is a **peer dependency** (`>=0.17.1 <0.19`), so an application loads a single copy of its WASM module and can share one `Pubky` facade with this library.

Installing straight from git also works: the `prepare` script builds `dist/` during install.

```sh
npm install github:coreyphillips/pubky-messenger-ts
```

## Quick start

```ts
import { PrivateMessengerClient, PublicKey } from 'pubky-messenger-ts';
import { readFileSync } from 'node:fs';

// 1. Load an identity (recovery file, recovery phrase, or a raw Keypair).
const recoveryFile = new Uint8Array(readFileSync('alice.pkarr'));
const client = PrivateMessengerClient.fromRecoveryFile(recoveryFile, 'passphrase');

// 2. Optionally sign in up front. Sending signs in on its own when no session is kept.
await client.signIn();

// 3. Send an encrypted message. Peers are a PublicKey or z-base-32 text.
const recipient = PublicKey.from('ssffc7wiswjzdtt7nw93fa9wy9bus34puyy39giityofcibh9qny');
const messageId = await client.sendMessage(recipient, 'Hello, world!');

// 4. Read the conversation (oldest first, each signature verified).
for (const m of await client.getMessages(recipient)) {
  console.log(`${m.timestamp} ${m.sender}: ${m.content} (verified: ${m.verified})`);
}

// 5. Delete a message you sent.
await client.deleteMessage(messageId, recipient);
```

### Other ways to create a client

```ts
import { PrivateMessengerClient, Keypair, Pubky } from 'pubky-messenger-ts';

// From a 12-word BIP39 recovery phrase (optional passphrase + wordlist; defaults to English):
const a = PrivateMessengerClient.fromRecoveryPhrase(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);

// From an existing keypair, sharing the application's Pubky facade:
const pubky = new Pubky();
const b = new PrivateMessengerClient(Keypair.random(), { pubky, clientId: 'my-app.example' });
```

For a non-English mnemonic, pass a wordlist from `@scure/bip39`:

```ts
import { wordlist as spanish } from '@scure/bip39/wordlists/spanish.js';
const client = PrivateMessengerClient.fromRecoveryPhrase(mnemonic, '', spanish);
```

## Sessions and accounts

`signIn()` creates a session grant through `signer.signin(clientId)`; the client ID defaults to `pubky-messenger`, like the Rust crate. A homeserver without a grant endpoint (status 404 or 405) gets the deprecated cookie sign-in instead. The session is kept for writes. If no session is kept, the first write signs in by itself, and concurrent first writes share one sign-in.

A new identity has no account, so sign-in fails until it signs up. `ensureSession(homeserver, signupToken?)` signs in, and signs up on `homeserver` only when no homeserver record resolves for the identity. If a record exists, or the lookup itself fails, the sign-in error is thrown: signing up would point the identity away from the homeserver holding its data. `signUp` redacts the signup token from error messages.

## Durable sending

Prepare an encrypted message before making network requests, and persist it in your outbox:

```ts
const prepared = client.prepareMessage(recipient, 'request content');
await outbox.put(prepared.toJSON()); // plain JSON, also fine for IndexedDB
```

After a restart, restore it and publish the same value:

```ts
import { PreparedMessage } from 'pubky-messenger-ts';

const restored = PreparedMessage.fromJSON(await outbox.get(key));
const id = await client.publishMessage(restored);
```

Every attempt sends the same encrypted bytes to the same ID, so a lost response cannot create a second message. The prepared format is versioned (envelope version 1) and signs the owner, recipient, ID and encrypted payload together: Blake3 over the domain `pubky-messenger/prepared-message`, the version byte, then each field as a big-endian u64 length followed by its bytes, signed with Ed25519. Restored values are validated before any I/O, and the destination is derived locally, never loaded from the value. `prepared.id()`, `prepared.recipient()` and `prepared.timestamp()` (Unix seconds inside the encrypted message) let an application show the pending message before publication succeeds. The JSON form matches the Rust crate's serde output.

`sendMessage` is a prepare-and-publish convenience: calling it again creates a new message. Successful publication means stored, not read by the recipient. The library owns neither an outbox database nor a retry worker.

## Reading messages

`getMessages` returns a conversation oldest first and throws if any listing or message could not be retrieved. `fetchMessages` returns `{ messages, failures }` instead. Messages that cannot be parsed or decrypted are skipped.

Listings are read page by page (`limit` 1000, the cursor being the last entry) until the homeserver returns an empty page. A page that does not advance past the cursor fails as `listingStalled`, and a listing over 100000 entries fails as `listingTooLong`. Listed entries must be files directly inside the exact conversation directory, named with `[A-Za-z0-9-._~]+` and not `.` or `..`; anything else is reported as an `outsideConversation` failure and never requested.

```ts
import { describeFetchFailure } from 'pubky-messenger-ts';

client.withFetchConfig({
  maxConcurrentRequests: 8,
  maxConcurrentRequestsPerConversation: 4,
  requestTimeoutMs: 5000,
});

const fetch = await client.fetchMessages(recipient);
for (const failure of fetch.failures) console.warn(describeFetchFailure(failure));
```

## Receiving new messages

To poll a conversation, keep a `ReceiveState` and call `receiveNewMessages`. It lists both directories and downloads only messages the state has not acknowledged, so polling an unchanged conversation costs two listings and nothing else.

```ts
import { ReceiveState, messageUuid } from 'pubky-messenger-ts';

const state = saved ? ReceiveState.fromJSON(saved) : new ReceiveState();

const received = await client.receiveNewMessages(recipient, state);
for (const item of received.messages) {
  if (item.message) show(messageUuid(item.id), item.message);
  // Acknowledge after processing, including bodies that could not be decrypted
  state.acknowledge(item);
}
await save(state.toJSON());
```

- Delivery is at least once: a message comes back until it is acknowledged. `MessageId` (`publisher` and `url`) identifies a message across calls; `messageUuid(id)` gives its UUID.
- `discoverMessages` lists `PendingMessage`s without downloading; `retrieveMessages` downloads the ones you pass.
- The state keeps one entry per acknowledged message that is still listed; entries for deleted messages are dropped at the next complete listing. `state.acknowledgedIds()` lists them, and `received.complete` / `state.lastListingComplete` say whether both listings completed, so an application can detect messages the peer deleted.
- `ChangePolicy.WriteOnce` (default) never requests an acknowledged message again. `ChangePolicy.Revalidate` rechecks acknowledged messages with `If-None-Match`, delivering changed ones with `updated` set. It needs a storage adapter with `getConditional`; in browsers the staging homeserver does not expose the `ETag` header to cross-origin scripts, so no tags are recorded there and nothing is rechecked.
- The JSON form of `ReceiveState` is the Rust crate's serde shape: `{"change_policy":"WriteOnce","acknowledged":{"<publisher>":{"<url>":null}}}`.

## Managing messages

```ts
await client.deleteMessage(id, recipient);
await client.deleteMessages([id1, id2], recipient);
await client.clearMessages(recipient); // every message you sent in this conversation

const report = await client.deleteMessagesWithReport([id1, id2], recipient);
for (const failure of report.failures) console.warn('cleanup pending', failure);
// report.deleted holds full URLs removed or already absent; retrying is safe.
```

Deletions only touch your own storage; the recipient's copies remain. IDs are validated before any request (nonempty, `[A-Za-z0-9-._~]`, not `.` or `..`), duplicates are deleted once, and a 404 counts as success. `clearMessagesWithReport` lists the whole directory before deleting anything, deletes nothing if the listing fails, and reports entries outside the directory without requesting them.

## Request limits, retries and metrics

`FetchConfig` (defaults in `DEFAULT_FETCH_CONFIG`) governs reads, publication and deletion:

| Field                                  | Default | Meaning                                                |
| -------------------------------------- | ------- | ------------------------------------------------------ |
| `maxConcurrentRequests`                | 16      | attempts in flight across the client                   |
| `maxConcurrentRequestsPerConversation` | 8       | attempts in flight for one call                        |
| `requestTimeoutMs`                     | 10000   | deadline for one attempt                               |
| `maxAttempts`                          | 3       | attempts per request, including the first              |
| `retryBaseDelayMs`                     | 500     | first backoff, doubled for each retry                  |
| `maxRetryDelayMs`                      | 10000   | longest backoff; a longer `Retry-After` is not retried |
| `listPageSize`                         | 1000    | entries per listing page                               |
| `maxListingEntries`                    | 100000  | entries one listing may hold                           |

Timeouts, network errors, 429 and 5xx are retried with backoff; other statuses are not. A 404 is success for reads and deletes and a failure for publication. Permits are released while waiting to retry. Cleanup is admitted at half the client budget (minimum one), leaving capacity for foreground work. A failed session establishment or a persistently rejected session is reported as `{ kind: 'authentication', status }`. Publication failures throw `FetchFailureError`, whose `failure` holds the classified reason.

Every network method takes `{ signal }`. Aborting releases capacity at once; the outcome of an interrupted PUT or DELETE is unknown, so retry the saved prepared message or cleanup IDs.

`client.requestStats()` returns cumulative LIST, GET, PUT, DELETE and session attempts, body bytes, retries, timeouts and admission wait (`queueWaitMs`). It records no payloads, destinations or credentials. Profile, follow and explicit sign-in calls are not counted.

## Pluggable storage

All conversation I/O goes through a `MessengerStorage`:

```ts
interface MessengerStorage {
  list(
    dir: string,
    opts: { cursor?: string; limit: number; signal?: AbortSignal },
  ): Promise<string[]>;
  get(address: string, opts?: { signal?: AbortSignal }): Promise<Uint8Array | null>; // null on 404
  put(path: string, body: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void>;
  delete(path: string, opts?: { signal?: AbortSignal }): Promise<void>; // 404 resolves
  getConditional?(
    address: string,
    opts: { ifNoneMatch?: string; signal?: AbortSignal },
  ): Promise<ConditionalGetResult | null>;
}
```

`list` takes a `pubky://<owner>/<path>/` directory and returns full `pubky://` entry addresses, one page. `get` is a public read; `put` and `delete` write to the signed-in owner's storage at an absolute path like `/pub/...`. The optional `getConditional` reports entity tags and answers `If-None-Match`, for `ChangePolicy.Revalidate`.

Errors should carry an HTTP status so the engine can classify them. Throw `new StorageError(message, { status, authentication?, retryAfterMs? })` (or `StorageError.fromStatus(status, { retryAfterMs })`); the engine also reads `status`, `statusCode` or `data.statusCode` from any error, which covers the SDK's `PubkyError`. An error without a status is a transport failure.

`createPubkyStorage(pubky, session?)` is the default adapter: `pubky.publicStorage` for reads and listings, `session.storage` for writes and deletes, and `pubky.client.fetch` (without following redirects) for `getConditional`. SDK calls take no `AbortSignal`, so on abort the adapter stops waiting but the request may still complete. Pass it, or your own adapter, as `new PrivateMessengerClient(keypair, { storage })`.

## Try it: interactive chat

An interactive terminal chat, a port of the Rust `conversation.rs` example, lives in [`examples/chat.ts`](examples/chat.ts).

```sh
npm run chat
npm run chat -- --file ./alice.pkarr --passphrase 'secret' --peer pk:<their-pubky>
npm run chat -- --phrase "abandon abandon ... about" --peer <z32-pubky>
```

Flags (anything omitted is prompted for): `-f/--file`, `-m/--phrase`, `-p/--passphrase`, `--peer` (also accepted positionally), `-h/--help`. For a quick spin with the bundled test identities:

```sh
npm run chat -- --file test/fixtures/p1.pkarr --passphrase password \
  --peer ssffc7wiswjzdtt7nw93fa9wy9bus34puyy39giityofcibh9qny
```

## Web demo (runs in the browser)

`examples/web/` is a static single-page chat app built with Vite. It runs the library entirely in the browser: the `@synonymdev/pubky` WASM client resolves homeservers through public pkarr relays and talks to them over HTTPS, so there is no backend.

```sh
npm run web:dev       # dev server with hot reload
npm run web:build     # static build into dist-web/
npm run web:preview   # preview the built site
```

The workflow at `.github/workflows/deploy-pages.yml` builds it and deploys to GitHub Pages on every push to `main` (enable Pages with GitHub Actions as the source).

Sessions are grants that authenticate each request with a bearer token in the `Authorization` header, not with a cookie, so a page on another site (such as `github.io`) can send as well as read. The staging homeserver answers CORS preflights for authenticated `PUT` requests from other origins (checked with a preflight request; the demo was not driven in a browser for this release). The third-party cookie limitation applies only to the cookie fallback used with homeservers older than 0.16.

## API

### `PrivateMessengerClient` (protocol v1)

**Construction**

- `new PrivateMessengerClient(keypair: Keypair, options?: PrivateMessengerOptions)` with `options: { pubky?, storage?, fetchConfig?, clientId? }`
- `static fromRecoveryFile(bytes: Uint8Array, passphrase = '', options?)`
- `static fromRecoveryPhrase(mnemonic: string, passphrase = '', wordlist = englishWordlist, options?)`
- `withFetchConfig(config: Partial<FetchConfig>): this`, `fetchConfig(): FetchConfig`, `pubky(): Pubky`

**Sessions**

- `signIn(): Promise<Session>`
- `signUp(homeserver: PeerKey, signupToken?: string | null): Promise<Session>`
- `ensureSession(homeserver: PeerKey, signupToken?: string | null): Promise<Session>`
- `currentSession(): Session | null`

**Messaging** (every network method also takes `options?: { signal?: AbortSignal }`)

- `prepareMessage(recipient: PeerKey, content: string): PreparedMessage`
- `publishMessage(prepared: PreparedMessage): Promise<string>`
- `sendMessage(recipient: PeerKey, content: string): Promise<string>`
- `getMessages(other: PeerKey): Promise<DecryptedMessage[]>`
- `fetchMessages(other: PeerKey): Promise<MessageFetch>`
- `receiveNewMessages(other: PeerKey, state: ReceiveState): Promise<ReceivedMessages>`
- `discoverMessages(other: PeerKey, state: ReceiveState): Promise<Discovery>`
- `retrieveMessages(other: PeerKey, pending: readonly PendingMessage[]): Promise<ReceivedMessages>`
- `deleteMessage(id: string, other: PeerKey): Promise<void>`
- `deleteMessages(ids: string[], other: PeerKey): Promise<void>`
- `deleteMessagesWithReport(ids: readonly string[], other: PeerKey): Promise<MessageDeletion>`
- `clearMessages(other: PeerKey): Promise<void>`
- `clearMessagesWithReport(other: PeerKey): Promise<MessageDeletion>`
- `requestStats(): RequestStats`

**Profiles and follows** (`pubky.app` schema)

- `getOwnProfile(): Promise<PubkyProfile | null>`
- `getFollowedUsers(): Promise<FollowedUser[]>`, `getFollowedUsersFor(pubky: string): Promise<FollowedUser[]>`
- `putFollow(targetPubky: string): Promise<void>`, `deleteFollow(targetPubky: string): Promise<void>`

**Identity**

- `publicKey(): PublicKey`, `publicKeyString(): string` (bare z-base-32), `keypair(): Keypair`

`PeerKey` is a `PublicKey` or its text (bare z-base-32, or `pubky`/`pk:` prefixed).

### Types and helpers

- `DecryptedMessage { sender: string; content: string; timestamp: number; verified: boolean }` (sender is bare z-base-32, timestamp Unix seconds)
- `MessageFetch { messages; failures }`, `MessageDeletion { deleted; failures }`
- `FetchFailure { url; attempts; reason: FailureReason }`; `describeFetchFailure(failure)`; `FetchFailureError`
- `FailureReason`: `status`, `authentication`, `timedOut`, `transport`, `listingStalled`, `listingTooLong`, `outsideConversation` (by `kind`)
- `FetchConfig`, `DEFAULT_FETCH_CONFIG`, `resolveFetchConfig(partial)`
- `ReceiveState` (`acknowledge`, `isAcknowledged`, `acknowledgedIds`, `lastListingComplete`, `lastListedPublishers`, `size`, `isEmpty`, `toJSON`, `fromJSON`), `ChangePolicy`
- `MessageId { publisher; url }`, `messageUuid(id | url)`, `PendingMessage`, `ReceivedMessage`, `ReceivedMessages`, `Discovery`
- `PreparedMessage` (`id`, `owner`, `recipient`, `version`, `payload`, `timestamp`, `validate`, `toJSON`, `fromJSON`, `serialize`, `deserialize`)
- `RequestStats`, `RequestCounts`
- `MessengerStorage`, `ConditionalGetResult`, `StorageError`, `createPubkyStorage(pubky, session?)`, `storageErrorInfo(error)`, `parseRetryAfter(header)`
- `PrivateMessage` (the lower-level v1 message), `ConversationKey`, `generateSharedSecret`, `generateConversationPath`
- Re-exported from `@synonymdev/pubky`: `Keypair`, `PublicKey`, `Pubky`, `Session`; and `englishWordlist`

## How it works

Each message is stored as JSON at a deterministic, per-conversation path under the **sender's** own storage:

```
pubky://<sender>/pub/private_messages/<conversationId>/<uuid>.json
```

- **Conversation ID**: `blake3(hex(ecdh_shared_secret))`, hashing the 64 ASCII hex characters, identical for both directions.
- **Key agreement**: Ed25519 identity keys are converted to X25519 (SHA-512 + RFC 7748 clamp for the scalar; `u = (1+y)/(1-y)` for the point). A key whose shared secret is all zero (a small-order point) is rejected.
- **Encryption**: XSalsa20-Poly1305 (NaCl `secretbox`, as in `pubky-common`): `nonce(24) || tag(16) || ciphertext`, a random nonce per field. Empty plaintext encrypts to an empty byte string. The content and the sender's bare z-base-32 key are encrypted; decryption rejects invalid UTF-8.
- **Authentication**: each message is Ed25519-signed over `blake3(content || sender_pubkey || timestamp_be)`.
- **Format**: compact JSON `{"timestamp":..,"encrypted_sender":[..],"encrypted_content":[..],"signature_bytes":[..]}`, byte arrays as arrays of integers, keys in that order.

## Testing

```sh
npm test                 # hermetic unit tests (no network)
npm run test:integration # live end-to-end tests on the staging homeserver (p1/p2 fixtures)
npm run typecheck        # tsc --noEmit
npm run build            # ESM + CJS + d.ts via tsup
```

The unit tests pin the 0.3.0 fixture (conversation path, decryption from both sides, exact signatures, ciphertexts and body bytes, small-order rejection) and port the Rust crate's engine tests onto an in-memory `MessengerStorage`: concurrency limits, deadlines, retries and Retry-After, pagination and its limits, the listing filter, incremental receive, prepared publication and cleanup reports. The integration tests (gated behind `PUBKY_MESSENGER_LIVE`) use the bundled `test/fixtures/p1.pkarr` and `p2.pkarr` identities, which live on the staging homeserver `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy`.

## Relationship to the Rust crate

|                             | Rust `pubky-messenger` 0.5.0 | `pubky-messenger-ts` 0.5.0                                |
| --------------------------- | ---------------------------- | --------------------------------------------------------- |
| Network client              | `pubky` 0.16.2               | `@synonymdev/pubky` 0.17.x (WASM), peer dependency        |
| Storage I/O                 | its own HTTP transport       | `MessengerStorage` adapter (default over the SDK)         |
| Durations                   | `Duration`                   | milliseconds (`...Ms` fields)                             |
| Errors                      | `anyhow::Result`             | thrown `Error` / rejected `Promise`; typed `FetchFailure` |
| Cancellation                | dropping the future          | `AbortSignal`                                             |
| Method names                | `snake_case`                 | `camelCase`                                               |
| Cipher / signatures / paths | same                         | identical (wire-compatible)                               |

The TS port does not reimplement the Rust transport's same-origin redirect policy for every request: reads and listings go through the SDK, and only `getConditional` refuses redirects.

## License

MIT
