/**
 * Peer discovery demo (Node, over hyperdht).
 *
 * Announce yourself on the DHT under your pubky and listen for chat requests, and
 * optionally knock on a peer to ask them to chat. When a request arrives we follow
 * the requester, so you can immediately DM them with the messaging API even though
 * you did not follow each other before.
 *
 * Run it in two terminals with the bundled test identities (get each pubky from the
 * "Your pubky" line the other side prints):
 *
 *   npm run discover -- --file test/fixtures/p1.pkarr --passphrase password
 *   npm run discover -- --file test/fixtures/p2.pkarr --passphrase password --to <p1-pubky> --message "hi"
 */
import { readFileSync } from 'node:fs';
import { Keypair, PrivateMessengerClient, PublicKey } from '../src/index.js';
import { createNodeDiscovery } from '../src/discovery/index.js';

interface Args {
  file?: string;
  passphrase?: string;
  to?: string;
  message?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '-f':
      case '--file':
        args.file = argv[++i];
        break;
      case '-p':
      case '--passphrase':
        args.passphrase = argv[++i];
        break;
      case '--to':
        args.to = argv[++i];
        break;
      case '--message':
        args.message = argv[++i];
        break;
    }
  }
  return args;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error(
      'Usage: npm run discover -- --file <path.pkarr> [--passphrase <p>] [--to <pubky>] [--message <m>]',
    );
    process.exit(1);
  }

  const keypair = Keypair.fromRecoveryFile(
    new Uint8Array(readFileSync(args.file)),
    args.passphrase ?? '',
  );
  const client = new PrivateMessengerClient(keypair);

  console.log('Your pubky:', keypair.publicKey.z32());
  console.log('Signing in...');
  await client.signIn();

  const discovery = createNodeDiscovery(keypair);
  discovery.onChatRequest(async (request) => {
    const who = request.from.z32();
    console.log(`\n[chat request] from ${who}${request.message ? `: "${request.message}"` : ''}`);
    try {
      await client.putFollow(who);
      console.log(
        `Followed them. You can now DM ${who.slice(0, 8)}... with sendMessage/getMessages.`,
      );
    } catch (e) {
      console.error('Could not follow:', errorText(e));
    }
  });

  await discovery.start();
  console.log('Listening for chat requests on the DHT. Press Ctrl+C to exit.');

  if (args.to) {
    const peer = PublicKey.from(args.to);
    console.log(`Knocking on ${args.to}...`);
    await discovery.requestChat(peer, args.message ?? 'Hi, let us chat on Pubky.');
    console.log('Knock sent.');
  }

  process.on('SIGINT', () => {
    void discovery.destroy().finally(() => process.exit(0));
  });
}

main().catch((e) => {
  console.error('Error:', errorText(e));
  process.exit(1);
});
