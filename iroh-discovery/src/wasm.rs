use anyhow::{Context, Result};
use n0_future::{Stream, StreamExt};
use serde::Serialize;
use tracing::level_filters::LevelFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::{JsError, prelude::wasm_bindgen};
use wasm_streams::{ReadableStream, readable::sys::ReadableStream as JsReadableStream};

use crate::node;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
    tracing_subscriber::fmt()
        .with_max_level(LevelFilter::WARN)
        .with_writer(MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG))
        .without_time()
        .with_ansi(false)
        .init();
}

#[wasm_bindgen]
pub struct DiscoveryNode(node::DiscoveryNode);

#[wasm_bindgen]
impl DiscoveryNode {
    /// Spawn a node from a 32-byte ed25519 secret key (the pubky secret).
    pub async fn spawn(secret_key: Vec<u8>) -> Result<DiscoveryNode, JsError> {
        let sk: [u8; 32] = secret_key
            .try_into()
            .map_err(|_| JsError::new("secret key must be 32 bytes"))?;
        Ok(Self(node::DiscoveryNode::spawn(sk).await.map_err(to_js_err)?))
    }

    /// This node's iroh EndpointId as a string (hex of the 32-byte pubky).
    pub fn endpoint_id(&self) -> String {
        self.0.endpoint().id().to_string()
    }

    /// A ReadableStream of incoming chat requests: `{ fromId, message }`.
    pub fn requests(&self) -> JsReadableStream {
        into_js_readable_stream(self.0.requests())
    }

    /// Reach out to a peer by their EndpointId string. Returns a ReadableStream
    /// of connect events.
    pub fn request_chat(
        &self,
        peer_id: String,
        message: String,
    ) -> Result<JsReadableStream, JsError> {
        let peer = peer_id
            .parse()
            .context("failed to parse endpoint id")
            .map_err(to_js_err)?;
        Ok(into_js_readable_stream(self.0.request_chat(peer, message)))
    }
}

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&err.to_string())
}

fn into_js_readable_stream<T: Serialize>(
    stream: impl Stream<Item = T> + 'static,
) -> wasm_streams::readable::sys::ReadableStream {
    let stream = stream.map(|event| Ok(serde_wasm_bindgen::to_value(&event).unwrap()));
    ReadableStream::from_stream(stream).into_raw()
}
