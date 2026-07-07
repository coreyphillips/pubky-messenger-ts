import { PublicKey } from '@synonymdev/pubky';
import type { Keypair } from '@synonymdev/pubky';
import type { DiscoveryPeer, DiscoveryTransport } from './types.js';

/** An inbound request from a peer who wants to start a conversation. */
export interface ChatRequest {
  /** The peer who is reaching out (identity-authenticated by the transport). */
  from: PublicKey;
  /** An optional introduction message. */
  message?: string;
}

const PROTOCOL = 'pubky-messenger/discovery/1';

interface Frame {
  protocol: string;
  type: string;
  pubky: string;
  message?: string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Bridges a {@link DiscoveryTransport} to chat-request events for the messenger.
 *
 * A peer calls {@link start} to listen for inbound requests, and
 * {@link requestChat} to reach out to someone by their pubky. Because the
 * transport authenticates both identities, an incoming request's `from` is
 * verified against the transport-authenticated remote key (a peer cannot claim a
 * pubky it does not control).
 */
export class DiscoveryService {
  private readonly transport: DiscoveryTransport;
  private readonly ownPubky: string;
  private handler: ((request: ChatRequest) => void) | null = null;

  constructor(keypair: Keypair, transport: DiscoveryTransport) {
    this.ownPubky = keypair.publicKey.z32();
    this.transport = transport;
  }

  /** Start listening for inbound chat requests. */
  async start(): Promise<void> {
    await this.transport.listen((peer) => this.onIncoming(peer));
  }

  /** Register a handler for inbound chat requests. */
  onChatRequest(handler: (request: ChatRequest) => void): void {
    this.handler = handler;
  }

  /** Reach out to a peer (by pubky) to request a chat. */
  async requestChat(peer: PublicKey, message?: string): Promise<void> {
    const conn = await this.transport.connect(peer.toUint8Array());
    const frame: Frame = { protocol: PROTOCOL, type: 'chat-request', pubky: this.ownPubky };
    if (message !== undefined) frame.message = message;
    conn.send(new TextEncoder().encode(JSON.stringify(frame)));
    // Let the frame flush before closing.
    await new Promise((resolve) => setTimeout(resolve, 300));
    conn.close();
  }

  async destroy(): Promise<void> {
    await this.transport.destroy();
  }

  private onIncoming(peer: DiscoveryPeer): void {
    peer.onMessage((data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(new TextDecoder().decode(data)) as Frame;
      } catch {
        peer.close();
        return;
      }
      if (frame.protocol !== PROTOCOL || frame.type !== 'chat-request') {
        peer.close();
        return;
      }
      let from: PublicKey;
      try {
        from = PublicKey.from(frame.pubky);
      } catch {
        peer.close();
        return;
      }
      // Reject any claim that does not match the transport-authenticated identity.
      if (!bytesEqual(from.toUint8Array(), peer.remotePublicKey)) {
        peer.close();
        return;
      }
      this.handler?.({ from, message: frame.message });
      peer.close();
    });
  }
}
