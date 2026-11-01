/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { EditorHost } from "@virgultum/editor/std";

export type MessageAttachment = string | Blob | File;

export type AttachmentPersister = (attachment: Blob | File) => Promise<string>;

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("AI message attachment upload was aborted");
  }
}

/** Return the durable key only after the current workspace peer acknowledges
 * upload. Stop may outlive noncancelable BlobSync I/O, but not admit its result
 * into a later message. No filename or image payload enters diagnostics.
 */
export async function persistAttachmentWithBlobSync(
  blobSync: EditorHost["store"]["blobSync"],
  attachment: Blob | File,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const blobId = await blobSync.set(attachment);

  throwIfAborted(signal);
  const uploaded = await blobSync.upload(blobId);
  if (uploaded !== true) {
    throw new Error(
      `AI message attachment ${blobId} was stored locally but could not be uploaded to the workspace blob peer`,
    );
  }

  throwIfAborted(signal);
  return blobId;
}

export async function resolveCreateMessageAttachments({
  attachments,
  host,
  persistAttachment,
  signal,
}: {
  attachments?: MessageAttachment[];
  host?: EditorHost;
  persistAttachment?: AttachmentPersister;
  signal?: AbortSignal;
}) {
  if (!attachments?.length) {
    return undefined;
  }

  const resolvedAttachments: string[] = [];
  for (const attachment of attachments) {
    throwIfAborted(signal);
    if (typeof attachment === "string") {
      resolvedAttachments.push(attachment);
      continue;
    }

    const blobId = persistAttachment
      ? await persistAttachment(attachment)
      : host
        ? await persistAttachmentWithBlobSync(
            host.store.blobSync,
            attachment,
            signal,
          )
        : null;

    throwIfAborted(signal);
    if (!blobId) {
      throw new Error(
        "AI message file attachments require an editor host or an explicit attachment persister before createMessage",
      );
    }
    resolvedAttachments.push(blobId);
  }

  return resolvedAttachments;
}
