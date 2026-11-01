// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ChatMessage,
  type HistoryMessage,
  isChatMessage,
} from "../components/ai-chat-messages/type";

/** Correlate optimistic UI identity with stored targets. The server still owns
 * last-turn authorization and the atomic expected-generation comparison.
 */
export function resolveRetryTarget(
  previous: readonly HistoryMessage[],
  stored: readonly ChatMessage[],
) {
  const last = previous.at(-1);
  const localUser = previous
    .slice(0, -1)
    .findLast((message) => isChatMessage(message) && message.role === "user");
  if (
    !last ||
    !isChatMessage(last) ||
    last.role !== "assistant" ||
    !localUser ||
    !isChatMessage(localUser)
  )
    throw new Error("The original user turn is unavailable");
  const user = stored.findLast((message) => message.role === "user");
  const response =
    stored.at(-1)?.role === "assistant" ? stored.at(-1) : undefined;
  const sameUser =
    user &&
    ((localUser.id && user.id === localUser.id) ||
      (localUser.params?.inputRequestId &&
        user.params?.inputRequestId === localUser.params.inputRequestId));
  const knownStreamId =
    typeof last.params?.streamId === "string"
      ? last.params.streamId
      : undefined;
  const pendingRequestId =
    typeof last.params?.requestId === "string"
      ? last.params.requestId
      : undefined;
  if (
    !sameUser ||
    !user ||
    (last.id && last.id !== response?.id) ||
    (response &&
      !knownStreamId &&
      pendingRequestId &&
      pendingRequestId !== response.params?.requestId)
  )
    throw new Error("The last chat turn changed; reload before retrying");
  const expectedStreamId =
    knownStreamId ||
    (typeof response?.params?.streamId === "string"
      ? response.params.streamId
      : undefined);
  return { user, response, expectedStreamId };
}
