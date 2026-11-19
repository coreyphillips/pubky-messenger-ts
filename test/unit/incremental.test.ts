import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Keypair } from '@synonymdev/pubky';
import { receiveMessages, v1Conversation } from '../../src/conversation';
import {
  createEngine,
  outsideConversation,
  type EngineContext,
  type FetchFailure,
} from '../../src/engine';
import {
  ChangePolicy,
  ReceiveState,
  discover,
  receiveNew,
  retrieve,
  type PendingMessage,
  type ReceivedMessages,
} from '../../src/incremental';
import { PrivateMessage } from '../../src/message';
import { percentEncode } from '../../src/bytes';
import { messageUuid } from '../../src/engine';
import {
  FakeStorage,
  directory,
  entriesOutside,
  keypair,
  settle,
  z32,
} from '../support/fake-storage';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

class Conversation {
  readonly server = new FakeStorage(50);
  readonly alice = keypair(1);
  readonly bob = keypair(2);
  readonly ctx: EngineContext;

  constructor(pageSize: number) {
    this.ctx = createEngine(this.server.storageFor(z32(this.alice)), {
      maxAttempts: 1,
      listPageSize: pageSize,
    });
  }

  /** Publish from Alice when `alice`, else from Bob. */
  add(alice: boolean, name: string, timestamp: number, content: string): string {
    const [author, other] = alice ? [this.alice, this.bob] : [this.bob, this.alice];
    return this.server.add(author, other, name, timestamp, content);
  }

  conv(other: Keypair = this.bob) {
    return v1Conversation(
      this.alice.secret(),
      z32(this.alice),
      z32(other),
      other.publicKey.toUint8Array(),
    );
  }

  /** Alice receives. */
  receive(state: ReceiveState): Promise<ReceivedMessages> {
    return settle(receiveNew(this.ctx, this.conv(), state));
  }

  discover(state: ReceiveState) {
    return settle(discover(this.ctx, this.conv(), state));
  }

  retrieve(pending: PendingMessage[]) {
    return settle(retrieve(this.ctx, this.conv(), pending));
  }

  history() {
    return settle(receiveMessages(this.ctx, this.conv()));
  }

  /** Message requests made, and bodies sent, since the last call. */
  takeCounts(): [number, number] {
    const counts: [number, number] = [
      this.server.state.messageRequests,
      this.server.state.bodiesSent,
    ];
    this.server.resetCounts();
    return counts;
  }
}

const contents = (received: ReceivedMessages): string[] =>
  received.messages.map((r) => r.message!.content);

function acknowledgeAll(state: ReceiveState, received: ReceivedMessages): void {
  for (const message of received.messages) state.acknowledge(message);
}

describe('incremental receive', () => {
  it('an unchanged conversation downloads nothing after acknowledgement', async () => {
    const c = new Conversation(1000);
    c.add(true, 'a1.json', 1, 'from alice');
    c.add(false, 'b1.json', 2, 'from bob');
    const state = new ReceiveState();

    const first = await c.receive(state);
    expect(contents(first)).toEqual(['from alice', 'from bob']);
    expect(first.complete).toBe(true);
    expect(c.takeCounts()).toEqual([2, 2]);
    acknowledgeAll(state, first);

    const second = await c.receive(state);
    expect(second.messages).toEqual([]);
    expect(second.failures).toEqual([]);
    expect(c.takeCounts()).toEqual([0, 0]);
  });

  it('new names before, between and after seen ones are found across pages', async () => {
    const c = new Conversation(2);
    for (const name of ['4', '8', 'c']) c.add(false, `${name}.json`, 10, name);
    const state = new ReceiveState();
    const first = await c.receive(state);
    expect(first.messages.length).toBe(3);
    acknowledgeAll(state, first);
    c.takeCounts();

    // With two entries per page: [0, 4] [6, 8] [c, f]
    c.add(false, '0.json', 20, 'first page');
    c.add(false, '6.json', 21, 'second page');
    c.add(false, 'f.json', 22, 'last page');
    const second = await c.receive(state);

    expect(contents(second)).toEqual(['first page', 'second page', 'last page']);
    expect(second.messages.every((r) => !r.updated)).toBe(true);
    expect(c.takeCounts()).toEqual([3, 3]);
  });

  it('a message published behind the cursor is found by the next discovery', async () => {
    const c = new Conversation(2);
    for (const name of ['2', '4', '6', '8']) c.add(false, `${name}.json`, 1, name);
    const bobDirectory = directory(c.bob, c.alice);
    const secondPage = `${bobDirectory}?limit=2&cursor=${percentEncode(`${bobDirectory}4.json`)}`;
    c.server.afterRequest(secondPage, (server) => {
      server.add(c.bob, c.alice, '0.json', 2, 'late');
    });
    const state = new ReceiveState();

    const first = await c.receive(state);
    expect(first.messages.length).toBe(4);
    expect(c.server.attempts(secondPage)).toBe(1);
    acknowledgeAll(state, first);

    const second = await c.receive(state);
    expect(contents(second)).toEqual(['late']);
  });

  it('failed retrievals and unacknowledged messages are returned again', async () => {
    const c = new Conversation(1000);
    const fails = c.add(false, '1.json', 1, 'fails once');
    c.add(false, '2.json', 2, 'processed');
    c.add(false, '3.json', 3, 'interrupted');
    c.server.reply(fails, [{ status: 500 }, { body: c.server.body(fails) }]);
    const state = new ReceiveState();

    const first = await c.receive(state);
    expect(contents(first)).toEqual(['processed', 'interrupted']);
    expect(first.failures.length).toBe(1);
    expect(first.failures[0]!.url).toBe(fails);
    // Processing stops after the first message, before "interrupted" is acknowledged
    state.acknowledge(first.messages[0]!);
    c.takeCounts();

    const second = await c.receive(state);
    expect(contents(second)).toEqual(['fails once', 'interrupted']);
    expect(second.failures).toEqual([]);
    expect(c.takeCounts()).toEqual([2, 2]);
  });

  it('a failed listing keeps acknowledgements and delivers nothing again', async () => {
    const c = new Conversation(1000);
    c.add(true, 'a.json', 1, 'mine');
    c.add(false, 'b.json', 2, 'theirs');
    const state = new ReceiveState();
    acknowledgeAll(state, await c.receive(state));

    const bobDirectory = directory(c.bob, c.alice);
    const listing = c.server.body(bobDirectory);
    c.server.reply(bobDirectory, [{ status: 503 }]);
    const during = await c.receive(state);
    expect(during.messages).toEqual([]);
    expect(during.failures[0]!.reason).toEqual({ kind: 'status', status: 503 });
    expect(during.complete).toBe(false);
    expect(during.listedPublishers).toEqual([z32(c.alice)]);
    expect(state.lastListingComplete).toBe(false);
    expect(state.size).toBe(2);

    c.server.reply(bobDirectory, [{ body: listing }]);
    c.takeCounts();
    const after = await c.receive(state);
    expect(after.messages).toEqual([]);
    expect(state.lastListingComplete).toBe(true);
    expect(c.takeCounts()).toEqual([0, 0]);
  });

  it('a restored state does not download acknowledged messages', async () => {
    const c = new Conversation(1000);
    c.add(true, 'a.json', 1, 'mine');
    c.add(false, 'b.json', 2, 'theirs');
    const state = new ReceiveState(ChangePolicy.Revalidate);
    acknowledgeAll(state, await c.receive(state));
    const saved = JSON.stringify(state);

    c.add(false, 'c.json', 3, 'while stopped');
    const restored = ReceiveState.fromJSON(JSON.parse(saved));
    expect(restored.equals(state)).toBe(true);
    c.takeCounts();

    const received = await c.receive(restored);
    expect(contents(received)).toEqual(['while stopped']);
    expect(c.server.state.bodiesSent).toBe(1);
    expect(c.server.state.notModified).toBe(2);
  });

  it('deleted messages leave the state', async () => {
    const c = new Conversation(2);
    const urls = [0, 1, 2, 3, 4].map((i) => c.add(i % 2 === 0, `${i}.json`, i, 'hello'));
    const state = new ReceiveState();
    acknowledgeAll(state, await c.receive(state));
    expect(state.size).toBe(5);

    c.server.remove(urls[0]!);
    c.server.remove(urls[3]!);
    const discovery = await c.discover(state);

    expect(discovery.pending).toEqual([]);
    expect(discovery.complete).toBe(true);
    expect(state.size).toBe(3);
    urls.forEach((url, i) => {
      const publisher = z32(i % 2 === 0 ? c.alice : c.bob);
      expect(state.isAcknowledged({ publisher, url })).toBe(i !== 0 && i !== 3);
    });
    expect(
      state
        .acknowledgedIds()
        .map((id) => messageUuid(id))
        .sort(),
    ).toEqual(['1', '2', '4']);

    // Every message deleted, down to the directories
    for (const url of [urls[1]!, urls[2]!, urls[4]!]) c.server.remove(url);
    c.server.reply(directory(c.alice, c.bob), [{ status: 404 }]);
    c.server.reply(directory(c.bob, c.alice), [{ status: 404 }]);
    await c.discover(state);
    expect(state.isEmpty()).toBe(true);
    expect(state.equals(new ReceiveState())).toBe(true);
  });

  it('a message deleted after listing is neither delivered nor a failure', async () => {
    const c = new Conversation(1000);
    const url = c.add(false, 'gone.json', 1, 'gone');
    const state = new ReceiveState();

    const discovery = await c.discover(state);
    c.server.remove(url);
    const received = await c.retrieve(discovery.pending);

    expect(received.messages).toEqual([]);
    expect(received.failures).toEqual([]);
  });

  it('rewritten messages are redelivered only under Revalidate', async () => {
    const c = new Conversation(1000);
    c.add(false, '1.json', 1, 'original');
    const rewritten = c.add(false, '2.json', 2, 'original');
    const writeOnce = new ReceiveState(ChangePolicy.WriteOnce);
    const revalidate = new ReceiveState(ChangePolicy.Revalidate);
    for (const state of [writeOnce, revalidate]) acknowledgeAll(state, await c.receive(state));
    c.takeCounts();

    const unchanged = await c.receive(revalidate);
    expect(unchanged.messages).toEqual([]);
    expect(c.takeCounts()).toEqual([2, 0]);

    const edited = PrivateMessage.createAt(
      c.bob.secret(),
      c.alice.publicKey.toUint8Array(),
      'edited',
      3,
    );
    c.server.reply(rewritten, [{ body: edited.serialize() }]);

    const concealed = await c.receive(writeOnce);
    expect(concealed.messages).toEqual([]);
    expect(c.takeCounts()).toEqual([0, 0]);

    const changed = await c.receive(revalidate);
    expect(contents(changed)).toEqual(['edited']);
    expect(changed.messages[0]!.updated).toBe(true);
    expect(c.takeCounts()).toEqual([2, 1]);
    acknowledgeAll(revalidate, changed);

    const settled = await c.receive(revalidate);
    expect(settled.messages).toEqual([]);
    expect(c.takeCounts()).toEqual([2, 0]);
  });

  it('undecryptable bodies are delivered so they can be acknowledged', async () => {
    const c = new Conversation(1000);
    const junk = c.add(false, '0.json', 1, 'unused');
    c.server.reply(junk, [{ body: 'not a message' }]);
    c.add(false, '1.json', 5, 'readable');
    const state = new ReceiveState();

    const first = await c.receive(state);
    expect(first.messages.length).toBe(2);
    expect(first.messages[0]!.message!.content).toBe('readable');
    expect(first.messages[1]!.message).toBeNull();
    expect(first.messages[1]!.id.url).toBe(junk);
    acknowledgeAll(state, first);
    c.takeCounts();

    expect((await c.receive(state)).messages).toEqual([]);
    expect(c.takeCounts()).toEqual([0, 0]);
  });

  it('discovery identifies messages without downloading them', async () => {
    const c = new Conversation(1000);
    const mine = c.add(true, 'm.json', 1, 'mine');
    const theirs = c.add(false, 't.json', 2, 'theirs');
    const state = new ReceiveState();

    const discovery = await c.discover(state);
    expect(c.takeCounts()).toEqual([0, 0]);
    expect(discovery.pending.map((p) => p.id)).toEqual([
      { publisher: z32(c.alice), url: mine },
      { publisher: z32(c.bob), url: theirs },
    ]);

    // A caller that already has the first delivered retrieves only the second
    const received = await c.retrieve(discovery.pending.slice(1));
    expect(contents(received)).toEqual(['theirs']);
    expect(c.takeCounts()).toEqual([1, 1]);
  });

  it('a state from another conversation is rejected', async () => {
    const c = new Conversation(1000);
    const carol = keypair(3);
    c.server.add(carol, c.alice, 'c.json', 1, 'from carol');
    const state = new ReceiveState();
    acknowledgeAll(state, await settle(receiveNew(c.ctx, c.conv(carol), state)));

    await expect(settle(discover(c.ctx, c.conv(), state))).rejects.toThrow(/another conversation/);
    expect(state.size).toBe(1);
  });

  it('listed entries outside the conversation are reported without being requested', async () => {
    const c = new Conversation(2);
    const served = [c.add(true, '0000.json', 1, 'mine'), c.add(false, '0001.json', 2, 'theirs')];
    const outside = entriesOutside(c.bob, c.alice).sort();
    c.server.listUnserved(directory(c.bob, c.alice), outside);
    const expected: FetchFailure[] = outside.map(outsideConversation);
    const state = new ReceiveState();

    const first = await c.receive(state);
    expect(contents(first)).toEqual(['mine', 'theirs']);
    expect(first.failures).toEqual(expected);
    expect(first.complete).toBe(true);
    acknowledgeAll(state, first);

    const second = await c.receive(state);
    expect(second.messages).toEqual([]);
    expect(second.failures).toEqual(expected);
    expect(state.size).toBe(2);
    for (const url of outside) {
      expect(c.server.attempts(url)).toBe(served.includes(url) ? 1 : 0);
    }
  });

  it('pending messages outside the conversation are not requested', async () => {
    const c = new Conversation(1000);
    const carol = keypair(3);
    const mine = c.add(true, '0000.json', 1, 'mine');
    const theirs = c.add(false, '0000.json', 2, 'theirs');
    const fromCarol = c.server.add(carol, c.alice, '0000.json', 3, 'carol');
    const pending = (publisher: Keypair, url: string): PendingMessage => ({
      id: { publisher: z32(publisher), url },
      acknowledgedEtag: null,
    });
    const forged = [
      pending(c.bob, mine),
      pending(carol, fromCarol),
      pending(c.bob, 'http://127.0.0.1:9/probe'),
    ];

    const received = await c.retrieve([...forged, pending(c.bob, theirs)]);

    expect(contents(received)).toEqual(['theirs']);
    expect(received.failures).toEqual(forged.map((p) => outsideConversation(p.id.url)));
    expect(c.takeCounts()).toEqual([1, 1]);
  });

  it('request counts match the Rust crate for get, WriteOnce and Revalidate', async () => {
    const rows: Array<[string, number, number]> = [
      ['empty', 0, 0],
      ['unchanged', 150, 0],
      ['growing', 150, 5],
    ];
    const counts: Array<[string, string, [number, number, number], number, number]> = [];
    for (const [name, before, added] of rows) {
      const c = new Conversation(100);
      for (let i = 0; i < before; i++) {
        c.add(true, `a${String(i).padStart(4, '0')}.json`, i, 'mine');
        c.add(false, `b${String(i).padStart(4, '0')}.json`, i, 'theirs');
      }
      const writeOnce = new ReceiveState(ChangePolicy.WriteOnce);
      const revalidate = new ReceiveState(ChangePolicy.Revalidate);
      for (const state of [writeOnce, revalidate]) acknowledgeAll(state, await c.receive(state));
      for (let i = 0; i < added; i++) {
        // Sort before everything already listed
        c.add(true, `0${String(i).padStart(4, '0')}.json`, 1000, 'new mine');
        c.add(false, `0${String(i).padStart(4, '0')}.json`, 1000, 'new theirs');
      }
      const methods: Array<[string, ReceiveState | null]> = [
        ['get_messages', null],
        ['receive, WriteOnce', writeOnce],
        ['receive, Revalidate', revalidate],
      ];
      for (const [method, state] of methods) {
        c.server.resetCounts();
        const start = Date.now();
        const delivered = state
          ? (await c.receive(state)).messages.length
          : (await c.history()).messages.length;
        const elapsed = Date.now() - start;
        const s = c.server.state;
        counts.push([
          name,
          method,
          [s.listingRequests, s.messageRequests, s.bodiesSent],
          delivered,
          elapsed,
        ]);
      }
    }
    expect(counts).toEqual([
      // Two directories that do not exist
      ['empty', 'get_messages', [2, 0, 0], 0, 50],
      ['empty', 'receive, WriteOnce', [2, 0, 0], 0, 50],
      ['empty', 'receive, Revalidate', [2, 0, 0], 0, 50],
      // Pages of 100, 50 and none per directory
      ['unchanged', 'get_messages', [6, 300, 300], 300, 2050],
      ['unchanged', 'receive, WriteOnce', [6, 0, 0], 0, 150],
      ['unchanged', 'receive, Revalidate', [6, 300, 0], 0, 2050],
      ['growing', 'get_messages', [6, 310, 310], 310, 2100],
      ['growing', 'receive, WriteOnce', [6, 10, 10], 10, 250],
      ['growing', 'receive, Revalidate', [6, 310, 10], 10, 2100],
    ]);
  });
});

describe('ReceiveState JSON', () => {
  it('matches the Rust serde shape and round-trips', () => {
    const state = new ReceiveState(ChangePolicy.Revalidate);
    expect(state.toJSON()).toEqual({ change_policy: 'Revalidate', acknowledged: {} });
    expect(JSON.stringify(new ReceiveState())).toBe(
      '{"change_policy":"WriteOnce","acknowledged":{}}',
    );

    const b = 'pubky://b/pub/private_messages/x/2.json';
    const a = 'pubky://b/pub/private_messages/x/1.json';
    state.acknowledge({
      id: { publisher: 'b', url: b },
      message: null,
      etag: '"t2"',
      updated: false,
    });
    state.acknowledge({
      id: { publisher: 'b', url: a },
      message: null,
      etag: null,
      updated: false,
    });
    state.acknowledge({
      id: { publisher: 'a', url: 'u' },
      message: null,
      etag: '"t"',
      updated: false,
    });
    // Keys are sorted like a BTreeMap
    expect(JSON.stringify(state)).toBe(
      `{"change_policy":"Revalidate","acknowledged":{"a":{"u":"\\"t\\""},"b":{"${a}":null,"${b}":"\\"t2\\""}}}`,
    );
    const restored = ReceiveState.fromJSON(JSON.stringify(state));
    expect(restored.equals(state)).toBe(true);
    expect(restored.changePolicy).toBe('Revalidate');
    expect(restored.acknowledgedIds()).toEqual([
      { publisher: 'a', url: 'u' },
      { publisher: 'b', url: a },
      { publisher: 'b', url: b },
    ]);
    expect(restored.lastListingComplete).toBeNull();

    // WriteOnce keeps no tags
    const writeOnce = new ReceiveState();
    writeOnce.acknowledge({
      id: { publisher: 'a', url: 'u' },
      message: null,
      etag: '"t"',
      updated: false,
    });
    expect(writeOnce.toJSON().acknowledged).toEqual({ a: { u: null } });
  });

  it('rejects malformed values', () => {
    for (const bad of [
      null,
      [],
      { change_policy: 'Sometimes', acknowledged: {} },
      { change_policy: 'WriteOnce' },
      { change_policy: 'WriteOnce', acknowledged: { a: { u: 3 } } },
      { change_policy: 'WriteOnce', acknowledged: { a: [] } },
    ]) {
      expect(() => ReceiveState.fromJSON(bad)).toThrow();
    }
  });
});
