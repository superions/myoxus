// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AudioPlayer,
  type AudioPlayerProps,
  MiniAudioPlayer,
} from "./audio-player";
import { MyoxusUIProvider } from "./provider";

const baseProps: AudioPlayerProps = {
  name: "Interview",
  description: "Transcript audio",
  waveform: null,
  playbackState: "idle",
  seekTime: 15,
  duration: 120,
  onPlay: vi.fn(),
  onPause: vi.fn(),
  onStop: vi.fn(),
  onSeek: vi.fn(),
  playbackRate: 1,
  onPlaybackRateChange: vi.fn(),
};

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("facade audio players", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  test("uses Mantine Paper, NativeSelect and ActionIcon for visible full-player controls", () => {
    const onPlay = vi.fn();
    const onPlaybackRateChange = vi.fn();

    renderWithProvider(
      <AudioPlayer
        {...baseProps}
        onPlay={onPlay}
        onPlaybackRateChange={onPlaybackRateChange}
      />,
    );

    expect(
      document.querySelector('[data-myoxus-ui-role="audio-player"]'),
    ).not.toBeNull();

    const speed = screen.getByLabelText("Playback speed") as HTMLSelectElement;
    expect(speed.className).toContain("mantine-NativeSelect-input");
    fireEvent.change(speed, { target: { value: "1.5" } });
    expect(onPlaybackRateChange).toHaveBeenCalledWith(1.5);

    const play = screen.getByRole("button", { name: "Play" });
    expect(play.className).toContain("mantine-ActionIcon-root");
    expect(play.dataset.myoxusUiRole).toBe("audio-play-toggle");
    fireEvent.click(play);
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  test("keeps mini-player controls Mantine-backed while waveform remains technical canvas logic", () => {
    const onStop = vi.fn();
    const onSeek = vi.fn();
    const onClick = vi.fn();

    renderWithProvider(
      <MiniAudioPlayer
        {...baseProps}
        onClick={onClick}
        onStop={onStop}
        onSeek={onSeek}
        waveform={null}
      />,
    );

    const player = screen
      .getByText("Interview")
      .closest('[data-myoxus-ui-role="mini-audio-player"]');
    expect(player?.getAttribute("data-interactive")).toBe("true");
    fireEvent.click(player as HTMLElement);
    expect(onClick).toHaveBeenCalledTimes(1);

    for (const label of [
      "Rewind 15 seconds",
      "Play",
      "Forward 30 seconds",
      "Close player",
    ]) {
      const button = screen.getByRole("button", { name: label });
      expect(button.className).toContain("mantine-ActionIcon-root");
    }

    fireEvent.click(screen.getByRole("button", { name: "Rewind 15 seconds" }));
    expect(onSeek).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "Close player" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
