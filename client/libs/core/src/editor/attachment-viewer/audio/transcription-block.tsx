import type { TranscriptionBlockModel } from "@myoxus/core/editor/ai/blocks/transcription-block/model";
import { LiveData, useLiveData } from "@myoxus/infra";
import React, { useCallback, useMemo } from "react";

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
      {React.createElement("transcription-block", {
        "data-block-id": block.id,
      })}
    </div>
  );
};
