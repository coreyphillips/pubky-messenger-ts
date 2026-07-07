/**
 * Transport-agnostic peer discovery.
 *
 * A `DiscoveryTransport` rendezvouses peers by their pubky and yields a live,
 * identity-authenticated connection. The messaging layer stays independent of how
 * peers actually find each other (hyperdht, a relay, etc.).
 */

/** A live, identity-authenticated connection to a peer. */
export interface DiscoveryPeer {
  /** The authenticated 32-byte remote identity (equals the peer's pubky bytes). */
  readonly remotePublicKey: Uint8Array;
  /** Send raw bytes to the peer. */
  send(data: Uint8Array): void;
  /** Register a handler for incoming bytes. */
  onMessage(handler: (data: Uint8Array) => void): void;
  /** Close the connection. */
  close(): void;
}

/** A transport that can rendezvous peers by their pubky. */
export interface DiscoveryTransport {
  /** Listen for inbound connections addressed to our identity. */
  listen(onPeer: (peer: DiscoveryPeer) => void): Promise<void>;
  /** Connect to a peer by their 32-byte public key. Resolves once authenticated. */
  connect(peerPublicKey: Uint8Array): Promise<DiscoveryPeer>;
  /** Tear down the transport. */
  destroy(): Promise<void>;
}
