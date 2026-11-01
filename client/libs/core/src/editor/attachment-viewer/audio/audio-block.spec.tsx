// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { AudioAttachmentService } from "@myoxus/core/modules/media/services/audio-attachment";
import { audioJobHarness } from "@myoxus/core/modules/media/entities/audio-transcription-test-harness";
import type { AudioAttachmentBlock } from "@myoxus/core/modules/media/entities/audio-attachment-block";

import { FrameworkRoot, LiveData } from "@myoxus/infra";
import { MyoxusSettingsMantineProvider } from "@myoxus/ui-facade/provider";
import { signal } from "@preact/signals-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AttachmentBlockModel } from "@virgultum/editor/model";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { AudioBlockEmbedded } from "./audio-block";

vi.mock("@myoxus/core/components/hooks/myoxus/use-enable-ai", () => ({
  useEnableAI: () => true,
}));

// The global test mock echoes generated literal methods. Use the real English
// resource for this consuming boundary so labels match the served controls.
vi.mock("@myoxus/i18n", async () => {
  const { default: en } =
    await import("../../../../../i18n/src/resources/en.json");
  return {
    useI18n: () =>
      new Proxy(
        {},
        {
          get: (_target, key: string) =>
            key === "language"
              ? "en"
              : (options: Record<string, string> = {}) =>
                  Object.entries(options).reduce(
                    (text, [name, value]) =>
                      text.replaceAll(`{{${name}}}`, value),
                    (en as Record<string, string>)[key],
                  ),
        },
      ),
  };
});

// Persisted Lit content is covered by the real-store entity test and browser.
// Keep the actual consumer controls, job state machine and Facade audio player.
vi.mock("./transcription-block", () => ({ TranscriptionBlock: () => null }));

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    scale: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    roundRect: vi.fn(),
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function harness(readonly = false) {
  const h = audioJobHarness();
  const job = h.create();
  const readonly$ = signal(readonly);
  const model = {
    props: {
      sourceId: "canonical-audio",
      name: "known-german.wav",
      size: 1000,
    },
    store: {
      readonly$,
      get readonly() {
        return readonly$.value;
      },
    },
  } as unknown as AttachmentBlockModel;
  const play = vi.fn();
  const editorKey = vi.fn();
  const editorClick = vi.fn();
  const block = {
    props: model,
    expanded$: new LiveData(false),
    hasTranscription$: new LiveData(false),
    transcriptionBlock$: new LiveData(null),
    transcriptionJob: job,
    mount: () => {
      void job.restore();
    },
    unmount: () => {},
    transcribe: () => job.start(),
    insertTranscript: vi.fn(),
    audioMedia: {
      playbackState$: new LiveData({
        state: "idle",
        seekOffset: 0,
        updateTime: Date.now(),
        playbackRate: 1,
      }),
      stats$: new LiveData({
        duration: 5,
        waveform: new Float32Array([0.1, 0.5, 0.2]),
      }),
      loading$: new LiveData(false),
      loadError$: new LiveData(null),
      play,
      pause: vi.fn(),
      stop: vi.fn(),
      seekTo: vi.fn(),
      setPlaybackRate: vi.fn(),
      revalidateBuffer: vi.fn(),
    },
  } as unknown as AudioAttachmentBlock;
  h.framework.service(AudioAttachmentService, {
    get: () => ({ obj: block, release: () => job.dispose() }),
  } as unknown as AudioAttachmentService);
  function view() {
    return render(
      <MyoxusSettingsMantineProvider>
        <FrameworkRoot framework={h.framework.provider()}>
          <div onKeyDown={editorKey} onClick={editorClick}>
            <AudioBlockEmbedded model={model} />
          </div>
        </FrameworkRoot>
      </MyoxusSettingsMantineProvider>,
    );
  }
  return { ...h, block, job, play, view, readonly$, editorKey, editorClick };
}

test("readonly controls can preview text but cannot offer insertion or invoke document writes", async () => {
  const h = harness(true);
  h.setState(h.finished);
  h.view();
  await waitFor(() => expect(h.job.error$.value?.message ?? null).toBeNull());
  await waitFor(() => expect(h.job.status$.value.status).toBe("claimed"));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Show transcript" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show transcript" }));
  expect(
    screen.getByText(/Am Montag planen wir die Arbeit/).textContent,
  ).toContain(h.finished.text);
  expect(
    screen.queryByRole("button", { name: "Insert transcript" }),
  ).toBeNull();
  expect(h.block.insertTranscript).not.toHaveBeenCalled();
});
