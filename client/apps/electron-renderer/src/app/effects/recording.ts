// SPDX-License-Identifier: MIT
import { DocsService } from "@myoxus/core/modules/doc";
import { JournalService } from "@myoxus/core/modules/journal";
import { AudioAttachmentService } from "@myoxus/core/modules/media/services/audio-attachment";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspacesService } from "@myoxus/core/modules/workspace";
import { DebugLogger } from "@myoxus/debug";
import type { RecordingStatus } from "@myoxus/desktop-api-contract";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { I18n, i18nTime } from "@myoxus/i18n";
import type { FrameworkProvider } from "@myoxus/infra";
import type { AttachmentBlockModel } from "@virgultum/editor/model";

const logger = new DebugLogger("electron-renderer:recording");
const bridge = getDesktopBridge();
const apis = bridge?.apis;
const events = bridge?.events;

async function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Recording delivery timed out. The local audio is retained; retry saving it.",
              ),
            ),
          60000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Main grants one delivery owner across windows. Its persisted IDs fence
 * repeated ready events and retries; the stop-time active tab is irrelevant. */
export function setupRecordingEvents(frameworkProvider: FrameworkProvider) {
  const pending = new Set<number>();
  const consume = async (status: RecordingStatus | null) => {
    if (!apis || !status || status.status !== "ready" || pending.has(status.id))
      return;
    if (!status.destination) {
      await apis.recording.handleBlockCreationFailed(status.id, {
        message:
          "No recording destination. Select a workspace and retry saving; the local audio is retained.",
      });
      return;
    }
    pending.add(status.id);
    let claimed: string | null = null;
    let workspaceRef:
      ReturnType<WorkspacesService["openByWorkspaceId"]> | undefined;
    let docRef: ReturnType<DocsService["open"]> = null;
    let retainedForTranscription = false;
    try {
      claimed = await apis.recording.claimRecordingDelivery(status.id);
      if (!claimed) return;
      const target = status.destination;
      const workspaces = frameworkProvider.get(WorkspacesService);
      await workspaces.list.workspaces$.waitFor(
        (list) => list.some((meta) => meta.id === target.workspaceId),
        AbortSignal.timeout(30000),
      );
      workspaceRef = workspaces.openByWorkspaceId(target.workspaceId);
      if (!workspaceRef)
        throw new Error(
          "The original recording workspace is unavailable. The local audio is retained.",
        );
      const { workspace } = workspaceRef;
      const server = workspace.scope.get(WorkspaceServerService).server;
      if (
        target.serverId === null
          ? workspace.flavour !== "local"
          : !server ||
            server.id !== target.serverId ||
            server.baseUrl !== target.serverBaseUrl ||
            !server.account$.value
      ) {
        throw new Error(
          "The original recording server or account is unavailable. Sign in to that server and retry saving.",
        );
      }
      const accountId = server?.account$.value?.id;
      const guard = workspace.scope.get(GuardService);
      const docs = workspace.scope.get(DocsService);
      await docs.list.isReady$.waitFor(Boolean, AbortSignal.timeout(30000));
      const timestamp = i18nTime(status.startTime, {
        absolute: { accuracy: "minute", noYear: true },
      });
      const source =
        status.appName ??
        (environment.isWindows
          ? I18n["com.myoxus.recording.source.microphone-system"]()
          : I18n["com.myoxus.recording.source.system"]());
      let delivery = status.delivery;
      if (!delivery) {
        if (!(await guard.can("Workspace_CreateDoc")))
          throw new Error(
            "You cannot create documents in the original recording workspace.",
          );
        const docId =
          target.savingMode === "journal-today"
            ? workspace.scope
                .get(JournalService)
                .ensureJournalByDate(status.startTime).id
            : `recording-${status.id}`;
        delivery = { docId, attachmentId: `recording-audio-${status.id}` };
        await apis.recording.updateRecordingDelivery(
          status.id,
          delivery,
          claimed,
        );
      }
      let record = docs.list.doc$(delivery.docId).value;
      if (!record) {
        if (target.savingMode === "journal-today")
          throw new Error(
            "The bound journal is unavailable. The local audio is retained.",
          );
        if (!(await guard.can("Workspace_CreateDoc")))
          throw new Error(
            "You cannot create documents in the original recording workspace.",
          );
        record = docs.createDoc({
          id: delivery.docId,
          title: I18n["com.myoxus.recording.document-title"]({
            source,
            timestamp,
          }),
          primaryMode: "page",
        });
      }
      await docs.waitForCreateAcknowledgement(
        record.id,
        AbortSignal.timeout(30000),
      );
      if (!(await guard.can("Doc_Update", record.id)))
        throw new Error(
          "The recording destination is read-only. The local audio is retained.",
        );
      docRef = docs.open(record.id);
      if (!docRef)
        throw new Error("The recording destination could not be opened.");
      await docRef.doc.waitForSyncReady(AbortSignal.timeout(30000));
      const store = docRef.doc.virgultumDoc;
      if (store.readonly)
        throw new Error("The recording destination is read-only.");
      let model = store.getBlock(delivery.attachmentId)?.model as
        AttachmentBlockModel | undefined;
      if (!model) {
        if (!status.filepath?.endsWith(".mp4"))
          throw new Error("The finalized recording file is unavailable.");
        const bytes = await apis.recording.readRecordingFile(status.filepath);
        const blob = new Blob([Uint8Array.from(bytes).buffer], {
          type: "audio/mp4",
        });
        const blobId = await workspace.docCollection.blobSync.set(blob);
        if (delivery.blobId && delivery.blobId !== blobId)
          throw new Error("The original recording content has changed.");
        delivery = { ...delivery, blobId };
        await apis.recording.updateRecordingDelivery(
          status.id,
          delivery,
          claimed,
        );
        if (
          server &&
          !(await withDeadline(workspace.engine.blob.upload(blobId)))
        )
          throw new Error(
            "The recording upload failed. The local audio is retained.",
          );
        // Recheck authority after the asynchronous upload before writing a block.
        if (
          server &&
          (server.account$.value?.id !== accountId ||
            workspace.scope.get(WorkspaceServerService).server !== server)
        )
          throw new Error("The recording account changed while saving.");
        if (!(await guard.can("Doc_Update", record.id)))
          throw new Error("The recording destination is no longer writable.");
        await apis.recording.updateRecordingDelivery(
          status.id,
          delivery,
          claimed,
        );
        const note = store.getBlocksByFlavour("myoxus:note")[0]?.model;
        if (!note) throw new Error("The recording destination has no note.");
        store.addBlock(
          "myoxus:attachment",
          {
            id: delivery.attachmentId,
            name: `${source} ${timestamp}.mp4`,
            type: "audio/mp4",
            size: blob.size,
            sourceId: blobId,
            embed: true,
          },
          note.id,
        );
        model = store.getBlock(delivery.attachmentId)?.model as
          AttachmentBlockModel | undefined;
      }
      if (
        !model ||
        model.flavour !== "myoxus:attachment" ||
        model.props.sourceId !== delivery.blobId
      )
        throw new Error("The recording attachment identity does not match.");
      await withDeadline(
        workspace.engine.doc.waitForSynced(
          record.id,
          AbortSignal.timeout(60000),
        ),
      );
      await apis.recording.handleBlockCreationSuccess(status.id, claimed);
      // Saved is independent of the model job. The shared job consumes the
      // workspace server's STT projection, including when Copilot is disabled.
      if (server) {
        const attachment = workspace.scope
          .get(AudioAttachmentService)
          .get(model);
        if (attachment) {
          retainedForTranscription = true;
          const heldWorkspace = workspaceRef;
          const heldDoc = docRef;
          void attachment.obj
            .transcribe()
            .catch((error) =>
              logger.error("Failed to transcribe recording", error),
            )
            .finally(() => {
              attachment.release();
              heldDoc?.release();
              heldWorkspace?.dispose();
            });
        }
      }
    } catch (error) {
      logger.error("Failed to save recording", error);
      if (claimed)
        await apis.recording.handleBlockCreationFailed(
          status.id,
          {
            message:
              error instanceof Error
                ? error.message
                : "Failed to save recording",
          },
          claimed,
        );
    } finally {
      pending.delete(status.id);
      if (!retainedForTranscription) {
        docRef?.release();
        workspaceRef?.dispose();
      }
    }
  };
  let observedEvent = false;
  const unsubscribe = events?.recording.onRecordingStatusChanged((status) => {
    observedEvent = true;
    void consume(status).catch((error) =>
      logger.error("Recording event failed", error),
    );
  });
  void apis?.recording
    .getCurrentRecording()
    .then((status) => {
      if (!observedEvent) return consume(status);
      return;
    })
    .catch((error) =>
      logger.error("Failed to restore recording delivery", error),
    );
  return unsubscribe;
}
