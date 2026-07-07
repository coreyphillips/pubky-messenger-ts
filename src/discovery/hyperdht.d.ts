// Minimal ambient types for `hyperdht` (the package ships no TypeScript types).
// We only declare the small surface this library uses.
declare module 'hyperdht' {
  export interface DhtKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  export interface DhtSocket {
    remotePublicKey: Uint8Array;
    write(data: Uint8Array): void;
    on(event: 'data', handler: (data: Uint8Array) => void): void;
    on(event: 'error' | 'close' | 'open', handler: (arg?: unknown) => void): void;
    once(event: 'open' | 'error' | 'close', handler: (arg?: unknown) => void): void;
    destroy(): void;
  }

  export interface DhtServer {
    listen(keyPair: DhtKeyPair): Promise<void>;
    close(): Promise<void>;
  }

  export default class DHT {
    static keyPair(seed?: Uint8Array): DhtKeyPair;
    constructor(opts?: Record<string, unknown>);
    createServer(onconnection: (socket: DhtSocket) => void): DhtServer;
    connect(remotePublicKey: Uint8Array, opts?: { keyPair?: DhtKeyPair }): DhtSocket;
    destroy(): Promise<void>;
  }
}
