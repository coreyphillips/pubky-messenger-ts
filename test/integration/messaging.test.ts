import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PreparedMessage,
  PrivateMessengerClient,
  ReceiveState,
  messageUuid,
  type PublicKey,
} from '../../src';

// These tests hit the real Pubky network (the staging homeserver the bundled p1/p2 identities
// live on). They are skipped unless PUBKY_MESSENGER_LIVE is set (`npm run test:integration`).
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
    const options = { clientId: 'pubky-messenger-test' };
    alice = PrivateMessengerClient.fromRecoveryFile(fixture('p1.pkarr'), 'password', options);
    bob = PrivateMessengerClient.fromRecoveryFile(fixture('p2.pkarr'), 'password', options);
    alicePk = alice.publicKey();
    bobPk = bob.publicKey();
    await alice.signIn();
    await bob.signIn();
  }, 60_000);

  it('reads any pre-existing messages and reports verification (cross-impl check)', async () => {
    const fetch = await alice.fetchMessages(bobPk);
    const verified = fetch.messages.filter((m) => m.verified).length;
    // eslint-disable-next-line no-console
    console.log(
      `[live] pre-existing alice<->bob messages: ${fetch.messages.length} (verified: ${verified}, failures: ${fetch.failures.length})`,
    );
    expect(fetch.failures).toEqual([]);
    for (const m of fetch.messages) {
      expect(typeof m.content).toBe('string');
      expect(m.sender).toMatch(/^[a-z0-9]{52}$/);
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

  it('the recipient receives incrementally and verifies (bidirectional decrypt)', async () => {
    const state = new ReceiveState();
    const initial = await bob.receiveNewMessages(alicePk, state);
    expect(initial.complete).toBe(true);
    for (const m of initial.messages) state.acknowledge(m);

    const marker = `TS bidir ${Date.now()}`;
    const prepared = alice.prepareMessage(bobPk, marker);
    const restored = PreparedMessage.fromJSON(JSON.parse(JSON.stringify(prepared)));
    const id = await alice.publishMessage(restored);
    // Republishing the same value stores the same resource
    expect(await alice.publishMessage(restored)).toBe(id);
    await sleep(700);

    const restoredState = ReceiveState.fromJSON(JSON.parse(JSON.stringify(state)));
    const received = await bob.receiveNewMessages(alicePk, restoredState);
    expect(received.messages.length).toBe(1);
    const got = received.messages[0]!;
    expect(messageUuid(got.id)).toBe(id);
    expect(got.message!.content).toBe(marker);
    expect(got.message!.sender).toBe(alice.publicKeyString());
    expect(got.message!.timestamp).toBe(prepared.timestamp());
    expect(got.message!.verified).toBe(true);
    restoredState.acknowledge(got);

    const report = await alice.deleteMessagesWithReport([id, id], bobPk);
    expect(report.failures).toEqual([]);
    expect(report.deleted.length).toBe(1);
    await sleep(700);
    const after = await bob.discoverMessages(alicePk, restoredState);
    expect(after.pending).toEqual([]);
    expect(restoredState.acknowledgedIds().some((m) => messageUuid(m) === id)).toBe(false);
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
    const stats = alice.requestStats();
    expect(stats.put.attempts).toBeGreaterThanOrEqual(3);
    expect(stats.delete.attempts).toBeGreaterThanOrEqual(3);
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

    const report = await alice.clearMessagesWithReport(bobPk);
    expect(report.failures).toEqual([]);
    await sleep(900);

    const remaining = await alice.getMessages(bobPk);
    const aliceOwn = remaining.filter((m) => m.sender === alice.publicKeyString());
    expect(aliceOwn.length).toBe(0);
  });
});
