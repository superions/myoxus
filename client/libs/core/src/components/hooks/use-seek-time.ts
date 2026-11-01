import type { AudioMediaPlaybackState } from "@myoxus/core/modules/media/entities/audio-media";
import { clamp } from "lodash-es";
import { useEffect, useState } from "react";

const EPSILON = 0.02;

export const useSeekTime = (
  playbackState:
    | {
        state: AudioMediaPlaybackState;
        seekOffset: number;
        updateTime: number;
        playbackRate: number;
      }
    | undefined
    | null,
  duration?: number,
) => {
  const [seekTime, setSeekTime] = useState(0);
  useEffect(() => {
    if (!playbackState) {
      return;
    }
    const updateSeekTime = () => {
      const timeElapsed =
        playbackState.state === "playing"
          ? ((Date.now() - playbackState.updateTime) / 1000) *
            (playbackState.playbackRate ?? 1.0)
          : 0;
      const nextSeekTime =
        duration &&
        Math.abs(timeElapsed + playbackState.seekOffset - duration) < EPSILON
          ? duration
          : timeElapsed + playbackState.seekOffset;

      setSeekTime((current) => {
        return Math.abs(current - nextSeekTime) < EPSILON
          ? current
          : nextSeekTime;
      });
    };

    updateSeekTime();
    if (playbackState.state !== "playing") {
      return;
    }

    const interval = setInterval(updateSeekTime, 16.67);
    return () => {
      clearInterval(interval);
    };
  }, [duration, playbackState]);

  return clamp(seekTime, 0, duration ?? Number.MAX_SAFE_INTEGER);
};
