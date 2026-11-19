import type { ConversationSide } from './conversation.js';
import {
  Requests,
  describeFetchFailure,
  isMessageUrl,
  messageUrls,
  type EngineContext,
  type FetchFailure,
} from './engine.js';

/**
 * Selected deletion and conversation clearing. Ported from `pubky-messenger` `src/clear.rs`.
 */

/** Results of deleting selected messages or clearing the sender's conversation directory. */
export interface MessageDeletion {
  /** Message URLs successfully deleted or already absent, in input or listing order. */
  deleted: string[];
  /** Listings or messages that could not be deleted under the configured request policy. */
  failures: FetchFailure[];
}

/** Throw if `deletion` has failures, after every deletion was attempted. */
export function deletionResult(deletion: MessageDeletion): void {
  const first = deletion.failures[0];
  if (first) {
    throw new Error(
      `Failed to delete ${deletion.failures.length} listing(s) or message(s), including ${describeFetchFailure(first)}`,
    );
  }
}

/**
 * The URLs of message `ids` in `directory`, validating every ID before any request: an ID must
 * be nonempty, consist only of ASCII letters, digits, `-`, `.`, `_` or `~`, and not be `.` or `..`.
 */
export function messageIdUrls(directory: string, ids: readonly string[]): string[] {
  return ids.map((id) => {
    if (typeof id !== 'string' || !isMessageUrl(directory, `${directory}${id}`)) {
      throw new Error('Invalid message ID: expected a nonempty file name');
    }
    return `${directory}${id}.json`;
  });
}

/** Delete only the messages selected by the caller from the sender's own directory. */
export async function deleteMessages(
  ctx: EngineContext,
  own: ConversationSide,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<MessageDeletion> {
  const urls = messageIdUrls(own.directory, ids);
  return deleteUrls(new Requests(ctx, { cleanup: true, signal }), urls);
}

/** Delete every message the sender has stored in its copy of the conversation. */
export async function clearMessages(
  ctx: EngineContext,
  own: ConversationSide,
  signal?: AbortSignal,
): Promise<MessageDeletion> {
  const requests = new Requests(ctx, { cleanup: true, signal });
  const listing = await requests.list(own.directory);
  if (!listing.ok) return { deleted: [], failures: [listing.failure] };
  const { urls, outside } = messageUrls(own.directory, listing.value ?? []);
  const deletion = await deleteUrls(requests, urls);
  return { deleted: deletion.deleted, failures: [...outside, ...deletion.failures] };
}

async function deleteUrls(requests: Requests, urls: string[]): Promise<MessageDeletion> {
  const unique = [...new Set(urls)];
  const results = await Promise.all(unique.map((url) => requests.delete(url)));
  const deletion: MessageDeletion = { deleted: [], failures: [] };
  unique.forEach((url, i) => {
    const result = results[i]!;
    if (result.ok) deletion.deleted.push(url);
    else deletion.failures.push(result.failure);
  });
  return deletion;
}
