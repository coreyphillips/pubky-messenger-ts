import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@synonymdev/pubky';
import { PrivateMessengerClient } from '../../src/client';

const VALID =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

describe('client creation', () => {
  it('publicKeyString matches the keypair', () => {
    const kp = Keypair.random();
    const client = new PrivateMessengerClient(kp);
    expect(client.publicKeyString()).toBe(kp.publicKey.z32());
  });
});

describe('fromRecoveryPhrase (BIP39)', () => {
  it('creates a client from a valid 12-word mnemonic', () => {
    const client = PrivateMessengerClient.fromRecoveryPhrase(VALID);
    expect(client.publicKeyString()).not.toBe('');
  });

  it('is deterministic', () => {
    const a = PrivateMessengerClient.fromRecoveryPhrase(VALID);
    const b = PrivateMessengerClient.fromRecoveryPhrase(VALID);
    expect(a.publicKeyString()).toBe(b.publicKeyString());
  });

  it('a passphrase changes the derived key (deterministically)', () => {
    const none = PrivateMessengerClient.fromRecoveryPhrase(VALID);
    const withPass = PrivateMessengerClient.fromRecoveryPhrase(VALID, 'my_secure_passphrase');
    const withPass2 = PrivateMessengerClient.fromRecoveryPhrase(VALID, 'my_secure_passphrase');
    expect(none.publicKeyString()).not.toBe(withPass.publicKeyString());
    expect(withPass.publicKeyString()).toBe(withPass2.publicKeyString());
  });

  it('different mnemonics derive different keys', () => {
    const other = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    expect(PrivateMessengerClient.fromRecoveryPhrase(VALID).publicKeyString()).not.toBe(
      PrivateMessengerClient.fromRecoveryPhrase(other).publicKeyString(),
    );
  });

  it('rejects invalid mnemonics', () => {
    const invalidCases = [
      'invalid mnemonic phrase here',
      'abandon abandon abandon',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
      '',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    ];
    for (const mnemonic of invalidCases) {
      expect(() => PrivateMessengerClient.fromRecoveryPhrase(mnemonic)).toThrow();
    }
  });

  it('is case-sensitive (uppercase is rejected)', () => {
    expect(() => PrivateMessengerClient.fromRecoveryPhrase(VALID.toUpperCase())).toThrow();
  });
});

describe('fromRecoveryFile (known-answer interop with Rust-created p1/p2.pkarr)', () => {
  it('decrypts p1/p2 to their exact public keys', () => {
    const c1 = PrivateMessengerClient.fromRecoveryFile(fixture('p1.pkarr'), 'password');
    const c2 = PrivateMessengerClient.fromRecoveryFile(fixture('p2.pkarr'), 'password');
    expect(c1.publicKeyString()).toBe('w5ux3c55ujxq7rpb6x9z9wo554s4eb4zeuh1933b94zk7qsfxd1o');
    expect(c2.publicKeyString()).toBe('ssffc7wiswjzdtt7nw93fa9wy9bus34puyy39giityofcibh9qny');
    expect(c1.publicKeyString()).not.toBe(c2.publicKeyString());
  });

  it('throws a clear error on the wrong passphrase', () => {
    expect(() => PrivateMessengerClient.fromRecoveryFile(fixture('p1.pkarr'), 'wrong')).toThrow(
      /recovery file/i,
    );
  });
});
