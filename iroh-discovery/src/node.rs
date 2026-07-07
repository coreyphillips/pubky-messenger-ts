use anyhow::Result;
use async_channel::Sender;
use iroh::{
    Endpoint, EndpointId, SecretKey,
    endpoint::Connection,
    protocol::{AcceptError, ProtocolHandler, Router},
};
use n0_future::{Stream, StreamExt, boxed::BoxStream, task};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tracing::info;

/// ALPN for the pubky-messenger discovery / chat-request protocol.
pub const ALPN: &[u8] = b"pubky-messenger/discovery/1";

#[derive(Debug, Clone)]
pub struct DiscoveryNode {
    router: Router,
    requests: broadcast::Sender<ChatRequest>,
}

impl DiscoveryNode {
    /// Spawn a discovery node whose iroh identity is the given ed25519 secret key
    /// (the pubky secret), so the node is reachable at its own pubky.
    pub async fn spawn(secret_key: [u8; 32]) -> Result<Self> {
        let secret = SecretKey::from_bytes(&secret_key);
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await?;
        let (requests, _rx) = broadcast::channel(128);
        let handler = RequestHandler {
            requests: requests.clone(),
        };
        let router = Router::builder(endpoint).accept(ALPN, handler).spawn();
        Ok(Self { router, requests })
    }

    pub fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    /// Stream of incoming chat requests.
    pub fn requests(&self) -> BoxStream<ChatRequest> {
        let rx = self.requests.subscribe();
        Box::pin(BroadcastStream::new(rx).filter_map(|event| event.ok()))
    }

    /// Reach out to a peer (by iroh EndpointId == pubky) to request a chat.
    pub fn request_chat(
        &self,
        peer: EndpointId,
        message: String,
    ) -> impl Stream<Item = ConnectEvent> + Unpin + use<> {
        let (tx, rx) = async_channel::bounded(16);
        let endpoint = self.router.endpoint().clone();
        task::spawn(async move {
            let res = request_chat(&endpoint, peer, message, tx.clone()).await;
            let error = res.as_ref().err().map(|err| err.to_string());
            tx.send(ConnectEvent::Closed { error }).await.ok();
        });
        Box::pin(rx)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConnectEvent {
    Connected,
    Sent,
    Closed { error: Option<String> },
}

/// An incoming chat request. `from_id` is the transport-authenticated remote
/// EndpointId (the peer's pubky), serialized as its iroh string form.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    #[serde(rename = "fromId")]
    pub from_id: String,
    pub message: String,
}

#[derive(Debug, Clone)]
struct RequestHandler {
    requests: broadcast::Sender<ChatRequest>,
}

impl RequestHandler {
    async fn handle(self, connection: Connection) -> std::result::Result<(), AcceptError> {
        let from_id = connection.remote_id();
        info!("chat request from {from_id}");
        let (mut send, mut recv) = connection.accept_bi().await?;
        let bytes = recv
            .read_to_end(64 * 1024)
            .await
            .map_err(AcceptError::from_err)?;
        let message = String::from_utf8_lossy(&bytes).to_string();
        send.finish()?;
        self.requests
            .send(ChatRequest {
                from_id: from_id.to_string(),
                message,
            })
            .ok();
        connection.closed().await;
        Ok(())
    }
}

impl ProtocolHandler for RequestHandler {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        self.clone().handle(connection).await
    }
}

async fn request_chat(
    endpoint: &Endpoint,
    peer: EndpointId,
    message: String,
    tx: Sender<ConnectEvent>,
) -> Result<()> {
    let connection = endpoint.connect(peer, ALPN).await?;
    tx.send(ConnectEvent::Connected).await?;
    let (mut send, mut recv) = connection.open_bi().await?;
    send.write_all(message.as_bytes()).await?;
    send.finish()?;
    tx.send(ConnectEvent::Sent).await?;
    // Wait for the recipient to read and close.
    let _ = recv.read_to_end(0).await;
    connection.close(0u8.into(), b"done");
    Ok(())
}
