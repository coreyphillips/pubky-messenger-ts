/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class DiscoveryNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * This node's iroh EndpointId as a string (hex of the 32-byte pubky).
     */
    endpoint_id(): string;
    /**
     * Reach out to a peer by their EndpointId string. Returns a ReadableStream
     * of connect events.
     */
    request_chat(peer_id: string, message: string): ReadableStream;
    /**
     * A ReadableStream of incoming chat requests: `{ fromId, message }`.
     */
    requests(): ReadableStream;
    /**
     * Spawn a node from a 32-byte ed25519 secret key (the pubky secret).
     */
    static spawn(secret_key: Uint8Array): Promise<DiscoveryNode>;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_discoverynode_free: (a: number, b: number) => void;
    readonly discoverynode_endpoint_id: (a: number, b: number) => void;
    readonly discoverynode_request_chat: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly discoverynode_requests: (a: number) => number;
    readonly discoverynode_spawn: (a: number, b: number) => number;
    readonly start: () => void;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: number) => number;
    readonly intounderlyingbytesource_start: (a: number, b: number) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: number) => number;
    readonly intounderlyingsink_close: (a: number) => number;
    readonly intounderlyingsink_write: (a: number, b: number) => number;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: number) => number;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wasm_bindgen_func_elem_14500: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_14516: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_5567: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_2160: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_7183: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_5347: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_6471: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_6500: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_14376: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
