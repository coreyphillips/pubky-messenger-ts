import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrivateMessengerClient, type PublicKey } from '../../src';

// These tests hit the real Pubky network using the bundled p1/p2 test identities.
// They are skipped unless PUBKY_MESSENGER_LIVE is set (e.g. `npm run test:integration`).
const LIVE = Boolean(process.env.PUBKY_MESSENGER_LIVE);
const suite = LIVE ? describe : describe.skip;

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

suite('live end-to-end messaging (real network, p1/p2.pkarr)', () => {
  let alice: PrivateMessengerClient;
  let bob: PrivateMessengerClient;
  let alicePk: PublicKey;
  let bobPk: PublicKey;

  beforeAll(async () => {
    alice = PrivateMessengerClient.fromRecoveryFile(fixture('p1.pkarr'), 'password');
    bob = PrivateMessengerClient.fromRecoveryFile(fixture('p2.pkarr'), 'password');
    alicePk = alice.publicKey();
    bobPk = bob.publicKey();
    await alice.signIn();
    await bob.signIn();
  }, 60_000);

  it('reads any pre-existing messages and reports verification (cross-impl check)', async () => {
    const msgs = await alice.getMessages(bobPk);
    const verified = msgs.filter((m) => m.verified).length;
    // eslint-disable-next-line no-console
    console.log(`[live] pre-existing alice<->bob messages: ${msgs.length} (verified: ${verified})`);
    for (const m of msgs) {
      expect(typeof m.content).toBe('string');
      expect(typeof m.sender).toBe('string');
    }
  });

  it('send -> get -> delete round trip', async () => {
    const before = await alice.getMessages(bobPk);
    const marker = `TS live test ${Date.now()}`;

    const id = await alice.sendMessage(bobPk, marker);
    await sleep(700);

    const after = await alice.getMessages(bobPk);
    const mine = after.find((m) => m.content === marker);
    expect(mine).toBeTruthy();
    expect(mine!.sender).toBe(alice.publicKeyString());
    expect(mine!.verified).toBe(true);

    await alice.deleteMessage(id, bobPk);
    await sleep(700);

    const cleaned = await alice.getMessages(bobPk);
    expect(cleaned.some((m) => m.content === marker)).toBe(false);
    expect(cleaned.length).toBe(before.length);
  });

  it('the recipient can read and verify a message (bidirectional decrypt)', async () => {
    const marker = `TS bidir ${Date.now()}`;
    const id = await alice.sendMessage(bobPk, marker);
    await sleep(700);

    const bobView = await bob.getMessages(alicePk);
    const got = bobView.find((m) => m.content === marker);
    expect(got).toBeTruthy();
    expect(got!.sender).toBe(alice.publicKeyString());
    expect(got!.verified).toBe(true);

    await alice.deleteMessage(id, bobPk);
  });

  it('deleteMessages removes a batch by id', async () => {
    const before = await alice.getMessages(bobPk);
    const stamp = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await alice.sendMessage(bobPk, `TS batch ${stamp} #${i}`));
    }
    await sleep(900);
    expect((await alice.getMessages(bobPk)).length).toBe(before.length + 3);

    await alice.deleteMessages(ids, bobPk);
    await sleep(900);
    expect((await alice.getMessages(bobPk)).length).toBe(before.length);
  });

  it('getOwnProfile / getFollowedUsers do not throw', async () => {
    const profile = await alice.getOwnProfile();
    const follows = await alice.getFollowedUsers();
    // eslint-disable-next-line no-console
    console.log(`[live] alice profile: ${profile?.name ?? 'none'}, follows: ${follows.length}`);
    expect(Array.isArray(follows)).toBe(true);
  });

  it("clearMessages removes all of the caller's own sent messages", async () => {
    const stamp = Date.now();
    await alice.sendMessage(bobPk, `TS clear ${stamp} a`);
    await alice.sendMessage(bobPk, `TS clear ${stamp} b`);
    await sleep(900);

    await alice.clearMessages(bobPk);
    await sleep(900);

    const remaining = await alice.getMessages(bobPk);
    const aliceOwn = remaining.filter((m) => m.sender === alice.publicKeyString());
    expect(aliceOwn.length).toBe(0);
  });
});
