// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import { useLiveData, useService } from "@myoxus/infra";
import { Box, Modal } from "@myoxus/ui-facade";
import {
  createContext,
  forwardRef,
  type PropsWithChildren,
  useContext,
  useEffect,
} from "react";

import { EditorSettingService } from "../../editor-setting";
import type { PeekViewAnimation, PeekViewMode } from "../entities/peek-view";

// Context so nested surfaces can detect whether they are hosted inside a peek modal.
export const PeekViewContext = createContext<Record<string, never> | null>(
  null,
);

const emptyContext = {};

export const useInsidePeekView = () => {
  const context = useContext(PeekViewContext);
  return !!context;
};

export type PeekViewModalContainerProps = PropsWithChildren<{
  onOpenChange: (open: boolean) => void;
  open: boolean;
  target?: HTMLElement;
  controls?: React.ReactNode;
  onAnimationStart?: () => void;
  onAnimationEnd?: () => void;
  mode?: PeekViewMode;
  animation?: PeekViewAnimation;
  testId?: string;
  /** Whether to apply shadow & bg */
  dialogFrame?: boolean;
}>;

export const PeekViewModalContainer = forwardRef<
  HTMLDivElement,
  PeekViewModalContainerProps
>(function PeekViewModalContainer(
  {
    onOpenChange,
    open,
    controls,
    children,
    onAnimationEnd,
    mode = "fit",
    testId = "peek-view-modal",
    dialogFrame = true,
  },
  ref,
) {
  const editorSettings = useService(EditorSettingService).editorSetting;
  const fullWidthLayout = useLiveData(
    editorSettings.settings$.selector((s) => s.fullWidthLayout),
  );

  useEffect(() => {
    if (open) {
      onAnimationEnd?.();
    }
  }, [onAnimationEnd, open]);

  const isFull = mode === "full";
  const width = isFull
    ? "100vw"
    : mode === "max"
      ? "calc(100vw - var(--mantine-spacing-2xl) * 2 - var(--mantine-spacing-md))"
      : "min(90vw, 80rem)";
  const height = isFull
    ? "100dvh"
    : mode === "max"
      ? "calc(100dvh - var(--mantine-spacing-2xl))"
      : "90dvh";

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      const ownModal = document.querySelector(
        `[data-testid="${CSS.escape(testId)}"]`,
      );
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const hasNestedDialog = dialogs.some(
        (dialog) => dialog !== ownModal && !dialog.contains(ownModal),
      );
      const hasNestedOverlay = Boolean(
        document.querySelector(
          '[role="menu"], [role="listbox"], [data-myoxus-ui-role="slash-menu"]',
        ),
      );
      if (hasNestedDialog || hasNestedOverlay) {
        return;
      }
    }
    onOpenChange(nextOpen);
  };

  return (
    <PeekViewContext.Provider value={emptyContext}>
      <Modal
        open={open}
        onOpenChange={handleOpenChange}
        onExitTransitionEnd={onAnimationEnd}
        withoutCloseButton
        returnFocus={false}
        fullScreen={isFull}
        width={width}
        height={height}
        contentWrapperStyle={{
          overflow: "visible",
          ...(dialogFrame
            ? undefined
            : { background: "transparent", boxShadow: "none" }),
        }}
        contentOptions={{
          "data-testid": testId,
          bodyPadding: "none",
          bodyOverflow: "visible",
          style: dialogFrame
            ? undefined
            : { background: "transparent", boxShadow: "none" },
        }}
      >
        <Box
          ref={ref}
          data-mode={mode}
          data-peek-view-wrapper
          data-full-width-layout={fullWidthLayout ? "true" : undefined}
          data-dialog-frame={dialogFrame ? "true" : undefined}
          h="100%"
          pos="relative"
          w="100%"
        >
          <Box
            data-myoxus-ui-role="peek-view-modal-content-sizer"
            h="100%"
            style={{
              overflow: "hidden",
              borderRadius: dialogFrame ? "var(--mantine-radius-lg)" : 0,
            }}
          >
            {children}
          </Box>
          {controls ? (
            <Box data-myoxus-ui-role="peek-view-modal-controls">{controls}</Box>
          ) : null}
        </Box>
      </Modal>
    </PeekViewContext.Provider>
  );
});
