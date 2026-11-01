// SPDX-License-Identifier: AGPL-3.0-or-later

import "./audio-player.css";

import {
  ActionIcon as MantineActionIcon,
  Box,
  Group,
  NativeSelect as MantineNativeSelect,
  Paper as MantinePaper,
  Skeleton as MantineSkeleton,
  Stack,
  Text,
} from "@mantine/core";
import {
  CloseIcon,
  ForwardThirtySecondsIcon,
  PauseIcon,
  PlayIcon,
  RewindFifteenSecondsIcon,
  VoiceIcon,
} from "@myoxus/icons/react";
import {
  type ChangeEvent,
  type MouseEvent,
  type MouseEventHandler,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function readStyleNumber(
  computedStyle: CSSStyleDeclaration,
  property: string,
  fallback: number,
) {
  const parsed = Number.parseFloat(computedStyle.getPropertyValue(property));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readCustomNumber(
  computedStyle: CSSStyleDeclaration,
  variable: string,
  fallback: number,
) {
  const parsed = Number.parseFloat(computedStyle.getPropertyValue(variable));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readCssColor(
  computedStyle: CSSStyleDeclaration,
  properties: string[],
) {
  for (const property of properties) {
    const value = computedStyle.getPropertyValue(property).trim();
    if (value && !value.includes("var(")) {
      return value;
    }
  }
  return computedStyle.color || "CanvasText";
}

interface DrawWaveformOptions {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  waveform: number[];
  progress: number;
  mini: boolean;
}

const waveformFallbackGeometry = {
  horizontalPadding: 2,
  minAmplitude: 0.1,
  strokeWidth: 1,
} as const;

// Canvas waveform rendering is technical geometry, but the visual contract still
// comes from Facade CSS variables so product code cannot fork media sizing.
function readWaveformGeometry(container: HTMLElement, mini: boolean) {
  const computedStyle = getComputedStyle(container);
  const strokeWidth = readStyleNumber(
    computedStyle,
    "outline-width",
    waveformFallbackGeometry.strokeWidth,
  );
  const horizontalPadding = readStyleNumber(
    computedStyle,
    "scroll-padding-inline-start",
    waveformFallbackGeometry.horizontalPadding,
  );

  return {
    barWidth: mini ? strokeWidth / 2 : strokeWidth,
    gap: readStyleNumber(computedStyle, "column-gap", strokeWidth),
    horizontalPadding,
    minAmplitude: readCustomNumber(
      computedStyle,
      "--myoxus-audio-waveform-min-amplitude",
      waveformFallbackGeometry.minAmplitude,
    ),
    progressDotRadius: horizontalPadding,
    progressLineWidth: strokeWidth,
  };
}

function drawWaveform({
  canvas,
  container,
  waveform,
  progress,
  mini,
}: DrawWaveformOptions) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  const {
    barWidth,
    gap,
    horizontalPadding,
    minAmplitude,
    progressDotRadius,
    progressLineWidth,
  } = readWaveformGeometry(container, mini);
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const availableWidth = Math.max(1, rect.width - horizontalPadding * 2);
  const totalBars = Math.max(1, Math.floor(availableWidth / (barWidth + gap)));
  const step = waveform.length / totalBars;
  const bars = Array.from({ length: totalBars }, (_, index) => {
    const startIdx = Math.floor(index * step);
    const endIdx = Math.max(startIdx + 1, Math.floor((index + 1) * step));
    const slice = waveform.slice(startIdx, endIdx);
    const average = slice.reduce((sum, value) => sum + value, 0) / slice.length;
    return Math.max(average || 0, minAmplitude);
  });
  const computedStyle = getComputedStyle(container);
  const unplayedColor = readCssColor(computedStyle, ["color"]);
  const playedColor = readCssColor(computedStyle, ["accent-color", "color"]);
  const progressIndex = Math.floor(progress * bars.length);

  bars.forEach((value, index) => {
    const x = horizontalPadding + index * (barWidth + gap);
    const height = value * rect.height;
    const y = (rect.height - height) / 2;
    ctx.fillStyle =
      progress > 0 && index <= progressIndex ? playedColor : unplayedColor;

    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, height, barWidth / 2);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, barWidth, height);
    }
  });

  if (progress > 0) {
    const x = horizontalPadding + progress * availableWidth;
    ctx.fillStyle = playedColor;
    ctx.fillRect(x - progressLineWidth / 2, 0, progressLineWidth, rect.height);
    ctx.beginPath();
    ctx.arc(x, progressDotRadius, progressDotRadius, 0, Math.PI * 2);
    ctx.arc(
      x,
      rect.height - progressDotRadius,
      progressDotRadius,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

interface AudioWaveformProps {
  waveform: number[];
  progress: number;
  onManualSeek: (progress: number) => void;
  mini?: boolean;
  loading?: boolean;
}

function AudioWaveform({
  waveform,
  progress,
  onManualSeek,
  mini = false,
  loading = false,
}: AudioWaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDraggingRef = useRef(false);

  const calculateProgress = useCallback(
    (clientX: number) => {
      if (!containerRef.current) return 0;
      const rect = containerRef.current.getBoundingClientRect();
      const { horizontalPadding } = readWaveformGeometry(
        containerRef.current,
        mini,
      );
      const availableWidth = Math.max(1, rect.width - horizontalPadding * 2);
      return clamp(
        (clientX - rect.left - horizontalPadding) / availableWidth,
        0,
        1,
      );
    },
    [mini],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      onManualSeek(calculateProgress(event.clientX));
      isDraggingRef.current = true;
      event.preventDefault();
    },
    [calculateProgress, onManualSeek],
  );

  useEffect(() => {
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      if (!isDraggingRef.current) return;
      onManualSeek(calculateProgress(event.clientX));
      event.preventDefault();
    };
    const handlePointerUp = () => {
      isDraggingRef.current = false;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [calculateProgress, onManualSeek]);

  useEffect(() => {
    const draw = () => {
      if (!canvasRef.current || !containerRef.current) return;
      drawWaveform({
        canvas: canvasRef.current,
        container: containerRef.current,
        waveform,
        progress: clamp(progress, 0, 1),
        mini,
      });
    };

    const observer = new ResizeObserver(draw);
    if (containerRef.current) observer.observe(containerRef.current);
    draw();
    return () => observer.disconnect();
  }, [mini, progress, waveform]);

  return (
    <Box
      ref={containerRef}
      className="myoxus-audio-waveform"
      data-mini={mini ? "true" : undefined}
      onPointerDown={handlePointerDown}
      onClick={(event) => event.stopPropagation()}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress * 100}
      draggable="false"
    >
      {loading ? (
        <MantineSkeleton h="100%" radius="xs" w="100%" />
      ) : (
        <canvas ref={canvasRef} className="myoxus-audio-waveform__canvas" />
      )}
    </Box>
  );
}

export interface AudioPlayerProps {
  name: string;
  description?: ReactNode;
  waveform: number[] | null;
  playbackState: "idle" | "playing" | "paused" | "stopped";
  seekTime: number;
  duration: number;
  loading?: boolean;
  notesEntry?: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onPlay: MouseEventHandler;
  onPause: MouseEventHandler;
  onStop: MouseEventHandler;
  onSeek: (newTime: number) => void;
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
}

const playbackRates = [0.5, 0.75, 1, 1.5, 1.75, 2, 3];

export const AudioPlayer = ({
  name,
  description,
  playbackState,
  seekTime,
  duration,
  notesEntry,
  waveform,
  loading,
  onPlay,
  onPause,
  onSeek,
  onClick,
  playbackRate,
  onPlaybackRateChange,
}: AudioPlayerProps) => {
  const handleProgressClick = useCallback(
    (progress: number) => onSeek(progress * duration),
    [duration, onSeek],
  );
  const handlePlayToggle = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      if (loading) return;
      if (playbackState === "playing") {
        onPause(event);
      } else {
        onPlay(event);
      }
    },
    [loading, onPause, onPlay, playbackState],
  );
  const progressPercentage = duration > 0 ? seekTime / duration : 0;
  const handleRateSelect = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onPlaybackRateChange(Number(event.target.value));
    },
    [onPlaybackRateChange],
  );

  return (
    <MantinePaper
      component="section"
      withBorder
      p="sm"
      radius="md"
      onClick={onClick}
      data-myoxus-ui-role="audio-player"
    >
      <Stack gap="sm">
        <Group align="flex-start" justify="space-between" gap="sm">
          <Stack gap="xs" miw={0}>
            <Group gap="xs" wrap="nowrap">
              <VoiceIcon />
              <Text fw={600} truncate>
                {name}
              </Text>
            </Group>
            {description ? (
              <Text c="dimmed" component="div" size="sm">
                {description}
              </Text>
            ) : null}
          </Stack>
          <Group gap="xs" wrap="nowrap">
            <MantineNativeSelect
              size="xs"
              value={String(playbackRate)}
              onChange={handleRateSelect}
              aria-label="Playback speed"
              data={playbackRates.map((rate) => ({
                value: String(rate),
                label: `${rate}x`,
              }))}
              data-myoxus-ui-role="audio-playback-rate"
            />
            {notesEntry}
            <MantineActionIcon
              component="button"
              type="button"
              radius="xl"
              size="lg"
              variant="light"
              disabled={loading}
              onClick={handlePlayToggle}
              aria-label={playbackState === "playing" ? "Pause" : "Play"}
              data-myoxus-ui-role="audio-play-toggle"
            >
              {playbackState === "playing" ? <PauseIcon /> : <PlayIcon />}
            </MantineActionIcon>
          </Group>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Text c="dimmed" size="sm">
            {formatTime(seekTime)}
          </Text>
          <AudioWaveform
            waveform={waveform || []}
            progress={progressPercentage}
            onManualSeek={handleProgressClick}
            loading={!waveform || waveform.length === 0}
          />
          <Text c="dimmed" size="sm" ta="end">
            {formatTime(duration)}
          </Text>
        </Group>
      </Stack>
    </MantinePaper>
  );
};

export const MiniAudioPlayer = ({
  name,
  playbackState,
  seekTime,
  duration,
  waveform,
  onPlay,
  onPause,
  onSeek,
  onClick,
  onStop,
}: AudioPlayerProps) => {
  const handleProgressClick = useCallback(
    (progress: number) => onSeek(progress * duration),
    [duration, onSeek],
  );
  const handlePlayToggle = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      if (playbackState === "playing") {
        onPause(event);
      } else {
        onPlay(event);
      }
    },
    [onPause, onPlay, playbackState],
  );
  const handleRewind = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onSeek(clamp(seekTime - 15, 0, duration));
    },
    [duration, onSeek, seekTime],
  );
  const handleForward = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onSeek(clamp(seekTime + 30, 0, duration));
    },
    [duration, onSeek, seekTime],
  );
  const handleClose = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onStop(event);
    },
    [onStop],
  );
  const progressPercentage = duration > 0 ? seekTime / duration : 0;

  return (
    <MantinePaper
      withBorder
      p="xs"
      radius="sm"
      data-interactive={onClick ? "true" : undefined}
      data-myoxus-ui-role="mini-audio-player"
      onClick={onClick}
    >
      <Stack gap="xs">
        <Group gap="xs" justify="space-between" wrap="nowrap">
          <Text size="sm" truncate>
            {name}
          </Text>
          <MantineActionIcon
            component="button"
            type="button"
            size="sm"
            variant="subtle"
            onClick={handleClose}
            aria-label="Close player"
            data-myoxus-ui-role="audio-close"
          >
            <CloseIcon />
          </MantineActionIcon>
        </Group>
        <Group gap="xs" justify="center" wrap="nowrap">
          <MantineActionIcon
            component="button"
            type="button"
            size="sm"
            variant="subtle"
            onClick={handleRewind}
            aria-label="Rewind 15 seconds"
            data-myoxus-ui-role="audio-rewind"
          >
            <RewindFifteenSecondsIcon />
          </MantineActionIcon>
          <MantineActionIcon
            component="button"
            type="button"
            radius="xl"
            size="md"
            variant="light"
            onClick={handlePlayToggle}
            aria-label={playbackState === "playing" ? "Pause" : "Play"}
            data-myoxus-ui-role="audio-play-toggle"
          >
            {playbackState === "playing" ? <PauseIcon /> : <PlayIcon />}
          </MantineActionIcon>
          <MantineActionIcon
            component="button"
            type="button"
            size="sm"
            variant="subtle"
            onClick={handleForward}
            aria-label="Forward 30 seconds"
            data-myoxus-ui-role="audio-forward"
          >
            <ForwardThirtySecondsIcon />
          </MantineActionIcon>
        </Group>
        <AudioWaveform
          waveform={waveform || []}
          progress={progressPercentage}
          onManualSeek={handleProgressClick}
          mini
        />
      </Stack>
    </MantinePaper>
  );
};
