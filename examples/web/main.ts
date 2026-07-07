// Browser chat demo for pubky-messenger-ts.
//
// In a real app you would `import { PrivateMessengerClient } from 'pubky-messenger-ts'`.
// Here we import the local source directly so the example builds inside this repo.
import { PrivateMessengerClient, PublicKey, type DecryptedMessage } from '../../src/index.js';

// Public keys of the bundled test identities (test/fixtures/p1.pkarr, p2.pkarr).
const ALICE = 'w5ux3c55ujxq7rpb6x9z9wo554s4eb4zeuh1933b94zk7qsfxd1o';
const BOB = 'ssffc7wiswjzdtt7nw93fa9wy9bus34puyy39giityofcibh9qny';
const POLL_MS = 3000;

function need<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
}

const ui = {
  setup: need('#setup'),
  chat: need('#chat'),
  disconnect: need<HTMLButtonElement>('#disconnect'),
  tabs: Array.from(document.querySelectorAll<HTMLButtonElement>('.tab')),
  panePhrase: need('#pane-phrase'),
  paneFile: need('#pane-file'),
  phrase: need<HTMLTextAreaElement>('#phrase'),
  file: need<HTMLInputElement>('#file'),
  passphrase: need<HTMLInputElement>('#passphrase'),
  peer: need<HTMLInputElement>('#peer'),
  connect: need<HTMLButtonElement>('#connect'),
  demoButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-demo]')),
  me: need('#me'),
  them: need('#them'),
  messages: need('#messages'),
  composer: need<HTMLFormElement>('#composer'),
  text: need<HTMLInputElement>('#text'),
  status: need('#status'),
};

let method: 'phrase' | 'file' = 'phrase';
let fileBytes: Uint8Array | null = null;
let client: PrivateMessengerClient | null = null;
let peer: PublicKey | null = null;
let ownPubky = '';
let messages: DecryptedMessage[] = [];
const seen = new Set<string>();
let pollTimer: number | undefined;

const keyOf = (m: DecryptedMessage): string => `${m.timestamp}:${m.sender}:${m.content}`;
const shorten = (s: string): string => (s.length > 14 ? `${s.slice(0, 8)}...${s.slice(-4)}` : s);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  ui.status.textContent = text;
  ui.status.dataset.kind = kind;
}

// Keep the `method` state and the visible tab/pane in sync so the Connect button
// always uses the input the user can actually see.
function setMethod(next: 'phrase' | 'file'): void {
  method = next;
  ui.tabs.forEach((t) => t.classList.toggle('active', t.dataset.method === next));
  ui.panePhrase.hidden = next !== 'phrase';
  ui.paneFile.hidden = next !== 'file';
}

// --- setup form wiring ---

ui.tabs.forEach((tab) => {
  tab.addEventListener('click', () => setMethod(tab.dataset.method === 'file' ? 'file' : 'phrase'));
});

ui.file.addEventListener('change', async () => {
  const file = ui.file.files?.[0];
  fileBytes = file ? new Uint8Array(await file.arrayBuffer()) : null;
});

ui.connect.addEventListener('click', () => void connect());
ui.disconnect.addEventListener('click', disconnect);
ui.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  void send();
});
ui.demoButtons.forEach((button) => {
  button.addEventListener(
    'click',
    () => void loadDemo(button.dataset.demo === 'bob' ? 'bob' : 'alice'),
  );
});

async function loadDemo(who: 'alice' | 'bob'): Promise<void> {
  try {
    setStatus('Loading demo identity...');
    const fixture = who === 'alice' ? 'p1.pkarr' : 'p2.pkarr';
    const response = await fetch(`./${fixture}`);
    if (!response.ok) throw new Error(`could not load ${fixture}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Build the demo client directly; do not touch the manual form state.
    const demoClient = PrivateMessengerClient.fromRecoveryFile(bytes, 'password');
    const peerKey = PublicKey.from(who === 'alice' ? BOB : ALICE);
    await connectClient(demoClient, peerKey);
  } catch (e) {
    setStatus(`Could not load demo identity: ${errorText(e)}`, 'error');
  }
}

// --- connect / chat ---

async function connect(): Promise<void> {
  ui.connect.disabled = true;
  try {
    setStatus('Deriving your keys...');
    const passphrase = ui.passphrase.value;
    let newClient: PrivateMessengerClient;
    if (method === 'phrase') {
      const phrase = ui.phrase.value.trim();
      if (!phrase) throw new Error('Enter your recovery phrase.');
      newClient = PrivateMessengerClient.fromRecoveryPhrase(phrase, passphrase);
    } else {
      if (!fileBytes) throw new Error('Choose a .pkarr recovery file first.');
      newClient = PrivateMessengerClient.fromRecoveryFile(fileBytes, passphrase);
    }

    const peerValue = ui.peer.value.trim();
    if (!peerValue) throw new Error('Enter a peer public key.');
    await connectClient(newClient, PublicKey.from(peerValue));
  } catch (e) {
    setStatus(errorText(e), 'error');
  } finally {
    ui.connect.disabled = false;
  }
}

// Shared sign-in + switch-to-chat logic for both the demo and the manual form.
async function connectClient(newClient: PrivateMessengerClient, peerKey: PublicKey): Promise<void> {
  setStatus('Signing in to the homeserver...');
  await newClient.signIn(); // throws here on failure; module state stays untouched

  client = newClient;
  peer = peerKey;
  ownPubky = client.publicKeyString();

  ui.me.textContent = shorten(ownPubky);
  ui.me.title = ownPubky;
  ui.them.textContent = shorten(peerKey.z32());
  ui.them.title = peerKey.z32();
  messages = [];
  seen.clear();
  ui.messages.replaceChildren();
  ui.setup.hidden = true;
  ui.chat.hidden = false;
  ui.disconnect.hidden = false;

  setStatus('Loading messages...');
  await refresh();
  startPolling();
  setStatus(`Connected. ${messages.length} message(s) in this conversation.`);
  ui.text.focus();
}

async function refresh(): Promise<void> {
  if (!client || !peer) return;
  merge(await client.getMessages(peer));
}

function merge(incoming: DecryptedMessage[]): void {
  let changed = false;
  for (const m of incoming) {
    const k = keyOf(m);
    if (!seen.has(k)) {
      seen.add(k);
      messages.push(m);
      changed = true;
    }
  }
  if (changed) {
    messages.sort((a, b) => a.timestamp - b.timestamp);
    render();
  }
}

function render(): void {
  const rows = messages.map((m) => {
    const mine = m.sender === ownPubky;

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.content;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = new Date(m.timestamp * 1000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    meta.textContent = mine ? time : `${shorten(m.sender)}  ${time}`;
    if (!m.verified) {
      const warn = document.createElement('span');
      warn.className = 'unverified';
      warn.textContent = ' (unverified)';
      meta.appendChild(warn);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.append(body, meta);

    const row = document.createElement('div');
    row.className = `msg ${mine ? 'mine' : 'theirs'}`;
    row.appendChild(bubble);
    return row;
  });
  ui.messages.replaceChildren(...rows);
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

async function send(): Promise<void> {
  const text = ui.text.value.trim();
  if (!text || !client || !peer) return;
  ui.text.value = '';
  try {
    await client.sendMessage(peer, text);
    // Optimistically show the sent message; the next poll reconciles from the network.
    merge([
      { sender: ownPubky, content: text, timestamp: Math.floor(Date.now() / 1000), verified: true },
    ]);
  } catch (e) {
    ui.text.value = text;
    setStatus(`Send failed: ${errorText(e)}`, 'error');
  }
}

function startPolling(): void {
  stopPolling();
  pollTimer = window.setInterval(() => void refresh(), POLL_MS);
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function disconnect(): void {
  stopPolling();
  client = null;
  peer = null;
  ownPubky = '';
  messages = [];
  seen.clear();
  fileBytes = null;
  ui.messages.replaceChildren();
  // Clear sensitive inputs and reset the form to a known-good default.
  ui.phrase.value = '';
  ui.passphrase.value = '';
  ui.file.value = '';
  setMethod('phrase');
  ui.chat.hidden = true;
  ui.disconnect.hidden = true;
  ui.setup.hidden = false;
  setStatus('Disconnected.');
}
