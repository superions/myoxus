/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * @vitest-environment happy-dom
 */

import type { EditorHost } from "@virgultum/editor/std";
import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveCreateMessageAttachments } from "./request-attachments";
import { toTextStream } from "./event-source";
import { textToText } from "./request";
import type { CopilotClient } from "./copilot-client";
import { AIProvider } from "./ai-provider";
const { capture } = vi.hoisted(() => ({
  capture: vi.fn(() => "unused-event"),
}));
vi.mock("@sentry/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/react")>()),
  captureException: capture,
}));

class StreamConnection extends EventTarget {
  readyState = 1;
  close = vi.fn(() => {
    this.readyState = 2;
  });
  send(type: string, data?: string) {
    this.dispatchEvent(
      data === undefined ? new Event(type) : new MessageEvent(type, { data }),
    );
  }
  stream(options?: Parameters<typeof toTextStream>[1]) {
    return toTextStream(this as unknown as EventSource, options)[
      Symbol.asyncIterator
    ]();
  }
}

describe("AI request stream lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  test("stop during message creation rejects a late ack without opening generation or reporting a server failure", async () => {
    let acknowledge!: (id: string) => void;
    const created = new Promise<string>((resolve) => {
      acknowledge = resolve;
    });
    const createMessage = vi.fn(() => created);
    const chatTextStream = vi.fn();
    const onMessageCreated = vi.fn();
    const client = {
      createMessage,
      chatTextStream,
    } as unknown as CopilotClient;
    capture.mockClear();
    const events: string[] = [];
    const subscription = AIProvider.slots.actions.subscribe((event) =>
      events.push(event.event),
    );
    const controller = new AbortController();
    const previousChat = AIProvider.actions.chat;
    try {
      AIProvider.provide("chat", async (options) =>
        textToText({
          client,
          sessionId: "session",
          content: options.input,
          signal: options.signal,
          stream: true,
          streamTimeout: null,
        }),
      );
      const action = AIProvider.actions.chat;
      if (!action) throw new Error("chat provider not registered");
      const request = await action({
        workspaceId: "workspace",
        sessionId: "session",
        input: "hello",
        stream: true,
        signal: controller.signal,
        onMessageCreated,
      });
      if (typeof request === "string" || !(Symbol.asyncIterator in request))
        throw new Error("chat must return a stream");
      const rejected = expect(
        request[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
      controller.abort();
      acknowledge("late-message");
      await rejected;
      expect(chatTextStream).not.toHaveBeenCalled();
      expect(onMessageCreated).not.toHaveBeenCalled();
      expect(events).toEqual(["started", "aborted:stop"]);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      subscription.unsubscribe();
      capture.mockClear();
      if (previousChat) AIProvider.actions.chat = previousChat;
      else delete AIProvider.actions.chat;
    }
  });

  test("native waiting retains the message deadline and send/regenerate correlation", async () => {
    vi.useFakeTimers();
    const source = new StreamConnection();
    const createMessage = vi.fn(async () => "message");
    const chatTextStream = vi.fn(() => source);
    const retrievalStatus = vi.fn();
    const onMessageCreated = vi.fn();
    const client = {
      createMessage,
      chatTextStream,
    } as unknown as CopilotClient;
    const request = textToText({
      client,
      sessionId: "session",
      content: "hello",
      requestId: "explicit-send",
      stream: true,
      timeout: 300000,
      streamTimeout: null,
      onRetrievalStatus: retrievalStatus,
      onMessageCreated,
    });
    if (!(Symbol.asyncIterator in request))
      throw new Error("stream request must be iterable");
    const stream = request[Symbol.asyncIterator]();
    const next = stream.next();
    await vi.advanceTimersByTimeAsync(360000);
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "hello", requestId: "explicit-send" }),
      { timeout: 300000, signal: undefined },
    );
    expect(source.close).not.toHaveBeenCalled();
    expect(onMessageCreated).toHaveBeenCalledExactlyOnceWith("message");
    source.send("retrieval-status", JSON.stringify({ available: false }));
    source.send("message", "answer");
    source.send("done", "{}");
    expect(await next).toEqual({ done: false, value: "answer" });
    expect(retrievalStatus).toHaveBeenCalledWith(false);
    expect((await stream.next()).done).toBe(true);
    expect(chatTextStream).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message",
        requestId: "explicit-send",
      }),
      expect.anything(),
    );
    const retrySource = new StreamConnection();
    chatTextStream.mockReturnValue(retrySource);
    const retry = textToText({
      client,
      sessionId: "session",
      stream: true,
      retry: true,
      messageId: "message",
      responseId: "assistant",
      expectedStreamId: "generation",
      requestId: "explicit-regenerate",
      modelId: "literal.model/id",
    });
    if (!(Symbol.asyncIterator in retry))
      throw new Error("retry must be iterable");
    const iterator = retry[Symbol.asyncIterator]();
    const result = iterator.next();
    await vi.advanceTimersByTimeAsync(0);
    expect(createMessage).toHaveBeenCalledOnce();
    expect(chatTextStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: "message",
        responseId: "assistant",
        expectedStreamId: "generation",
        requestId: "explicit-regenerate",
        modelId: "literal.model/id",
      }),
      expect.anything(),
    );
    retrySource.send("done", "{}");
    expect((await result).done).toBe(true);
  });

  test("drains queued message and attachment events before done and ignores late close errors", async () => {
    vi.useFakeTimers();
    const source = new StreamConnection();
    const remove = vi.spyOn(source, "removeEventListener");
    const stream = source.stream({ timeout: 50 });
    const first = stream.next();
    source.send("message", "first 🦔");
    source.send("attachment", "blob-key");
    source.send("message", "last");
    source.send("done", "{}");
    source.send("error");
    source.send("message", "must not replace completed output");
    expect(await first).toEqual({
      done: false,
      value: { type: "message", data: "first 🦔" },
    });
    expect(await stream.next()).toEqual({
      done: false,
      value: { type: "attachment", data: "blob-key" },
    });
    expect(await stream.next()).toEqual({
      done: false,
      value: { type: "message", data: "last" },
    });
    expect((await stream.next()).done).toBe(true);
    expect(source.close).toHaveBeenCalled();
    expect(remove.mock.calls.map((call) => call[0]).sort()).toEqual([
      "attachment",
      "done",
      "error",
      "message",
      "retrieval-status",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("keeps prior output but rejects transport and bounded server failures instead of fabricating success", async () => {
    for (const [payload, message] of [
      [undefined, "Copilot connection ended before completion"],
      [
        JSON.stringify({
          code: "COPILOT_PROVIDER_SIDE_ERROR",
          message: "Provider unavailable",
        }),
        "COPILOT_PROVIDER_SIDE_ERROR: Provider unavailable",
      ],
      ["private-invalid-frame", "Invalid Copilot stream error response"],
    ] as const) {
      const source = new StreamConnection();
      const stream = source.stream();
      const first = stream.next();
      source.send("message", "partial");
      source.send("error", payload);
      source.send("done", "{}");
      expect((await first).value?.data).toBe("partial");
      await expect(stream.next()).rejects.toThrow(message);
      expect(source.close).toHaveBeenCalled();
    }
  });

  test("wakes immediately on stop or timeout and clears its owned timers", async () => {
    vi.useFakeTimers();
    for (const alreadyAborted of [false, true]) {
      const source = new StreamConnection();
      const controller = new AbortController();
      if (alreadyAborted) controller.abort();
      const stream = source.stream({
        signal: controller.signal,
        timeout: 5000,
      });
      const rejected = expect(stream.next()).rejects.toMatchObject({
        name: "AbortError",
      });
      if (!alreadyAborted) controller.abort();
      await rejected;
      expect(source.close).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
    const source = new StreamConnection();
    const stream = source.stream({ timeout: 20 });
    const rejected = expect(stream.next()).rejects.toThrow("Request timeout");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(source.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function createHostUploadHarness() {
  const set = vi.fn(async (attachment: Blob | File) => {
    return `blob-${attachment.size}`;
  });
  const upload = vi.fn(async (_blobId: string) => true);

  const host = {
    store: {
      blobSync: {
        set,
        upload,
      },
    },
  } as unknown as EditorHost;

  return { host, set, upload };
}

describe("AI request attachments", () => {
  test("keeps existing persisted blob ids unchanged", async () => {
    await expect(
      resolveCreateMessageAttachments({
        attachments: ["blob-a", "blob-b"],
      }),
    ).resolves.toEqual(["blob-a", "blob-b"]);
  });

  test("persists Blob/File attachments through the workspace blob engine before createMessage", async () => {
    const { host, set, upload } = createHostUploadHarness();
    const blob = new Blob(["abc"], { type: "text/plain" });
    const file = new File(["file"], "note.txt", { type: "text/plain" });

    await expect(
      resolveCreateMessageAttachments({
        attachments: ["existing", blob, file],
        host,
      }),
    ).resolves.toEqual(["existing", "blob-3", "blob-4"]);

    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenNthCalledWith(1, blob);
    expect(set).toHaveBeenNthCalledWith(2, file);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenNthCalledWith(1, "blob-3");
    expect(upload).toHaveBeenNthCalledWith(2, "blob-4");
  });

  test("accepts an explicit persister for non-editor callers", async () => {
    const blob = new Blob(["abc"], { type: "text/plain" });
    const persistAttachment = vi.fn(async (_attachment: Blob | File) => {
      return "persisted-by-caller";
    });

    await expect(
      resolveCreateMessageAttachments({
        attachments: [blob],
        persistAttachment,
      }),
    ).resolves.toEqual(["persisted-by-caller"]);

    expect(persistAttachment).toHaveBeenCalledWith(blob);
    const controller = new AbortController();
    persistAttachment.mockImplementationOnce(async () => {
      controller.abort();
      return "late-upload-ack";
    });
    await expect(
      resolveCreateMessageAttachments({
        attachments: [blob, blob],
        persistAttachment,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(persistAttachment).toHaveBeenCalledTimes(2);
  });

  test("fails loudly when a direct Blob/File attachment cannot be persisted", async () => {
    const blob = new Blob(["abc"], { type: "text/plain" });

    await expect(
      resolveCreateMessageAttachments({
        attachments: [blob],
      }),
    ).rejects.toThrow(
      "AI message file attachments require an editor host or an explicit attachment persister before createMessage",
    );
  });

  test("fails when the workspace blob peer does not confirm upload", async () => {
    const { host, upload } = createHostUploadHarness();
    upload.mockResolvedValue(false);

    await expect(
      resolveCreateMessageAttachments({
        attachments: [new Blob(["abc"])],
        host,
      }),
    ).rejects.toThrow(
      "was stored locally but could not be uploaded to the workspace blob peer",
    );
  });
});
