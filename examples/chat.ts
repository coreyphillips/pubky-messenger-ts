/**
 * Interactive terminal chat. A TypeScript port of the Rust `conversation.rs` example.
 *
 * Load an identity from either a 12-word recovery phrase or a `.pkarr` recovery
 * file (+ passphrase), pick a peer public key, and have a live conversation: it
 * shows recent history, polls for new messages every few seconds, and sends what
 * you type.
 *
 * Run it:
 *   npm run chat
 *   npm run chat -- --file ./alice.pkarr --peer pk:<their-pubky>
 *   npm run chat -- --phrase "abandon abandon ... about" --peer <z32-pubky>
 *
 * Flags (anything omitted is prompted for interactively):
 *   -f, --file <path>          Path to a .pkarr recovery file
 *   -m, --phrase "<words>"     12-word BIP39 recovery phrase
 *   -p, --passphrase <secret>  Recovery-file password / BIP39 passphrase
 *       --peer <pubky>         Peer public key (pk:... / pubky://... / z32); also accepted positionally
 *   -h, --help                 Show usage
 */
import { readFileSync } from 'node:fs';
import * as readline from 'node:readline';
import { PrivateMessengerClient, PublicKey, type DecryptedMessage } from '../src/index.js';

const POLL_INTERVAL_MS = 3000;

interface Args {
  file?: string;
  phrase?: string;
  passphrase?: string;
  peer?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-f':
      case '--file':
        args.file = argv[++i];
        break;
      case '-m':
      case '--phrase':
      case '--mnemonic':
        args.phrase = argv[++i];
        break;
      case '-p':
      case '--passphrase':
      case '--password':
        args.passphrase = argv[++i];
        break;
      case '--peer':
        args.peer = argv[++i];
        break;
      default:
        if (arg && !arg.startsWith('-')) positional.push(arg);
    }
  }
  if (!args.peer && positional.length > 0) args.peer = positional[positional.length - 1];
  return args;
}

const USAGE = `Usage: npm run chat -- [options]

Options:
  -f, --file <path>          Path to a .pkarr recovery file
  -m, --phrase "<words>"     12-word BIP39 recovery phrase
  -p, --passphrase <secret>  Recovery-file password / BIP39 passphrase
      --peer <pubky>         Peer public key (pk:... / pubky://... / z32)
  -h, --help                 Show this help

If --file/--phrase, --passphrase, or --peer are omitted, you'll be prompted.`;

/** Ask a question and return the typed answer. */
function prompt(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Ask a question without echoing the typed answer (for secrets). */
function promptHidden(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const iface = rl as unknown as {
    muted: boolean;
    output: NodeJS.WriteStream;
    _writeToOutput: (s: string) => void;
  };
  iface._writeToOutput = (stringToWrite: string) => {
    if (!iface.muted) iface.output.write(stringToWrite);
  };
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    iface.muted = true; // Query is already written; mute subsequent keystrokes.
  });
}

/** Stable de-dup key for a message (timestamp + sender + content). */
function messageKey(m: DecryptedMessage): string {
  return `${m.timestamp}:${m.sender}:${m.content}`;
}

function display(m: DecryptedMessage, ownPubky: string): void {
  const time = new Date(m.timestamp * 1000).toLocaleTimeString('en-GB', { hour12: false });
  if (m.sender === ownPubky) {
    console.log(`[${time}] You: ${m.content}`);
  } else {
    const short = m.sender.length > 16 ? `${m.sender.slice(0, 16)}...` : m.sender;
    const flag = m.verified ? '' : ' (unverified)';
    console.log(`[${time}] ${short}: ${m.content}${flag}`);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function resolveClient(args: Args, interactive: boolean): Promise<PrivateMessengerClient> {
  if (args.phrase) {
    return PrivateMessengerClient.fromRecoveryPhrase(args.phrase, args.passphrase ?? '');
  }
  if (args.file) {
    const passphrase = args.passphrase ?? (await promptHidden('Enter passphrase: '));
    return PrivateMessengerClient.fromRecoveryFile(
      new Uint8Array(readFileSync(args.file)),
      passphrase,
    );
  }
  if (!interactive) {
    throw new Error('Non-interactive mode requires --file or --phrase (and --passphrase, --peer).');
  }
  const method = (
    await prompt('Load identity from (1) recovery phrase or (2) .pkarr file? [1/2]: ')
  ).trim();
  if (method === '1') {
    const phrase = (await prompt('Enter your 12-word recovery phrase: ')).trim();
    const passphrase = await promptHidden('BIP39 passphrase (leave blank if none): ');
    return PrivateMessengerClient.fromRecoveryPhrase(phrase, passphrase);
  }
  const path = (await prompt('Path to .pkarr recovery file: ')).trim();
  const passphrase = await promptHidden('Enter passphrase: ');
  return PrivateMessengerClient.fromRecoveryFile(new Uint8Array(readFileSync(path)), passphrase);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const interactive = Boolean(process.stdin.isTTY);

  const client = await resolveClient(args, interactive);

  let peerStr = args.peer;
  if (!peerStr) {
    if (!interactive) throw new Error('Missing --peer.');
    peerStr = (await prompt('Peer public key (pk:... / pubky://... / z32): ')).trim();
  }
  const peer = PublicKey.from(peerStr);

  const ownPubky = client.publicKeyString();
  console.log(`\nYour public key: ${ownPubky}`);
  console.log('Signing in to Pubky...');
  await client.signIn();
  console.log('Signed in.');

  const initial = await client.getMessages(peer);
  const seen = new Set(initial.map(messageKey));

  if (interactive) process.stdout.write('\x1B[2J\x1B[1;1H'); // clear screen
  console.log(`=== Conversation with ${peerStr} ===`);
  console.log('Type a message and press Enter to send. Press Ctrl+C to exit.\n');
  for (const m of initial.slice(-10)) display(m, ownPubky);
  console.log(`\n${'-'.repeat(72)}`);

  if (!interactive) {
    console.log('(no interactive terminal detected, printed recent history and exiting)');
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (input.length > 0) {
      try {
        await client.sendMessage(peer, input);
        const local: DecryptedMessage = {
          sender: ownPubky,
          content: input,
          timestamp: Math.floor(Date.now() / 1000),
          verified: true,
        };
        seen.add(messageKey(local));
        readline.moveCursor(process.stdout, 0, -1); // overwrite the echoed input line
        readline.clearLine(process.stdout, 0);
        display(local, ownPubky);
      } catch (e) {
        console.error(`\nError sending message: ${errorMessage(e)}`);
      }
    }
    rl.prompt();
  });

  const poll = setInterval(async () => {
    try {
      const messages = await client.getMessages(peer);
      const fresh = messages.filter((m) => !seen.has(messageKey(m)));
      for (const m of fresh) seen.add(messageKey(m));
      const fromPeer = fresh.filter((m) => m.sender !== ownPubky);
      if (fromPeer.length > 0) {
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        for (const m of fromPeer) display(m, ownPubky);
        rl.prompt(true); // restore the prompt and any in-progress input
      }
    } catch {
      // Ignore transient polling errors.
    }
  }, POLL_INTERVAL_MS);

  rl.on('SIGINT', () => rl.close());
  rl.on('close', () => {
    clearInterval(poll);
    console.log('\nBye.');
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(`Error: ${errorMessage(e)}`);
  process.exit(1);
});
