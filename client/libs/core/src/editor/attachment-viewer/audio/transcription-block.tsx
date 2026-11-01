import { LitTranscriptionBlock } from "@myoxus/core/editor/ai/blocks/ai-chat-block/ai-transcription-block";
import type { TranscriptionBlockModel } from "@myoxus/core/editor/ai/blocks/transcription-block/model";
import { LiveData, useLiveData } from "@myoxus/infra";
import { createReactComponentFromLit } from "@myoxus/lit-react";
import React, { useCallback, useMemo } from "react";

const AdaptedTranscriptionBlock = createReactComponentFromLit({
  react: React,
  elementClass: LitTranscriptionBlock,
});

export const TranscriptionBlock = ({
  block,
}: {
  block: TranscriptionBlockModel;
}) => {
  const childMap$ = useMemo(
    () => LiveData.fromSignal(block.childMap),
    [block.childMap],
  );
  const childMap = useLiveData(childMap$);
  const onDragStart = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);
  if (childMap.size === 0) {
    return null;
  }
  return (
    <div
      data-myoxus-ui-role="attachment-audio-transcription"
      // draggable + onDragStart to blacklist virgultum's default drag behavior for attachment block
      draggable="true"
      onDragStart={onDragStart}
    >
      <AdaptedTranscriptionBlock blockId={block.id} />
    </div>
  );
};
