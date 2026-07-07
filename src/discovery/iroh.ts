import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { PublicKey } from '@synonymdev/pubky';
import type { Keypair } from '@synonymdev/pubky';
import { zbase32Encode } from './zbase32.js';
// The committed wasm-bindgen output (built from the iroh-discovery Rust crate).
// Default export is the wasm init function; DiscoveryNode is the wrapper.
import initWasm, { DiscoveryNode } from './iroh-wasm/iroh_discovery.js';
import type { ChatRequest } from './service.js';

/**
 * Browser (and Node) peer discovery over iroh.
 *
 * A pubky is an ed25519 keypair and so is an iroh endpoint, so the node listens on
 * the DHT/relay network under its own pubky. iroh discovers peers via pkarr and
 * relays through n0's public relay servers, so this works in the browser with no
 * server of our own. iroh's EndpointId is the hex of the pubky's 32 bytes.
 *
 * Presents the same surface as the Node `DiscoveryService`, so the app can treat
 * both uniformly.
 */
export class IrohDiscovery {
  private readonly secret: Uint8Array;
  private node: DiscoveryNode | null = null;
  private handler: ((request: ChatRequest) => void) | null = null;
  private running = false;

  constructor(keypair: Keypair) {
    this.secret = keypair.secret();
  }

  /** Spawn the iroh endpoint and start listening for chat requests. */
  async start(): Promise<void> {
    await initWasm();
    this.node = await DiscoveryNode.spawn(this.secret);
    this.running = true;
    void this.consumeRequests();
  }

  onChatRequest(handler: (request: ChatRequest) => void): void {
    this.handler = handler;
  }

  /** Reach out to a peer (by pubky) to request a chat. */
  async requestChat(peer: PublicKey, message = ''): Promise<void> {
    if (!this.node) throw new Error('Discovery not started. Call start() first.');
    const peerId = bytesToHex(peer.toUint8Array()); // iroh EndpointId == hex(pubky bytes)
    const stream = this.node.request_chat(peerId, message);
    await drain(stream, (event: { type?: string; error?: string }) => {
      if (event.type === 'closed' && event.error) {
        throw new Error(`chat request failed: ${event.error}`);
      }
    });
  }

  destroy(): void {
    this.running = false;
    this.node = null;
  }

  private async consumeRequests(): Promise<void> {
    if (!this.node) return;
    const stream = this.node.requests();
    await drain(stream, (req: { fromId: string; message: string }) => {
      if (!this.running) return;
      const from = PublicKey.from(zbase32Encode(hexToBytes(req.fromId)));
      this.handler?.({ from, message: req.message });
    });
  }
}

async function drain<T>(stream: ReadableStream<T>, onValue: (value: T) => void): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) onValue(value);
    }
  } finally {
    reader.releaseLock();
  }
}
