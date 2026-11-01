// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecordingStatus } from "@myoxus/desktop-api-contract";
import type { FrameworkProvider } from "@myoxus/infra";
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  Docs: class {},
  Journal: class {},
  Audio: class {},
  Guard: class {},
  Server: class {},
  Workspaces: class {},
  listener: undefined as ((status: RecordingStatus | null) => void) | undefined,
  recording: {
    getCurrentRecording: vi.fn(),
    claimRecordingDelivery: vi.fn(),
    updateRecordingDelivery: vi.fn(),
    readRecordingFile: vi.fn(),
    handleBlockCreationSuccess: vi.fn(),
    handleBlockCreationFailed: vi.fn(),
  },
}));
vi.mock("@myoxus/i18n", () => ({
  i18nTime: () => "captured date",
  I18n: {
    "com.myoxus.recording.source.system": () => "System audio",
    "com.myoxus.recording.document-title": ({
      source,
      timestamp,
    }: {
      source: string;
      timestamp: string;
    }) => `Recording ${source} ${timestamp}`,
  },
}));
vi.mock("@myoxus/core/modules/doc", () => ({ DocsService: h.Docs }));
vi.mock("@myoxus/core/modules/journal", () => ({ JournalService: h.Journal }));
vi.mock("@myoxus/core/modules/media/services/audio-attachment", () => ({
  AudioAttachmentService: h.Audio,
}));
vi.mock("@myoxus/core/modules/permissions", () => ({ GuardService: h.Guard }));
vi.mock("@myoxus/core/modules/server", () => ({
  WorkspaceServerService: h.Server,
}));
vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspacesService: h.Workspaces,
}));
vi.mock("@myoxus/desktop-api-contract/bridge", () => ({
  getDesktopBridge: () => ({
    apis: { recording: h.recording },
    events: {
      recording: {
        onRecordingStatusChanged: (listener: typeof h.listener) => {
          h.listener = listener;
          return () => {
            h.listener = undefined;
          };
        },
      },
    },
  }),
}));
import { setupRecordingEvents } from "./recording";

beforeEach(() => {
  vi.clearAllMocks();
  h.recording.getCurrentRecording.mockResolvedValue(null);
  h.recording.claimRecordingDelivery.mockResolvedValue("claim");
  h.recording.updateRecordingDelivery.mockResolvedValue(undefined);
  h.recording.readRecordingFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
  h.recording.handleBlockCreationSuccess.mockResolvedValue(undefined);
  h.recording.handleBlockCreationFailed.mockResolvedValue(undefined);
});

function fixture(mode: "new-doc" | "journal-today" = "new-doc", local = false) {
  const models = new Map<
    string,
    { flavour: string; props: { sourceId?: string } }
  >();
  const records = new Map<string, { id: string }>();
  const store = {
    readonly: false,
    getBlock: vi.fn((id: string) =>
      models.has(id) ? { model: models.get(id) } : undefined,
    ),
    getBlocksByFlavour: vi.fn(() => [{ model: { id: "note" } }]),
    addBlock: vi.fn(
      (flavour: string, props: { id: string; sourceId: string }) => {
        models.set(props.id, { flavour, props });
        return props.id;
      },
    ),
  };
  const releaseDoc = vi.fn();
  const disposeWorkspace = vi.fn();
  const docs = {
    list: {
      isReady$: { waitFor: vi.fn(async () => true) },
      doc$: (id: string) => ({ value: records.get(id) }),
    },
    createDoc: vi.fn(({ id }: { id: string }) => {
      const record = { id };
      records.set(id, record);
      return record;
    }),
    waitForCreateAcknowledgement: vi.fn(async () => {}),
    open: vi.fn(() => ({
      doc: { virgultumDoc: store, waitForSyncReady: vi.fn(async () => {}) },
      release: releaseDoc,
    })),
  };
  const journal = {
    ensureJournalByDate: vi.fn((date: number) => {
      const record = { id: `journal-${date}` };
      records.set(record.id, record);
      return record;
    }),
  };
  const guard = { can: vi.fn(async () => true) };
  const server = {
    id: "original-server",
    baseUrl: "https://original.example",
    account$: { value: { id: "owner" } },
    features$: { value: { copilot: false } },
  };
  const transcription = Promise.withResolvers<void>();
  const releaseAudio = vi.fn();
  const transcribe = vi.fn(() => transcription.promise);
  const audio = {
    get: vi.fn(() => ({ obj: { transcribe }, release: releaseAudio })),
  };
  const services = new Map<unknown, unknown>([
    [h.Docs, docs],
    [h.Journal, journal],
    [h.Guard, guard],
    [h.Server, { server: local ? undefined : server }],
    [h.Audio, audio],
  ]);
  const blobSet = vi.fn(async () => "original-blob");
  const upload = vi.fn(async () => true);
  const workspace = {
    id: "original-workspace",
    flavour: local ? "local" : "server",
    scope: { get: (type: unknown) => services.get(type) },
    docCollection: { blobSync: { set: blobSet } },
    engine: { blob: { upload }, doc: { waitForSynced: vi.fn(async () => {}) } },
  };
  const open = vi.fn((_workspaceId: string) => ({
    workspace,
    dispose: disposeWorkspace,
  }));
  const framework = {
    get: () => ({
      openByWorkspaceId: open,
      list: { workspaces$: { waitFor: vi.fn(async () => []) } },
    }),
  } as unknown as FrameworkProvider;
  const status: RecordingStatus = {
    id: 0,
    status: "ready",
    startTime: 123456789,
    filepath: "/recording.mp4",
    destination: {
      workspaceId: "original-workspace",
      serverId: local ? null : "original-server",
      serverBaseUrl: local ? undefined : "https://original.example",
      savingMode: mode,
    },
  };
  h.recording.updateRecordingDelivery.mockImplementation(
    async (_id, delivery) => {
      status.delivery = delivery;
    },
  );
  return {
    framework,
    status,
    open,
    docs,
    journal,
    store,
    upload,
    blobSet,
    guard,
    transcription,
    transcribe,
    audio,
    disposeWorkspace,
    releaseDoc,
    releaseAudio,
  };
}

describe("native recording delivery consumer", () => {
  test("local capture saves a playable attachment without remote upload or automatic transcription", async () => {
    const f = fixture("new-doc", true);
    const unsubscribe = setupRecordingEvents(f.framework);
    try {
      h.listener?.(f.status);
      await vi.waitFor(() =>
        expect(h.recording.handleBlockCreationSuccess).toHaveBeenCalledOnce(),
      );
      expect(f.store.addBlock).toHaveBeenCalledOnce();
      expect(f.blobSet).toHaveBeenCalledOnce();
      expect(f.upload).not.toHaveBeenCalled();
      expect(f.transcribe).not.toHaveBeenCalled();
      expect(f.audio.get).not.toHaveBeenCalled();
      expect(f.releaseDoc).toHaveBeenCalledOnce();
      expect(f.disposeWorkspace).toHaveBeenCalledOnce();
    } finally {
      unsubscribe?.();
    }
  });
  test("saves once in the captured workspace and reports saved before Copilot-independent transcription completes", async () => {
    const f = fixture();
    const unsubscribe = setupRecordingEvents(f.framework);
    try {
      h.listener?.(f.status);
      h.listener?.(f.status);
      await vi.waitFor(() =>
        expect(h.recording.handleBlockCreationSuccess).toHaveBeenCalledWith(
          0,
          "claim",
        ),
      );
      expect(f.open).toHaveBeenCalledWith("original-workspace");
      expect(f.docs.createDoc).toHaveBeenCalledOnce();
      expect(f.store.addBlock).toHaveBeenCalledOnce();
      expect(f.transcribe).toHaveBeenCalledOnce();
      expect(f.disposeWorkspace).not.toHaveBeenCalled();
      f.transcription.resolve();
      await vi.waitFor(() => expect(f.disposeWorkspace).toHaveBeenCalledOnce());
    } finally {
      unsubscribe?.();
      f.transcription.resolve();
    }
  });
  test("journal mode uses the capture date and does not create a separate recording document", async () => {
    const f = fixture("journal-today");
    const unsubscribe = setupRecordingEvents(f.framework);
    try {
      h.listener?.(f.status);
      await vi.waitFor(() =>
        expect(h.recording.handleBlockCreationSuccess).toHaveBeenCalledOnce(),
      );
      expect(f.journal.ensureJournalByDate).toHaveBeenCalledWith(
        f.status.startTime,
      );
      expect(f.docs.createDoc).not.toHaveBeenCalled();
      expect(f.status.delivery?.docId).toBe(`journal-${f.status.startTime}`);
    } finally {
      unsubscribe?.();
      f.transcription.resolve();
    }
  });
  test("upload failure retains delivery IDs and retry creates one attachment in the same document", async () => {
    const f = fixture();
    f.upload.mockRejectedValueOnce(new Error("offline"));
    const unsubscribe = setupRecordingEvents(f.framework);
    try {
      h.listener?.(f.status);
      await vi.waitFor(() =>
        expect(h.recording.handleBlockCreationFailed).toHaveBeenCalledWith(
          0,
          { message: "offline" },
          "claim",
        ),
      );
      expect(f.store.addBlock).not.toHaveBeenCalled();
      expect(f.status.delivery).toEqual({
        docId: "recording-0",
        attachmentId: "recording-audio-0",
        blobId: "original-blob",
      });
      h.listener?.({ ...f.status });
      await vi.waitFor(() =>
        expect(h.recording.handleBlockCreationSuccess).toHaveBeenCalledOnce(),
      );
      expect(f.docs.createDoc).toHaveBeenCalledOnce();
      expect(f.store.addBlock).toHaveBeenCalledOnce();
      expect(
        f.open.mock.calls.every((call) => call[0] === "original-workspace"),
      ).toBe(true);
    } finally {
      unsubscribe?.();
      f.transcription.resolve();
    }
  });
});
