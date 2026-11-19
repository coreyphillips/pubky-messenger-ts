import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuthFlowKind } from '@synonymdev/pubky';
import {
  Keypair,
  MESSAGING_CAPABILITIES,
  MESSAGING_KEY_PATH,
  MessagingIdentity,
  MessengerV2Client,
  Pubky,
  ReceiveState,
  createPubkyStorage,
  deriveMessagingSeed,
  messageUuid,
  type Session,
} from '../../src';

// Protocol v2 against the staging homeserver with real grant sessions, approved locally by the
// p1/p2 signers through the staging relay. Skipped unless PUBKY_MESSENGER_LIVE is set.
const LIVE = Boolean(process.env.PUBKY_MESSENGER_LIVE);
const suite = LIVE ? describe : describe.skip;

const RELAY = 'https://httprelay.staging.pubky.app/inbox';
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Participant {
  owner: string;
  session: Session;
  identity: MessagingIdentity;
  client: MessengerV2Client;
}

suite('live protocol v2 (grant sessions, p1/p2.pkarr)', () => {
  const pubky = new Pubky();
  let alice: Participant;
  let bob: Participant;

  async function participant(file: string): Promise<Participant> {
    const keypair = Keypair.fromRecoveryFile(fixture(file), 'password');
    const flow = await pubky.startGrantAuthFlow(MESSAGING_CAPABILITIES, AuthFlowKind.signin(), {
      clientId: 'pubky-messenger-test',
      relay: RELAY,
      approvalFormat: 'signedApprovalV1',
    });
    const approving = pubky.signer(keypair).approveAuthRequest(flow.authorizationUrl);
    const session = await flow.awaitApproval();
    await approving;
    const keys = session.grant!.encryptionKeys!;
    const seed = keys.deriveForPath(MESSAGING_KEY_PATH);
    keys.free();
    // The grant delivers the same seed the identity secret derives locally
    expect(seed).toEqual(deriveMessagingSeed(keypair.secret()));
    const identity = MessagingIdentity.fromSeed(seed);
    seed.fill(0);
    const owner = keypair.publicKey.z32();
    const client = new MessengerV2Client({
      owner,
      identity,
      storage: createPubkyStorage(pubky, session),
    });
    return { owner, session, identity, client };
  }

  beforeAll(async () => {
    alice = await participant('p1.pkarr');
    bob = await participant('p2.pkarr');
  }, 120_000);

  afterAll(async () => {
    for (const p of [alice, bob]) {
      if (!p) continue;
      const peer = p === alice ? bob : alice;
      if (peer) await p.client.clearMessagesWithReport(peer.owner).catch(() => undefined);
      await p.session.signout().catch(() => undefined);
      p.identity.dispose();
    }
  }, 120_000);

  it('publishes and verifies key records', async () => {
    const records = [await alice.client.publishKeyRecord(), await bob.client.publishKeyRecord()];
    expect(records.map((r) => r.messagingKey)).toEqual([
      alice.identity.publicKeyZ32(),
      bob.identity.publicKeyZ32(),
    ]);
    const fetched = await alice.client.fetchKeyRecord(bob.owner, { refresh: true });
    expect(fetched).toMatchObject({ owner: bob.owner, messagingKey: bob.identity.publicKeyZ32() });
    expect(await bob.client.fetchKeyRecord(alice.owner, { refresh: true })).toMatchObject({
      messagingKey: alice.identity.publicKeyZ32(),
    });
  });

  it('sends and reads v2 messages both ways', async () => {
    const stamp = Date.now();
    const bobState = new ReceiveState();
    const before = await bob.client.receiveNewMessages(alice.owner, bobState);
    expect(before.failures).toEqual([]);
    for (const m of before.messages) bobState.acknowledge(m);

    const prepared = await alice.client.prepareMessage(bob.owner, `v2 from alice ${stamp}`);
    const fromAlice = await alice.client.publishMessage(prepared);
    expect(fromAlice).toBe(prepared.id());
    const fromBob = await bob.client.sendMessage(alice.owner, `v2 from bob ${stamp}`);
    await sleep(700);

    for (const reader of [alice, bob]) {
      const peer = reader === alice ? bob : alice;
      const fetch = await reader.client.fetchMessages(peer.owner);
      expect(fetch.failures).toEqual([]);
      const ours = fetch.messages.filter((m) => m.content.endsWith(`${stamp}`));
      expect(ours.map((m) => [m.sender, m.content, m.verified])).toEqual(
        expect.arrayContaining([
          [alice.owner, `v2 from alice ${stamp}`, true],
          [bob.owner, `v2 from bob ${stamp}`, true],
        ]),
      );
    }

    const received = await bob.client.receiveNewMessages(alice.owner, bobState);
    expect(received.complete).toBe(true);
    expect(received.messages.map((m) => messageUuid(m.id)).sort()).toEqual(
      [fromAlice, fromBob].sort(),
    );
    const fromAliceItem = received.messages.find((m) => messageUuid(m.id) === fromAlice)!;
    expect(fromAliceItem.message).toMatchObject({
      sender: alice.owner,
      timestamp: prepared.timestamp(),
      verified: true,
    });

    const discovery = await bob.client.discoverConversations([alice.owner]);
    expect(discovery).toEqual({ active: [alice.owner], withoutKey: [], failures: [] });

    const report = await alice.client.deleteMessagesWithReport([fromAlice], bob.owner);
    expect(report.failures).toEqual([]);
    expect(report.deleted.length).toBe(1);
    const cleared = await bob.client.clearMessagesWithReport(alice.owner);
    expect(cleared.failures).toEqual([]);
    await sleep(700);
    expect(
      (await alice.client.fetchMessages(bob.owner)).messages.filter((m) =>
        m.content.endsWith(`${stamp}`),
      ),
    ).toEqual([]);
  });
});
