// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, type PointerEvent } from "react";

/** Prepare before mousedown: a draggable ancestor otherwise wins over native text selection. */
export function useAttachmentTextSelection() {
  const restore = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => restore.current?.(), []);

  const prepare = (event: PointerEvent<HTMLElement>) => {
    const attachment = event.currentTarget.closest<HTMLElement>(
      "myoxus-attachment, myoxus-edgeless-attachment",
    );
    if (!attachment?.draggable) return;
    restore.current?.();
    attachment.draggable = false;
    restore.current = () => {
      if (attachment.isConnected) attachment.draggable = true;
      restore.current = undefined;
    };
  };

  return {
    onPointerEnter: prepare,
    onPointerLeave: () => restore.current?.(),
    onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
      event.stopPropagation();
      prepare(event);
    },
  };
}
