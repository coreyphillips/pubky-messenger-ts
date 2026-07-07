# pubky-messenger-ts

End-to-end encrypted, one-to-one private messaging over the [Pubky](https://github.com/pubky) network.

This is a faithful **TypeScript port** of the Rust [`pubky-messenger`](../pubky-messenger) crate, built on the official [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) client. It is **wire-compatible** with the Rust implementation: messages encrypted and signed by one can be read and verified by the other (validated against the Rust-created `p1.pkarr`/`p2.pkarr` test identities, see [Interoperability](#interoperability)).

## Features

- End-to-end encrypted 1:1 messaging (X25519 ECDH + XSalsa20-Poly1305)
- Ed25519 message signatures with verification
- Identity from a `.pkarr` recovery file or a 12-word BIP39 recovery phrase
- Message management: send, list, delete, batch-delete, clear
- Profile and follow (contact) helpers over the `pubky.app` schema
- Ships ESM + CommonJS + type declarations; runs on Node and in the browser (via the pubky WASM)

## Installation

```sh
npm install pubky-messenger-ts
```

Requires Node.js 18+. The peer network client `@synonymdev/pubky` is a dependency.

## Quick start

```ts
import { PrivateMessengerClient, PublicKey } from 'pubky-messenger-ts';
import { readFileSync } from 'node:fs';

// 1. Load an identity (recovery file, recovery phrase, or a raw Keypair).
const recoveryFile = new Uint8Array(readFileSync('alice.pkarr'));
const client = PrivateMessengerClient.fromRecoveryFile(recoveryFile, 'passphrase');

// 2. Sign in to the homeserver (the account must already exist).
await client.signIn();

// 3. Send an encrypted message.
const recipient = PublicKey.from('ssffc7wiswjzdtt7nw93fa9wy9bus34puyy39giityofcibh9qny');
const messageId = await client.sendMessage(recipient, 'Hello, world!');

// 4. Read the conversation (sorted oldest-first, each message signature-verified).
const messages = await client.getMessages(recipient);
for (const m of messages) {
  console.log(`${m.timestamp} ${m.sender}: ${m.content} (verified: ${m.verified})`);
}

// 5. Delete a message you sent.
await client.deleteMessage(messageId, recipient);
```

### Other ways to create a client

```ts
import { PrivateMessengerClient, Keypair } from 'pubky-messenger-ts';

// From a 12-word BIP39 recovery phrase (optional passphrase + wordlist; defaults English):
const a = PrivateMessengerClient.fromRecoveryPhrase(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);

// From a passphrase-protected phrase:
const b = PrivateMessengerClient.fromRecoveryPhrase(mnemonic, 'my passphrase');

// From an existing keypair:
const c = new PrivateMessengerClient(Keypair.random());
```

For a non-English mnemonic, pass a wordlist from `@scure/bip39`:

```ts
import { wordlist as spanish } from '@scure/bip39/wordlists/spanish.js';
const client = PrivateMessengerClient.fromRecoveryPhrase(mnemonic, '', spanish);
```

## Try it: interactive chat

An interactive terminal chat, a port of the Rust `conversation.rs` example, lives in [`examples/chat.ts`](examples/chat.ts). Load an identity from a recovery phrase or a `.pkarr` file, pick a peer, and start talking: it shows recent history, polls for new messages every few seconds, and sends what you type.

```sh
# Prompts interactively for identity and peer:
npm run chat

# Or pass everything up front:
npm run chat -- --file ./alice.pkarr --passphrase 'secret' --peer pk:<their-pubky>
npm run chat -- --phrase "abandon abandon ... about" --peer <z32-pubky>
```

Flags (anything omitted is prompted for): `-f/--file`, `-m/--phrase`, `-p/--passphrase`, `--peer` (also accepted positionally), `-h/--help`. Press Ctrl+C to exit.

For a quick spin using the bundled test identities:

```sh
npm run chat -- --file test/fixtures/p1.pkarr --passphrase password \
  --peer ssffc7wiswjzdtt7nw93fa9wy9bus34puyy39giityofcibh9qny
```

## Web demo (runs in the browser)

`examples/web/` is a static single-page chat app built with Vite. It runs the library entirely in the browser: the `@synonymdev/pubky` WASM client resolves homeservers through public pkarr relays and talks to them over HTTPS, so there is no backend to run. It can be hosted on GitHub Pages as-is.

```sh
npm run web:dev       # dev server with hot reload
npm run web:build     # static build into dist-web/
npm run web:preview   # preview the built site
```

Load an identity from a recovery phrase or a `.pkarr` file (or click one of the bundled test identities), enter a peer public key, and chat. Keys are derived locally in your browser and are never uploaded.

### Hosting on GitHub Pages

The workflow at `.github/workflows/deploy-pages.yml` builds `examples/web/` and deploys it on every push to `main`. Enable it once in the repository under Settings, Pages, by setting the source to GitHub Actions. The site is then served at `https://<user>.github.io/pubky-messenger-ts/`.

## API

### `PrivateMessengerClient`

**Construction**

- `new PrivateMessengerClient(keypair: Keypair)`
- `static fromRecoveryFile(bytes: Uint8Array, passphrase = ''): PrivateMessengerClient`
- `static fromRecoveryPhrase(mnemonic: string, passphrase = '', wordlist = englishWordlist): PrivateMessengerClient`

**Authentication**

- `signIn(): Promise<Session>`: sign in to the homeserver. Required before sending or deleting. The account must already be registered on a homeserver.

**Messaging**

- `sendMessage(recipient: PublicKey, content: string): Promise<string>`: returns the new message ID.
- `getMessages(other: PublicKey): Promise<DecryptedMessage[]>`: both parties' messages, decrypted, signature-verified, sorted by timestamp ascending.
- `deleteMessage(messageId: string, other: PublicKey): Promise<void>`
- `deleteMessages(messageIds: string[], other: PublicKey): Promise<void>`: parallel delete.
- `clearMessages(other: PublicKey): Promise<void>`: delete **all of your own** sent messages in a conversation (the other party's copies remain). Batched with rate-limit handling.

**Profiles and follows** (`pubky.app` schema)

- `getOwnProfile(): Promise<PubkyProfile | null>`
- `getFollowedUsers(): Promise<FollowedUser[]>`
- `getFollowedUsersFor(pubky: string): Promise<FollowedUser[]>`
- `putFollow(targetPubky: string): Promise<void>`
- `deleteFollow(targetPubky: string): Promise<void>`

**Identity**

- `publicKey(): PublicKey`
- `publicKeyString(): string`

### Types

```ts
interface DecryptedMessage {
  sender: string; // z-base32 public key of the sender
  content: string;
  timestamp: number; // Unix seconds
  verified: boolean; // Ed25519 signature verified
}

interface PubkyProfile {
  name: string;
  bio?: string;
  image?: string;
  status?: string;
}

interface FollowedUser {
  name?: string; // resolved from the followee's profile, if available
  pubky: string;
}
```

Also exported: `PrivateMessage` (the lower-level encrypted-message primitive), and `Keypair` / `PublicKey` re-exported from `@synonymdev/pubky`.

## How it works

Each message is stored as JSON at a deterministic, per-conversation path under the **sender's** own storage:

```
pubky://<sender>/pub/private_messages/<conversationId>/<uuid>.json
```

- **Conversation ID**: `blake3(hex(ecdh_shared_secret))`, identical for both directions, so both parties list and read the same folder.
- **Key agreement**: Ed25519 identity keys are converted to X25519 (SHA-512 + RFC-7748 clamp for the scalar; the birational map `u = (1+y)/(1-y)` for the point), then X25519 ECDH produces the shared secret.
- **Encryption**: XSalsa20-Poly1305 (NaCl `secretbox`): a random 24-byte nonce is prepended to each ciphertext. Both the content and the sender's public key are encrypted.
- **Authentication**: each message is Ed25519-signed over `blake3(content || sender_pubkey || timestamp_be)`; `getMessages` verifies every signature.

`getMessages` reads both participants' folders via public storage; writes and deletes go through the authenticated session storage.

> Note: the Rust crate's README/architecture docs describe the cipher as "ChaCha20-Poly1305," but the actual `pubky-common` cipher (and therefore this port) is **XSalsa20-Poly1305**. This was verified against `pubky-common` source and by decrypting Rust-written messages (see below).

## Interoperability

This library is verified to interoperate with the Rust `pubky-messenger` at the wire level:

- `Keypair.fromRecoveryFile` decrypts the Rust-created `p1.pkarr`/`p2.pkarr` files to their exact public keys (a known-answer unit test).
- Running the live suite, this client reads and **signature-verifies messages that were written by the Rust implementation** (same conversation-path derivation, same XSalsa20-Poly1305 decryption, same Ed25519 verification).

The message JSON is byte-compatible: snake_case field names and byte arrays serialized as `number[]`, timestamps in Unix seconds.

## Testing

```sh
npm test                 # hermetic unit tests (no network)
npm run test:integration # live end-to-end tests against the real network (needs the p1/p2 fixtures)
npm run typecheck        # tsc --noEmit
npm run build            # ESM + CJS + d.ts via tsup
```

The unit tests cover the crypto conversions (validated against noble's `x25519.getPublicKey`), secretbox, message encrypt/decrypt/verify, the JSON wire format, and BIP39 recovery. The integration tests (gated behind `PUBKY_MESSENGER_LIVE`) exercise send/get/delete/clear and profile/follow reads using the bundled `test/fixtures/p1.pkarr` and `p2.pkarr` identities.

## Relationship to the Rust crate

|                             | Rust `pubky-messenger` | `pubky-messenger-ts`                |
| --------------------------- | ---------------------- | ----------------------------------- |
| Network client              | `pubky` crate (0.4.x)  | `@synonymdev/pubky` (0.9.x, WASM)   |
| Errors                      | `anyhow::Result`       | thrown `Error` / rejected `Promise` |
| Method names                | `snake_case`           | `camelCase`                         |
| Cipher / signatures / paths | same                   | identical (wire-compatible)         |

## License

MIT
