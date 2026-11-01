// SPDX-License-Identifier: MIT
import { useEnableAI } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import { useSeekTime } from "@myoxus/core/components/hooks/use-seek-time";
import {
  transcriptTimestamp,
  type AudioAttachmentBlock,
} from "@myoxus/core/modules/media/entities/audio-attachment-block";
import { AudioAttachmentService } from "@myoxus/core/modules/media/services/audio-attachment";
import { AiJobStatus } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { TextIcon } from "@myoxus/icons/react";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import {
  AudioPlayer,
  Button,
  Group,
  MyoxusText,
  Stack,
  Tooltip,
} from "@myoxus/ui-facade";
import type { AttachmentBlockModel } from "@virgultum/editor/model";
import { formatByteSize } from "@virgultum/global/utils";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AttachmentViewerProps } from "../types";
import { TranscriptionBlock } from "./transcription-block";

// Keep chat/feature-flag dependencies outside the speech-only player. Stored
// output stays readable while the server's generative capability is disabled.
const EnrichmentActions = ({
  block,
  busy,
  onAction,
}: {
  block: AudioAttachmentBlock;
  busy: boolean;
  onAction: (button: HTMLButtonElement) => void;
}) => {
  const enableAI = useEnableAI();
  const [requested, setRequested] = useState<"summary" | "actions" | null>(
    null,
  );
  const t = useI18n();
  return enableAI ? (
    <Group
      // Native controls must not trigger the surrounding editor's block commands.
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        disabled={busy}
        loading={busy && requested === "summary"}
        onClick={(event) => {
          setRequested("summary");
          onAction(event.currentTarget);
          void block.transcriptionJob.enrich({ summary: true, actions: false });
        }}
      >
        {t["com.myoxus.audio.enrichment.generate-summary"]()}
      </Button>
      <Button
        disabled={busy}
        loading={busy && requested === "actions"}
        onClick={(event) => {
          setRequested("actions");
          onAction(event.currentTarget);
          void block.transcriptionJob.enrich({ summary: false, actions: true });
        }}
      >
        {t["com.myoxus.audio.enrichment.generate-actions"]()}
      </Button>
    </Group>
  ) : (
    <MyoxusText>{t["com.myoxus.audio.enrichment.unavailable"]()}</MyoxusText>
  );
};

const AttachmentAudioPlayer = ({ block }: { block: AudioAttachmentBlock }) => {
  const t = useI18n();
  const media = block.audioMedia;
  const playback = useLiveData(media.playbackState$);
  const stats = useLiveData(media.stats$);
  const expanded = useLiveData(block.expanded$);
  const readonly = useLiveData(
    useMemo(() => LiveData.fromSignal(block.props.store.readonly$), [block]),
  );
  const inserted = useLiveData(block.hasTranscription$);
  const result = useLiveData(block.transcriptionJob.result$);
  const status = useLiveData(block.transcriptionJob.status$).status;
  const ready = status === "claimed";
  const enrichment = useLiveData(block.transcriptionJob.enrichment$);
  const enriching = useLiveData(block.transcriptionJob.enrichmentBusy$);
  const enrichmentError = useLiveData(block.transcriptionJob.enrichmentError$);
  const capability = useLiveData(block.transcriptionJob.capability$);
  const busy = useLiveData(block.transcriptionJob.transcribing$);
  const actionRef = useRef<HTMLButtonElement>(null);
  const returnActionFocus = useRef(false);
  const focusTarget = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const button = focusTarget.current ?? actionRef.current;
    if (!button) return;
    const document = button.ownerDocument;
    if (!busy && !enriching) {
      // Chrome blurs a focused button when loading disables it. Return only
      // that displaced focus without scrolling the player; never take it back
      // from another user action.
      if (
        returnActionFocus.current &&
        document.activeElement === document.body &&
        !button.disabled &&
        button.isConnected
      )
        button.focus({ preventScroll: true });
      returnActionFocus.current = false;
      return;
    }
    const moved = (event: Event) => {
      if (
        (event.type === "pointerdown" || event.target !== document.body) &&
        !button.contains(event.target as Node)
      )
        returnActionFocus.current = false;
    };
    const navigated = (event: KeyboardEvent) => {
      if (event.key === "Tab" || event.key === "Escape")
        returnActionFocus.current = false;
    };
    document.addEventListener("focusin", moved);
    document.addEventListener("pointerdown", moved);
    document.addEventListener("keydown", navigated);
    return () => {
      document.removeEventListener("focusin", moved);
      document.removeEventListener("pointerdown", moved);
      document.removeEventListener("keydown", navigated);
    };
  }, [busy, enriching]);
  const error = useLiveData(block.transcriptionJob.error$);
  const loadingError = useLiveData(media.loadError$);
  const seekTime = useSeekTime(playback, stats.duration);
  const unavailable = capability
    ? !capability.allowed
      ? t["com.myoxus.audio.transcription.denied"]()
      : !capability.enabled
        ? t["com.myoxus.audio.transcription.disabled"]()
        : !capability.configured
          ? t["com.myoxus.audio.transcription.unconfigured"]()
          : null
    : null;
  const statusText =
    status === AiJobStatus.Pending
      ? t["com.myoxus.audio.transcription.queued"]()
      : status === AiJobStatus.Running || status === "started"
        ? t["com.myoxus.audio.transcription.processing"]()
        : status === "claimed"
          ? t["com.myoxus.audio.transcription.complete"]()
          : status === "paused"
            ? t["com.myoxus.audio.transcription.paused"]()
            : unavailable;
  const previewLabel = expanded
    ? t["com.myoxus.audio.transcription.hide"]()
    : t["com.myoxus.audio.transcription.show"]();
  const actionLabel = ready
    ? previewLabel
    : status === "paused"
      ? t["com.myoxus.audio.transcription.resume"]()
      : status === AiJobStatus.Failed
        ? t["Retry"]()
        : t["com.myoxus.audio.transcription.transcribe"]();

  return (
    <Stack>
      <AudioPlayer
        name={block.props.props.name}
        description={
          <Stack>
            <MyoxusText>{formatByteSize(block.props.props.size)}</MyoxusText>
            {loadingError && (
              <Group>
                <MyoxusText tone="danger">{loadingError.message}</MyoxusText>
                <Button onClick={() => media.revalidateBuffer()}>
                  {t["com.myoxus.editor.toolbar.reload"]()}
                </Button>
              </Group>
            )}
            {statusText && <MyoxusText role="status">{statusText}</MyoxusText>}
            {error && (
              <MyoxusText tone="danger" role="alert">
                {error.message}
              </MyoxusText>
            )}
          </Stack>
        }
        loading={stats.duration === 0}
        playbackState={playback?.state || "idle"}
        waveform={stats.waveform}
        seekTime={seekTime}
        duration={stats.duration}
        onClick={(e) => e.stopPropagation()}
        onPlay={() => media.play()}
        onPause={() => media.pause()}
        onStop={() => media.stop()}
        onSeek={(time) => media.seekTo(time)}
        playbackRate={playback?.playbackRate || 1}
        onPlaybackRateChange={(rate) => media.setPlaybackRate(rate)}
        notesEntry={
          <Group>
            {(result || inserted) && !ready && (
              <Button
                prefix={<TextIcon />}
                onClick={() => block.expanded$.setValue(!expanded)}
              >
                {previewLabel}
              </Button>
            )}
            <Tooltip
              content={
                ready || status === "paused"
                  ? actionLabel
                  : (unavailable ??
                    (capability
                      ? t["com.myoxus.audio.transcription.limits"]({
                          size:
                            formatByteSize(capability.maxInputBytes) ??
                            String(capability.maxInputBytes),
                          seconds: new Intl.NumberFormat(t.language).format(
                            capability.maxDurationSeconds,
                          ),
                        })
                      : t["com.myoxus.audio.transcription.processing"]()))
              }
            >
              <Button
                ref={actionRef}
                disabled={
                  !ready &&
                  status !== "paused" &&
                  (busy || !!unavailable || !capability)
                }
                loading={busy}
                prefix={<TextIcon />}
                onClick={(event) => {
                  if (ready) {
                    block.expanded$.setValue(!expanded);
                    return;
                  }
                  focusTarget.current = event.currentTarget;
                  returnActionFocus.current =
                    event.currentTarget.ownerDocument.activeElement ===
                    event.currentTarget;
                  if (status === "paused")
                    void block.transcriptionJob.restore();
                  else void block.transcribe();
                }}
              >
                {actionLabel}
              </Button>
            </Tooltip>
            {result && !inserted && !readonly && (
              <Button
                onClick={() =>
                  block.insertTranscript(
                    t["com.myoxus.audio.transcription.title"](),
                  )
                }
              >
                {t["com.myoxus.audio.transcription.insert"]()}
              </Button>
            )}
          </Group>
        }
      />
      {expanded && !inserted && result && (
        <Stack data-myoxus-ui-role="attachment-audio-preview">
          <MyoxusText>{t["com.myoxus.audio.transcription.title"]()}</MyoxusText>
          {result.segments.length ? (
            result.segments.map((segment, index) => (
              <MyoxusText key={index}>
                {segment.startSeconds !== undefined &&
                  `${transcriptTimestamp(segment.startSeconds)} `}
                {segment.speaker && `${segment.speaker} `}
                {segment.text}
              </MyoxusText>
            ))
          ) : (
            <MyoxusText>{result.text}</MyoxusText>
          )}
        </Stack>
      )}
      {ready && (
        <Stack data-myoxus-ui-role="attachment-audio-enrichment">
          <MyoxusText>
            {t["com.myoxus.audio.enrichment.description"]()}
          </MyoxusText>
          {capability?.copilot ? (
            <EnrichmentActions
              block={block}
              busy={enriching}
              onAction={(button) => {
                focusTarget.current = button;
                returnActionFocus.current =
                  button.ownerDocument.activeElement === button;
              }}
            />
          ) : (
            <MyoxusText>
              {t["com.myoxus.audio.enrichment.unavailable"]()}
            </MyoxusText>
          )}
          {(enrichmentError || enrichment?.status === AiJobStatus.Failed) && (
            <MyoxusText tone="danger" role="alert">
              {t["com.myoxus.audio.enrichment.failed"]()}
            </MyoxusText>
          )}
          {enrichment?.summary && (
            <Stack>
              <MyoxusText>
                {t["com.myoxus.audio.enrichment.summary"]()}
              </MyoxusText>
              {enrichment.summary
                .split("\n")
                .filter(Boolean)
                .map((line, index) => (
                  <MyoxusText key={index}>{line}</MyoxusText>
                ))}
            </Stack>
          )}
          {enrichment?.actions && (
            <Stack>
              <MyoxusText>
                {t["com.myoxus.journal.template.section.action-items"]()}
              </MyoxusText>
              {enrichment.actions
                .split("\n")
                .filter(Boolean)
                .map((line, index) => (
                  <MyoxusText key={index}>{line}</MyoxusText>
                ))}
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
};

const useAttachmentMediaBlock = (model: AttachmentBlockModel) => {
  const service = useService(AudioAttachmentService);
  const [block, setBlock] = useState<AudioAttachmentBlock>();
  useEffect(() => {
    if (!model.props.sourceId) return;
    const ref = service.get(model);
    if (!ref) return;
    setBlock(ref.obj);
    ref.obj.mount();
    return () => {
      ref.obj.unmount();
      ref.release();
    };
  }, [service, model, model.props.sourceId]);
  return block;
};

export const AudioBlockEmbedded = ({ model }: AttachmentViewerProps) => {
  const block = useAttachmentMediaBlock(model);
  const transcription = useLiveData(block?.transcriptionBlock$);
  const expanded = useLiveData(block?.expanded$);
  return (
    <Stack data-myoxus-ui-role="attachment-audio-block">
      {block && <AttachmentAudioPlayer block={block} />}
      {transcription && expanded && (
        <TranscriptionBlock block={transcription} />
      )}
    </Stack>
  );
};
