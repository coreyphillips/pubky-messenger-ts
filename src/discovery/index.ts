/**
 * Peer discovery for pubky-messenger-ts (optional, Node.js).
 *
 * Lets two people start a conversation without following each other first: a peer
 * listens on the DHT under its own pubky, and anyone who knows that pubky can knock
 * and introduce themselves over an identity-authenticated channel.
 *
 * Import from `pubky-messenger-ts/discovery`. Requires the optional `hyperdht`
 * dependency. This entry is Node-only; the browser needs a DHT relay (planned).
 */
import type { Keypair } from '@synonymdev/pubky';
import { DiscoveryService } from './service.js';
import { HyperswarmTransport } from './hyperswarm.js';

export { DiscoveryService } from './service.js';
export type { ChatRequest } from './service.js';
export { HyperswarmTransport } from './hyperswarm.js';
export type { DiscoveryTransport, DiscoveryPeer } from './types.js';

/** Convenience: a {@link DiscoveryService} backed by the Node hyperdht transport. */
export function createNodeDiscovery(keypair: Keypair): DiscoveryService {
  return new DiscoveryService(keypair, new HyperswarmTransport(keypair));
}
