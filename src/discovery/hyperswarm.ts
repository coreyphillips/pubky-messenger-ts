import DHT from 'hyperdht';
import type { DhtKeyPair, DhtServer, DhtSocket } from 'hyperdht';
import type { Keypair } from '@synonymdev/pubky';
import type { DiscoveryPeer, DiscoveryTransport } from './types.js';

/**
 * Node.js discovery transport over hyperdht.
 *
 * The pubky's Ed25519 keypair is used directly as the hyperdht keypair, so a peer
 * is reachable at its own pubky and hyperdht's Noise handshake authenticates both
 * identities. Requires the optional `hyperdht` dependency and does not run in the
 * browser (browsers need a DHT relay).
 */
export class HyperswarmTransport implements DiscoveryTransport {
  private readonly keyPair: DhtKeyPair;
  private node: DHT | null = null;
  private server: DhtServer | null = null;

  constructor(keypair: Keypair) {
    this.keyPair = DHT.keyPair(new Uint8Array(keypair.secret()));
  }

  private dht(): DHT {
    if (!this.node) {
      this.node = new DHT();
    }
    return this.node;
  }

  async listen(onPeer: (peer: DiscoveryPeer) => void): Promise<void> {
    this.server = this.dht().createServer((socket) => onPeer(wrap(socket)));
    await this.server.listen(this.keyPair);
  }

  async connect(peerPublicKey: Uint8Array): Promise<DiscoveryPeer> {
    const socket = this.dht().connect(peerPublicKey, { keyPair: this.keyPair });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (e) =>
        reject(e instanceof Error ? e : new Error('discovery connection failed')),
      );
    });
    return wrap(socket);
  }

  async destroy(): Promise<void> {
    try {
      if (this.server) await this.server.close();
    } catch {
      /* ignore teardown errors */
    }
    try {
      if (this.node) await this.node.destroy();
    } catch {
      /* ignore teardown errors */
    }
  }
}

function wrap(socket: DhtSocket): DiscoveryPeer {
  // Always attach an error handler so a reset during teardown does not throw.
  socket.on('error', () => {});
  return {
    remotePublicKey: new Uint8Array(socket.remotePublicKey),
    send: (data) => socket.write(data),
    onMessage: (handler) => socket.on('data', (d) => handler(new Uint8Array(d))),
    close: () => socket.destroy(),
  };
}
