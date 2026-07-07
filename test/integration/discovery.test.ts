import { describe, it, expect } from 'vitest';
import { Keypair } from '../../src/index';
import { DiscoveryService, HyperswarmTransport, type ChatRequest } from '../../src/discovery/index';

// Hits the real hyperdht network; skipped unless PUBKY_MESSENGER_LIVE is set.
const LIVE = Boolean(process.env.PUBKY_MESSENGER_LIVE);
const suite = LIVE ? describe : describe.skip;

suite('discovery over hyperdht (real network)', () => {
  it('a peer can knock by pubky and is identity-authenticated', async () => {
    const alice = Keypair.random();
    const bob = Keypair.random();

    const bobDiscovery = new DiscoveryService(bob, new HyperswarmTransport(bob));
    const aliceDiscovery = new DiscoveryService(alice, new HyperswarmTransport(alice));

    try {
      const received = new Promise<ChatRequest>((resolve) => bobDiscovery.onChatRequest(resolve));
      await bobDiscovery.start();

      await aliceDiscovery.requestChat(bob.publicKey, 'hi from alice');

      const request = await Promise.race([
        received,
        new Promise<ChatRequest>((_, reject) =>
          setTimeout(() => reject(new Error('timed out waiting for chat request')), 45_000),
        ),
      ]);

      // The request's identity is the transport-authenticated pubky, not a claim.
      expect(request.from.z32()).toBe(alice.publicKey.z32());
      expect(request.message).toBe('hi from alice');
    } finally {
      await aliceDiscovery.destroy();
      await bobDiscovery.destroy();
    }
  }, 60_000);
});
