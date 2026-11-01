// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared Mantine Modal frame and modal-scope contract.
 *
 * Product dialogs own their data and actions. This module owns the portal,
 * focus, close, scroll and semantic typography behavior.
 */
import {
  Box,
  Group,
  Modal as MantineModal,
  ModalStackContext,
  ScrollArea,
  type ScrollAreaAutosizeProps,
  Stack,
} from "@mantine/core";
import {
  closeConfirmDialog,
  closePromptDialog,
  type DialogButtonOptions,
  openConfirmDialog,
  openPromptDialog,
  setConfirmDialogOpen,
  setPromptDialogOpen,
  subscribeConfirmDialog,
  subscribePromptDialog,
} from "@myoxus/dialogs";
import { cssVar, themeToVar } from "@myoxus/theme";
import { useI18n } from "@myoxus/i18n";
import {
  createContext,
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { MyoxusButton, type MyoxusButtonProps } from "./button";
import { CARD_PADDING_BY_SIZE, type CardPadding } from "./card-padding";
import { Divider } from "./divider";
import { reactNodeText } from "./helpers/accessibility";
import type { RoleBoxProps } from "./helpers/ui-role";
import { Input, type MyoxusInputProps } from "./input";
import { MyoxusText } from "./typography";
import "./modal.css";

export type ModalProps = PropsWithChildren<{
  /** Registers related dialogs with ModalStack for native layering and focus. */
  stackId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  maxHeight?: CSSProperties["maxHeight"];
  minHeight?: CSSProperties["minHeight"];
  contentOptions?: HTMLAttributes<HTMLDivElement> & {
    bodyOverflow?: CSSProperties["overflow"];
    bodyPadding?: CardPadding;
    style?: CSSProperties;
    surface?: "default" | "secondary";
    "data-testid"?: string;
  };
  withoutCloseButton?: boolean;
  closeButtonOptions?: DialogButtonOptions;
  headerClassName?: string;
  descriptionClassName?: string;
  persistent?: boolean;
  portalOptions?: unknown;
  overlayOptions?: HTMLAttributes<HTMLDivElement> & {
    style?: CSSProperties;
    "data-testid"?: string;
  };
  contentWrapperClassName?: string;
  contentWrapperStyle?: CSSProperties;
  animation?: "fadeScaleTop" | "none" | "slideBottom" | "slideRight";
  fullScreen?: boolean;
  /** Preserve an immersive work surface behind a nested stacked form. Native
   * ModalStack still owns top-only input, Escape, overlays and focus trapping. */
  keepVisibleInStack?: boolean;
  disableAutoFocus?: boolean;
  modal?: boolean;
  /**
   * Keeps long dialog content within the viewport by delegating scrolling to
   * Mantine's autosizing ScrollArea instead of requiring product-owned sizing.
   */
  scrollable?: boolean;
  /** Runs after Mantine has removed the closing dialog and released focus. */
  onExitTransitionEnd?: () => void;
  /** Marks or handles Escape before an embedding editor observes the event. */
  onEscape?: (event: KeyboardEvent) => void;
  /**
   * Durable focus target for dialogs opened from transient menu items. Mantine
   * still owns trapping and Escape handling; the target is focused only after
   * the exit transition has removed the dialog.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Native focus return; disable when handing focus directly to another modal.
   * Also suppresses the optional durable returnFocusRef in that handoff. */
  returnFocus?: boolean;
}>;

export type ModalOpenCleanup = (() => void) | undefined;

export interface ModalConfig {
  /**
   * Global mobile hook invoked when a modal opens; used by keyboard and swipe
   * orchestration without keeping those flows tied to the retired component root.
   */
  onOpen?: () => ModalOpenCleanup;
  dynamicKeyboardHeight?: string | number;
}

export const ModalConfigContext = createContext<ModalConfig>({});
export const InsideModalContext = createContext<string | undefined>(undefined);
export const ModalStack = MantineModal.Stack;

export function useIsInsideModal() {
  return useModalPortalTarget() !== undefined;
}

/** The native modal root keeps select portals outside its clipping scroll area. */
export function useModalPortalTarget() {
  return useContext(InsideModalContext);
}

const ModalScrollArea = forwardRef<HTMLDivElement, ScrollAreaAutosizeProps>(
  function ModalScrollArea(props, ref) {
    return (
      <ScrollArea.Autosize
        {...props}
        ref={ref}
        type="auto"
        styles={{ content: { minWidth: 0, width: "100%" } }}
      />
    );
  },
);

export function Modal({
  stackId,
  open,
  onOpenChange,
  title,
  description,
  children,
  width,
  height,
  maxHeight,
  minHeight,
  contentOptions,
  withoutCloseButton,
  closeButtonOptions,
  headerClassName,
  descriptionClassName,
  persistent,
  fullScreen,
  keepVisibleInStack,
  overlayOptions,
  contentWrapperClassName,
  contentWrapperStyle,
  modal: _modal,
  scrollable = false,
  onExitTransitionEnd,
  onEscape,
  returnFocusRef,
  returnFocus,
}: ModalProps) {
  const t = useI18n();
  // Global confirmations and their owner can live in separate React branches.
  // Register every frame so Mantine owns their open order and focus trapping.
  const modalId = useId();
  const resolvedStackId = stackId ?? modalId;
  const stack = useContext(ModalStackContext);
  const latestStack = useRef(stack);
  latestStack.current = stack;
  useEffect(
    () => () => {
      // Workspace dialogs can unmount while still open. Mantine removes IDs on
      // opened=false only; release this ID so its owner can regain focus/input.
      latestStack.current?.removeModal(resolvedStackId);
    },
    [resolvedStackId],
  );
  // Mantine's stack compares numeric z-indices and ignores CSS var strings.
  // Materialize the server role so stacking does not fall below object popovers.
  const modalLayer =
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement)
          .getPropertyValue(themeToVar("zIndexModal"))
          .trim();
  const modalZIndex =
    modalLayer && Number.isFinite(Number(modalLayer))
      ? Number(modalLayer)
      : cssVar("zIndexModal");
  const { onOpen: modalConfigOnOpen } = useContext(ModalConfigContext);
  const contentTestId = (
    contentOptions as Record<string, unknown> | undefined
  )?.["data-testid"] as string | undefined;
  const {
    display: contentDisplay,
    overflow: contentOverflow,
    padding: contentPadding,
    ...contentContainerStyle
  } = contentOptions?.style ?? {};
  const contentBodyOverflow = contentOptions?.bodyOverflow ?? contentOverflow;
  const contentBodyPadding = contentOptions?.bodyPadding
    ? CARD_PADDING_BY_SIZE[contentOptions.bodyPadding]
    : contentPadding;
  const contentSurfaceBackground =
    contentOptions?.surface === "secondary"
      ? cssVar("backgroundSecondaryColor")
      : undefined;
  // Mantine bounds fullscreen content to the viewport; its body must pass
  // that constraint to split panes instead of growing with their contents.
  const hasConstrainedHeight =
    fullScreen ||
    height !== undefined ||
    maxHeight !== undefined ||
    minHeight !== undefined;
  const {
    className: overlayClassName,
    style: overlayStyle,
    ...overlayAttributes
  } = overlayOptions ?? {};
  const bodyStyle =
    hasConstrainedHeight ||
    contentDisplay ||
    contentBodyOverflow ||
    contentBodyPadding !== undefined
      ? {
          display: contentDisplay,
          overflow: contentBodyOverflow,
          padding: contentBodyPadding,
          ...(hasConstrainedHeight
            ? { flex: "1 1 0", minHeight: 0 }
            : undefined),
        }
      : undefined;
  const modalAccessibleName =
    typeof contentOptions?.["aria-label"] === "string"
      ? contentOptions["aria-label"]
      : (reactNodeText(title) ?? undefined);
  const modalContentAttributes = {
    attributes: {
      content: {
        "data-testid": contentTestId,
        "data-myoxus-modal-background": keepVisibleInStack || undefined,
        "data-myoxus-ui-role": "settings-modal",
        ...(modalAccessibleName ? { "aria-label": modalAccessibleName } : {}),
      },
      body: {
        "data-myoxus-ui-role": "settings-modal-container",
      },
      header: {
        "data-myoxus-ui-role": "settings-modal-header",
        role: "presentation",
      },
      close: {
        "data-myoxus-ui-role": "button:icon-only:28",
      },
      inner: {
        "data-myoxus-ui-role": "settings-modal-inner",
      },
      overlay: {
        ...overlayAttributes,
      },
    },
  } as Record<string, unknown>;
  const closeButtonProps = {
    "aria-label": t["com.myoxus.peek-view-controls.close"](),
    "data-myoxus-ui-role": "button:icon-only:28",
    ...closeButtonOptions,
  } as Record<string, unknown>;

  useEffect(() => {
    if (!open) return;
    return modalConfigOnOpen?.();
  }, [modalConfigOnOpen, open]);

  return (
    <InsideModalContext.Provider
      value={`[data-myoxus-modal-portal="${modalId}"]`}
    >
      <MantineModal
        {...modalContentAttributes}
        stackId={resolvedStackId}
        zIndex={modalZIndex}
        opened={!!open}
        returnFocus={returnFocus}
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") onEscape?.(event.nativeEvent);
        }}
        onExitTransitionEnd={() => {
          if (returnFocus !== false) returnFocusRef?.current?.focus();
          onExitTransitionEnd?.();
        }}
        onClose={() => {
          if (persistent) return;
          closeButtonOptions?.onClick?.(
            undefined as unknown as Parameters<
              NonNullable<DialogButtonOptions["onClick"]>
            >[0],
          );
          onOpenChange?.(false);
        }}
        title={title}
        size={width}
        withCloseButton={!withoutCloseButton}
        closeButtonProps={closeButtonProps}
        fullScreen={fullScreen}
        scrollAreaComponent={scrollable ? ModalScrollArea : undefined}
        styles={{
          content: {
            backgroundColor: contentSurfaceBackground,
            ...(hasConstrainedHeight
              ? { display: "flex", flexDirection: "column" }
              : undefined),
            height,
            maxHeight,
            minHeight,
            ...contentWrapperStyle,
            ...contentContainerStyle,
          },
          body: bodyStyle,
          overlay: overlayStyle,
          header: title
            ? scrollable
              ? {
                  position: "sticky",
                  top: 0,
                  zIndex: 2,
                }
              : undefined
            : {
                position: "absolute",
                top: "var(--mantine-spacing-sm)",
                right: "var(--mantine-spacing-sm)",
                zIndex: 2,
                minHeight: 0,
                padding: 0,
                background: "transparent",
              },
          close: title
            ? undefined
            : {
                position: "static",
              },
        }}
        classNames={{
          content: contentWrapperClassName,
          body: contentOptions?.className,
          header: headerClassName,
          overlay: overlayClassName,
        }}
        data-myoxus-ui-role="settings-modal-root"
        data-myoxus-modal-portal={modalId}
      >
        {description ? (
          <MyoxusText
            component="div"
            className={descriptionClassName}
            italic
            mb={"var(--mantine-spacing-md)"}
            tone="secondary"
            typographySlot="body"
            data-myoxus-ui-role="settings-modal-description"
          >
            {description}
          </MyoxusText>
        ) : null}
        {children}
      </MantineModal>
    </InsideModalContext.Provider>
  );
}

export function DialogFooterActions({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "dialog-footer-actions",
  ...props
}: RoleBoxProps) {
  return (
    <Group
      {...props}
      align="center"
      gap={"var(--mantine-spacing-sm)"}
      justify="flex-end"
      wrap="wrap"
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {children}
    </Group>
  );
}

export function DialogFooter({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "dialog-footer",
  ...props
}: RoleBoxProps) {
  return (
    <Box
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        background: cssVar("backgroundSecondaryColor"),
        borderTop: `calc(var(--mantine-scale) * 1px) solid ${cssVar(
          "borderColor",
        )}`,
        display: "flex",
        flex: "0 0 auto",
        flexWrap: "wrap",
        gap: "var(--mantine-spacing-md)",
        justifyContent: "space-between",
        padding: "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export type OpenConfirmModalOptions = {
  autoClose?: boolean;
  onSuccess?: () => void;
};

export interface ConfirmModalProps extends ModalProps {
  customConfirmButton?: () => ReactNode;
  confirmButtonOptions?: MyoxusButtonProps;
  childrenContentClassName?: string;
  /**
   * Successful confirm actions close by default so product callers only need to
   * model the actual mutation. Long-running or retry-in-place dialogs can opt
   * out and manage their own open state.
   */
  closeOnConfirm?: boolean;
  onConfirm?: (() => void) | (() => Promise<void>);
  onCancel?: (() => void) | false;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  cancelButtonOptions?: MyoxusButtonProps;
  reverseFooter?: boolean;
  rowFooter?: boolean;
  autoFocusConfirm?: boolean;
}

export function useConfirmModal(): {
  openConfirmModal: (
    props?: ConfirmModalProps,
    options?: OpenConfirmModalOptions,
  ) => void;
  closeConfirmModal: () => void;
} {
  return {
    openConfirmModal: openConfirmDialog as (
      props?: ConfirmModalProps,
      options?: OpenConfirmModalOptions,
    ) => void,
    closeConfirmModal: closeConfirmDialog,
  };
}

export function ConfirmModalProvider({ children }: PropsWithChildren) {
  const openerRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(false);
  const [modalProps, setModalProps] = useState<ConfirmModalProps>({
    open: false,
  });

  useEffect(() => {
    return subscribeConfirmDialog((props) => {
      // Stack reactivation can focus the owner's first control before Mantine
      // returns focus. Retain the actual opener until the exit transition ends.
      if (props.open && !openRef.current) {
        openerRef.current = document.activeElement as HTMLElement | null;
      }
      openRef.current = !!props.open;
      setModalProps(props as ConfirmModalProps);
    });
  }, []);

  return (
    <ModalStack>
      {children}
      <ConfirmModal
        {...modalProps}
        returnFocusRef={modalProps.returnFocusRef ?? openerRef}
        onOpenChange={setConfirmDialogOpen}
      />
    </ModalStack>
  );
}

export function ConfirmModal({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmText,
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  confirmButtonOptions,
  cancelButtonOptions,
  customConfirmButton: CustomConfirmButton,
  childrenContentClassName,
  closeOnConfirm = true,
  width = "md",
  autoFocusConfirm = true,
  closeButtonOptions,
  reverseFooter = false,
  rowFooter: _rowFooter,
  ...modalProps
}: ConfirmModalProps) {
  const [confirming, setConfirming] = useState(false);
  const close = () => onOpenChange?.(false);
  const cancel = () => {
    if (confirming) {
      return;
    }
    if (onCancel !== false) onCancel?.();
    close();
  };
  const confirm = async () => {
    if (confirming) {
      return;
    }
    setConfirming(true);
    try {
      await onConfirm?.();
      if (closeOnConfirm) {
        close();
      }
    } catch (error) {
      console.error(error);
    } finally {
      setConfirming(false);
    }
  };
  const cancelAction =
    onCancel !== false ? (
      <MyoxusButton
        data-testid="confirm-modal-cancel"
        onClick={cancel}
        {...cancelButtonOptions}
        disabled={confirming || cancelButtonOptions?.disabled}
      >
        {cancelText}
      </MyoxusButton>
    ) : null;
  const confirmAction = CustomConfirmButton ? (
    CustomConfirmButton()
  ) : (
    <MyoxusButton
      data-testid="confirm-modal-confirm"
      variant="primary"
      data-autofocus={autoFocusConfirm || undefined}
      loading={confirming}
      onClick={() => {
        void confirm();
      }}
      {...confirmButtonOptions}
      disabled={confirming || confirmButtonOptions?.disabled}
    >
      {confirmText}
    </MyoxusButton>
  );
  return (
    <Modal
      {...modalProps}
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          onOpenChange?.(true);
          return;
        }
        cancel();
      }}
      title={title}
      description={description}
      width={width}
      closeButtonOptions={closeButtonOptions}
    >
      <Stack
        gap={"calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"}
      >
        {children ? (
          <Box className={childrenContentClassName}>{children}</Box>
        ) : null}
        {description || children ? <Divider /> : null}
        <DialogFooterActions>
          {reverseFooter ? confirmAction : cancelAction}
          {reverseFooter ? cancelAction : confirmAction}
        </DialogFooterActions>
      </Stack>
    </Modal>
  );
}

export type OpenPromptModalOptions = {
  autoClose?: boolean;
  onSuccess?: () => void;
};

export interface PromptModalProps extends ModalProps {
  confirmButtonOptions?: MyoxusButtonProps;
  onConfirm?: ((text: string) => void) | ((text: string) => Promise<void>);
  onCancel?: () => void;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  label?: ReactNode;
  defaultValue?: string;
  required?: boolean;
  cancelButtonOptions?: MyoxusButtonProps;
  inputOptions?: Omit<MyoxusInputProps, "value" | "onChange">;
  reverseFooter?: boolean;
  autoFocusConfirm?: boolean;
}

export function usePromptModal(): {
  openPromptModal: (
    props?: PromptModalProps,
    options?: OpenPromptModalOptions,
  ) => void;
  closePromptModal: () => void;
} {
  return {
    openPromptModal: openPromptDialog as (
      props?: PromptModalProps,
      options?: OpenPromptModalOptions,
    ) => void,
    closePromptModal: closePromptDialog,
  };
}

export function PromptModalProvider({ children }: PropsWithChildren) {
  const [modalProps, setModalProps] = useState<PromptModalProps>({
    open: false,
  });

  useEffect(() => {
    return subscribePromptDialog((props) => {
      setModalProps(props as PromptModalProps);
    });
  }, []);

  return (
    <>
      {children}
      <PromptModal {...modalProps} onOpenChange={setPromptDialogOpen} />
    </>
  );
}

export function PromptModal({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmButtonOptions,
  confirmText,
  cancelText = "Cancel",
  cancelButtonOptions,
  onConfirm,
  onCancel,
  label,
  required = true,
  inputOptions,
  defaultValue,
  reverseFooter,
  width = "md",
  autoFocusConfirm = true,
  ...modalProps
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue ?? "");
  const inputDataTestId = (
    inputOptions as Record<string, unknown> | undefined
  )?.["data-testid"] as string | undefined;

  useEffect(() => {
    if (open) setValue(defaultValue ?? "");
  }, [defaultValue, open]);

  const close = () => onOpenChange?.(false);
  const cancel = () => {
    onCancel?.();
    close();
  };

  const cancelAction = (
    <MyoxusButton
      data-testid="prompt-modal-cancel"
      onClick={cancel}
      {...cancelButtonOptions}
    >
      {cancelText}
    </MyoxusButton>
  );
  const confirmAction = (
    <MyoxusButton
      data-testid="prompt-modal-confirm"
      variant="primary"
      disabled={required && !value}
      autoFocus={autoFocusConfirm}
      onClick={() => {
        Promise.resolve(onConfirm?.(value))
          .then(() => setValue(""))
          .catch(console.error);
      }}
      {...confirmButtonOptions}
    >
      {confirmText}
    </MyoxusButton>
  );

  return (
    <Modal
      {...modalProps}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) cancel();
      }}
      title={title}
      description={description}
      width={width}
    >
      <Stack
        gap={"calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"}
      >
        <Input
          {...inputOptions}
          label={label}
          value={value}
          onChange={setValue}
          autoFocus={inputOptions?.autoFocus ?? true}
          data-testid={inputDataTestId ?? "prompt-modal-input"}
        />
        {children}
        <Divider />
        <DialogFooterActions>
          {reverseFooter ? confirmAction : cancelAction}
          {reverseFooter ? cancelAction : confirmAction}
        </DialogFooterActions>
      </Stack>
    </Modal>
  );
}
