// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared Mantine Modal frame and `@mantine/modals`-backed confirm/prompt layer.
 *
 * Product dialogs own their data and actions. This module owns the portal,
 * stack z-index, focus return, close, scroll, type-to-confirm and semantic
 * typography behavior for both declarative (`Modal`, `ConfirmModal`,
 * `PromptModal`) and imperative (`useConfirmModal`, `usePromptModal`) dialogs.
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
import { modals } from "@mantine/modals";
import { useI18n } from "@myoxus/i18n";
import { cssVar, themeToVar } from "@myoxus/theme";
import {
  type ButtonHTMLAttributes,
  createContext,
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type KeyboardEventHandler,
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
import {
  InsideModalContext,
  useIsInsideModal,
  useModalPortalTarget,
} from "./helpers/modal-context";
import type { RoleBoxProps } from "./helpers/ui-role";
import { Input, type MyoxusInputProps } from "./input";
import { MyoxusText } from "./typography";
import "./modal.css";

export type DialogButtonOptions = ButtonHTMLAttributes<HTMLButtonElement> & {
  [key: `data-${string}`]: unknown;
  autoFocus?: boolean;
  block?: boolean;
  disabled?: boolean;
  loading?: boolean;
  variant?: string;
};

export type DialogInputOptions = Omit<
  HTMLAttributes<HTMLInputElement>,
  "onChange"
> & {
  [key: `data-${string}`]: unknown;
  autoFocus?: boolean;
  className?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  placeholder?: string;
  status?: string;
};

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
export { InsideModalContext, useIsInsideModal, useModalPortalTarget };
export const ModalStack = MantineModal.Stack;

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

/**
 * Materializes the server-owned modal z-index token as a number when possible
 * so Mantine's ModalStack can compare numeric layers instead of ignoring CSS
 * `var(...)` strings.
 */
function resolveModalZIndex(): number | string {
  const modalLayer =
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement)
          .getPropertyValue(themeToVar("zIndexModal"))
          .trim();
  return modalLayer && Number.isFinite(Number(modalLayer))
    ? Number(modalLayer)
    : cssVar("zIndexModal");
}

function buildModalFrameProps({
  closeLabel,
  closeButtonOptions,
  contentOptions,
  contentWrapperClassName,
  contentWrapperStyle,
  fullScreen,
  headerClassName,
  height,
  keepVisibleInStack,
  maxHeight,
  minHeight,
  modalId,
  overlayOptions,
  scrollable,
  title,
  width,
  withoutCloseButton,
}: {
  closeLabel: string;
  closeButtonOptions?: DialogButtonOptions;
  contentOptions?: ModalProps["contentOptions"];
  contentWrapperClassName?: string;
  contentWrapperStyle?: CSSProperties;
  fullScreen?: boolean;
  headerClassName?: string;
  height?: CSSProperties["height"];
  keepVisibleInStack?: boolean;
  maxHeight?: CSSProperties["maxHeight"];
  minHeight?: CSSProperties["minHeight"];
  modalId: string;
  overlayOptions?: ModalProps["overlayOptions"];
  scrollable?: boolean;
  title?: ReactNode;
  width?: CSSProperties["width"];
  withoutCloseButton?: boolean;
}) {
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
  const attributes = {
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
  };
  const closeButtonProps = {
    "aria-label": closeLabel,
    "data-myoxus-ui-role": "button:icon-only:28",
    ...closeButtonOptions,
  } as Record<string, unknown>;

  return {
    attributes,
    title,
    size: width,
    withCloseButton: !withoutCloseButton,
    closeButtonProps,
    fullScreen,
    scrollAreaComponent: scrollable ? ModalScrollArea : undefined,
    zIndex: resolveModalZIndex(),
    styles: {
      content: {
        backgroundColor: contentSurfaceBackground,
        ...(hasConstrainedHeight
          ? { display: "flex", flexDirection: "column" as const }
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
              position: "sticky" as const,
              top: 0,
              zIndex: 2,
            }
          : undefined
        : {
            position: "absolute" as const,
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
            position: "static" as const,
          },
    },
    classNames: {
      content: contentWrapperClassName,
      body: contentOptions?.className,
      header: headerClassName,
      overlay: overlayClassName,
    },
    "data-myoxus-ui-role": "settings-modal-root",
    "data-myoxus-modal-portal": modalId,
  };
}

function ModalDescription({
  description,
  className,
}: {
  description?: ReactNode;
  className?: string;
}) {
  if (!description) return null;
  return (
    <MyoxusText
      component="div"
      className={className}
      italic
      mb={"var(--mantine-spacing-md)"}
      tone="secondary"
      typographySlot="body"
      data-myoxus-ui-role="settings-modal-description"
    >
      {description}
    </MyoxusText>
  );
}

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
  const { onOpen: modalConfigOnOpen } = useContext(ModalConfigContext);
  const frameProps = buildModalFrameProps({
    closeLabel: t["com.myoxus.peek-view-controls.close"](),
    closeButtonOptions,
    contentOptions,
    contentWrapperClassName,
    contentWrapperStyle,
    fullScreen,
    headerClassName,
    height,
    keepVisibleInStack,
    maxHeight,
    minHeight,
    modalId,
    overlayOptions,
    scrollable,
    title,
    width,
    withoutCloseButton,
  });

  useEffect(() => {
    if (!open) return;
    return modalConfigOnOpen?.();
  }, [modalConfigOnOpen, open]);

  return (
    <InsideModalContext.Provider
      value={`[data-myoxus-modal-portal="${modalId}"]`}
    >
      <MantineModal
        {...(frameProps as Record<string, unknown>)}
        stackId={resolvedStackId}
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
      >
        <ModalDescription
          description={description}
          className={descriptionClassName}
        />
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
  /** Marks the action as destructive, styling the confirm button with `error`. */
  danger?: boolean;
  /**
   * Requires the user to enter this exact string before confirmation is enabled.
   * The input value resets whenever the dialog opens or closes.
   */
  confirmMatchText?: string;
  /** Placeholder for the type-to-confirm input when `confirmMatchText` is set. */
  confirmMatchPlaceholder?: string;
  onConfirm?: (() => void) | (() => Promise<void>);
  onCancel?: (() => void) | false;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  cancelButtonOptions?: MyoxusButtonProps;
  reverseFooter?: boolean;
  rowFooter?: boolean;
  autoFocusConfirm?: boolean;
}

interface ConfirmModalBodyProps {
  open: boolean;
  description?: ReactNode;
  children?: ReactNode;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  danger?: boolean;
  confirmMatchText?: string;
  confirmMatchPlaceholder?: string;
  onConfirm?: (() => void) | (() => Promise<void>);
  onCancel?: (() => void) | false;
  confirmButtonOptions?: MyoxusButtonProps;
  cancelButtonOptions?: MyoxusButtonProps;
  customConfirmButton?: () => ReactNode;
  childrenContentClassName?: string;
  closeOnConfirm: boolean;
  autoFocusConfirm: boolean;
  reverseFooter: boolean;
  onSuccess?: () => void;
  onRequestClose: (reason: "cancel" | "confirmed") => void;
  onConfirmingChange?: (confirming: boolean) => void;
}

function ConfirmModalBody({
  open,
  description,
  children,
  confirmText,
  cancelText,
  danger = false,
  confirmMatchText,
  confirmMatchPlaceholder,
  onConfirm,
  onCancel,
  confirmButtonOptions,
  cancelButtonOptions,
  customConfirmButton: CustomConfirmButton,
  childrenContentClassName,
  closeOnConfirm,
  autoFocusConfirm,
  reverseFooter,
  onSuccess,
  onRequestClose,
  onConfirmingChange,
}: ConfirmModalBodyProps) {
  const t = useI18n();
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const [matchInput, setMatchInput] = useState("");
  const requiresTypedMatch = confirmMatchText !== undefined;
  const typedMatchSatisfied =
    !requiresTypedMatch ||
    (confirmMatchText.length > 0 && matchInput === confirmMatchText);

  useEffect(() => {
    if (!open) {
      setMatchInput("");
    }
  }, [open]);

  const setConfirmingState = (next: boolean) => {
    confirmingRef.current = next;
    setConfirming(next);
    onConfirmingChange?.(next);
  };

  const cancel = () => {
    if (confirmingRef.current) return;
    onRequestClose("cancel");
  };

  const confirm = async () => {
    if (confirmingRef.current || !typedMatchSatisfied) return;
    setConfirmingState(true);
    try {
      await onConfirm?.();
      onSuccess?.();
      if (closeOnConfirm) {
        onRequestClose("confirmed");
      }
    } catch (error) {
      console.error(error);
    } finally {
      setConfirmingState(false);
    }
  };

  const resolvedCancelText = cancelText ?? t["Cancel"]();
  const effectiveAutoFocusConfirm = requiresTypedMatch
    ? false
    : autoFocusConfirm;

  const cancelAction =
    onCancel !== false ? (
      <MyoxusButton
        data-testid="confirm-modal-cancel"
        onClick={cancel}
        {...cancelButtonOptions}
        disabled={confirming || cancelButtonOptions?.disabled}
      >
        {resolvedCancelText}
      </MyoxusButton>
    ) : null;

  const confirmAction = CustomConfirmButton ? (
    CustomConfirmButton()
  ) : (
    <MyoxusButton
      data-testid="confirm-modal-confirm"
      variant={danger ? "error" : "primary"}
      data-autofocus={effectiveAutoFocusConfirm || undefined}
      loading={confirming}
      onClick={() => {
        void confirm();
      }}
      {...confirmButtonOptions}
      {...(danger ? { variant: "error" as const } : undefined)}
      disabled={
        confirming || !typedMatchSatisfied || confirmButtonOptions?.disabled
      }
    >
      {confirmText}
    </MyoxusButton>
  );

  return (
    <Stack gap={"calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"}>
      {children ? (
        <Box className={childrenContentClassName}>{children}</Box>
      ) : null}
      {requiresTypedMatch ? (
        <Input
          autoFocus
          data-autofocus
          type="text"
          value={matchInput}
          onChange={setMatchInput}
          placeholder={
            confirmMatchPlaceholder ??
            t["admin.common.type-to-confirm-placeholder"]()
          }
          data-testid="confirm-modal-type-input"
        />
      ) : null}
      {description || children || requiresTypedMatch ? <Divider /> : null}
      <DialogFooterActions>
        {reverseFooter ? confirmAction : cancelAction}
        {reverseFooter ? cancelAction : confirmAction}
      </DialogFooterActions>
    </Stack>
  );
}

let managedModalSequence = 0;
let latestCloseLabel = "Close";

function resolveCloseLabel(t?: ReturnType<typeof useI18n>): string {
  const fromHook = t?.["com.myoxus.peek-view-controls.close"];
  if (typeof fromHook === "function") return fromHook();
  return latestCloseLabel;
}

interface ManagedModalHandle {
  modalId: string;
  openerElement: HTMLElement | null;
  setSettled: () => void;
}

let activeConfirmHandle: ManagedModalHandle | null = null;
let activePromptHandle: ManagedModalHandle | null = null;

// Track managed confirm/prompt modals whose Escape dismissal must stay locked
// (either `persistent` or mid-flight `confirming`). Mantine's Modal.Stack
// overwrites `closeOnEscape` with `ctx.currentId === stackId`, so this guard
// intercepts Escape before ModalsProvider's window capture listener runs.
const lockedManagedModalEscapes = new Map<
  string,
  ((event: KeyboardEvent) => void) | undefined
>();

function setManagedModalEscapeLock(
  modalId: string,
  locked: boolean,
  onEscape?: (event: KeyboardEvent) => void,
) {
  if (locked) {
    lockedManagedModalEscapes.set(modalId, onEscape);
  } else {
    lockedManagedModalEscapes.delete(modalId);
  }
}

/**
 * Mounted inside `MyoxusUIProvider` right before `<ModalsProvider>` so its
 * capture-phase `keydown` listener runs ahead of Mantine's `useModal` Escape
 * handler while preserving nested `Modal.Stack` z-index and focus trapping.
 */
export function ManagedModalEscapeGuard() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (lockedManagedModalEscapes.size === 0) return;
      const active = document.activeElement;
      const target = event.target instanceof Node ? event.target : null;
      for (const [modalId, onEscape] of lockedManagedModalEscapes) {
        const portal = document.querySelector(
          `[data-myoxus-modal-portal="${modalId}"]`,
        );
        if (!portal) continue;
        // Only suppress Escape when this locked managed modal actually owns
        // focus (or no higher dialog owns focus).
        const ownsEvent =
          (target !== null && portal.contains(target)) ||
          (active !== null && portal.contains(active));
        if (!ownsEvent) continue;
        onEscape?.(event);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);
  return null;
}

function ManagedModalLifecycle({ children }: PropsWithChildren) {
  const modalConfig = useContext(ModalConfigContext);
  useEffect(() => modalConfig.onOpen?.(), [modalConfig]);
  return children;
}

function openManagedConfirmModal(
  props: ConfirmModalProps = {},
  options: OpenConfirmModalOptions = {},
) {
  const { autoClose = true, onSuccess } = options;
  const {
    title,
    description,
    children,
    confirmText,
    cancelText,
    danger,
    confirmMatchText,
    confirmMatchPlaceholder,
    onConfirm,
    onCancel,
    onOpenChange,
    confirmButtonOptions,
    cancelButtonOptions,
    customConfirmButton,
    childrenContentClassName,
    closeOnConfirm = true,
    width = "md",
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
    scrollable = false,
    onExitTransitionEnd,
    onEscape,
    returnFocusRef,
    returnFocus,
    reverseFooter = false,
    autoFocusConfirm = true,
    stackId: _stackId,
  } = props;

  // Stack reactivation can focus the owner's first control before Mantine
  // returns focus. Retain the actual opener until the exit transition ends;
  // when replacing an active managed modal, keep its original opener so focus
  // does not target the unmounting modal.
  const currentActiveElement =
    typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null;
  let openerElement = currentActiveElement;

  if (activeConfirmHandle) {
    const previous = activeConfirmHandle;
    activeConfirmHandle = null;
    if (previous.openerElement) {
      openerElement = previous.openerElement;
    }
    previous.setSettled();
    lockedManagedModalEscapes.delete(previous.modalId);
    modals.close(previous.modalId);
  }

  const modalId = `myoxus-confirm-modal-${++managedModalSequence}`;
  let settled = false;
  let confirming = false;
  const handle: ManagedModalHandle = {
    modalId,
    openerElement,
    setSettled: () => {
      settled = true;
    },
  };
  activeConfirmHandle = handle;
  setManagedModalEscapeLock(modalId, Boolean(persistent), onEscape);

  const frameProps = buildModalFrameProps({
    closeLabel: resolveCloseLabel(),
    closeButtonOptions,
    contentOptions,
    contentWrapperClassName,
    contentWrapperStyle,
    fullScreen,
    headerClassName,
    height,
    keepVisibleInStack,
    maxHeight,
    minHeight,
    modalId,
    overlayOptions,
    scrollable,
    title,
    width,
    withoutCloseButton,
  });

  const handleRequestClose = (reason: "cancel" | "confirmed") => {
    if (settled) return;
    settled = true;
    lockedManagedModalEscapes.delete(modalId);
    if (activeConfirmHandle === handle) {
      activeConfirmHandle = null;
    }
    if (reason === "cancel" && onCancel !== false) {
      onCancel?.();
    }
    onOpenChange?.(false);
    modals.close(modalId);
  };

  modals.open({
    ...(frameProps as Record<string, unknown>),
    modalId,
    closeOnClickOutside: !persistent,
    closeOnEscape: !persistent,
    returnFocus,
    onKeyDownCapture: (event) => {
      if (event.key === "Escape") onEscape?.(event.nativeEvent);
    },
    onExitTransitionEnd: () => {
      if (returnFocus !== false) {
        (returnFocusRef?.current ?? openerElement)?.focus();
      }
      onExitTransitionEnd?.();
    },
    onClose: () => {
      lockedManagedModalEscapes.delete(modalId);
      if (activeConfirmHandle === handle) {
        activeConfirmHandle = null;
      }
      if (!settled) {
        settled = true;
        if (!confirming && onCancel !== false) {
          onCancel?.();
        }
        onOpenChange?.(false);
      }
    },
    children: (
      <ManagedModalLifecycle>
        <InsideModalContext.Provider
          value={`[data-myoxus-modal-portal="${modalId}"]`}
        >
          <ModalDescription
            description={description}
            className={descriptionClassName}
          />
          <ConfirmModalBody
            open
            description={description}
            confirmText={confirmText}
            cancelText={cancelText}
            danger={danger}
            confirmMatchText={confirmMatchText}
            confirmMatchPlaceholder={confirmMatchPlaceholder}
            onConfirm={onConfirm}
            onCancel={onCancel}
            confirmButtonOptions={confirmButtonOptions}
            cancelButtonOptions={cancelButtonOptions}
            customConfirmButton={customConfirmButton}
            childrenContentClassName={childrenContentClassName}
            closeOnConfirm={autoClose && closeOnConfirm}
            autoFocusConfirm={autoFocusConfirm}
            reverseFooter={reverseFooter}
            onSuccess={() => {
              if (!settled) onSuccess?.();
            }}
            onRequestClose={handleRequestClose}
            onConfirmingChange={(next) => {
              confirming = next;
              if (!settled) {
                setManagedModalEscapeLock(
                  modalId,
                  Boolean(persistent) || next,
                  onEscape,
                );
                modals.updateModal({
                  modalId,
                  closeOnClickOutside: !persistent && !next,
                  closeOnEscape: !persistent && !next,
                  withCloseButton: !withoutCloseButton && !next,
                });
              }
            }}
          >
            {children}
          </ConfirmModalBody>
        </InsideModalContext.Provider>
      </ManagedModalLifecycle>
    ),
  });
}

function closeManagedConfirmModal() {
  if (!activeConfirmHandle) return;
  const current = activeConfirmHandle;
  activeConfirmHandle = null;
  current.setSettled();
  lockedManagedModalEscapes.delete(current.modalId);
  modals.close(current.modalId);
}

export function useConfirmModal(): {
  openConfirmModal: (
    props?: ConfirmModalProps,
    options?: OpenConfirmModalOptions,
  ) => void;
  closeConfirmModal: () => void;
} {
  const t = useI18n();
  const closeLabel = resolveCloseLabel(t);
  useEffect(() => {
    latestCloseLabel = closeLabel;
  }, [closeLabel]);
  return {
    openConfirmModal: openManagedConfirmModal,
    closeConfirmModal: closeManagedConfirmModal,
  };
}

/**
 * Retained compatibility pass-through. `MyoxusUIProvider` owns the single
 * `<Modal.Stack>` and `<ModalsProvider>` host for all managed dialogs.
 */
export function ConfirmModalProvider({ children }: PropsWithChildren) {
  return children;
}

export function ConfirmModal({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmText,
  cancelText,
  danger = false,
  confirmMatchText,
  confirmMatchPlaceholder,
  onConfirm,
  onCancel,
  confirmButtonOptions,
  cancelButtonOptions,
  customConfirmButton,
  childrenContentClassName,
  closeOnConfirm = true,
  width = "md",
  autoFocusConfirm = true,
  closeButtonOptions,
  reverseFooter = false,
  rowFooter: _rowFooter,
  ...modalProps
}: ConfirmModalProps) {
  const confirmingRef = useRef(false);
  const close = () => onOpenChange?.(false);
  const cancel = () => {
    if (confirmingRef.current) return;
    if (onCancel !== false) onCancel?.();
    close();
  };

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
      <ConfirmModalBody
        open={!!open}
        description={description}
        confirmText={confirmText}
        cancelText={cancelText}
        danger={danger}
        confirmMatchText={confirmMatchText}
        confirmMatchPlaceholder={confirmMatchPlaceholder}
        onConfirm={onConfirm}
        onCancel={onCancel}
        confirmButtonOptions={confirmButtonOptions}
        cancelButtonOptions={cancelButtonOptions}
        customConfirmButton={customConfirmButton}
        childrenContentClassName={childrenContentClassName}
        closeOnConfirm={closeOnConfirm}
        autoFocusConfirm={autoFocusConfirm}
        reverseFooter={reverseFooter}
        onConfirmingChange={(next) => {
          confirmingRef.current = next;
        }}
        onRequestClose={(reason) => {
          if (reason === "cancel") {
            cancel();
            return;
          }
          close();
        }}
      >
        {children}
      </ConfirmModalBody>
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

interface PromptModalBodyProps {
  open: boolean;
  children?: ReactNode;
  confirmButtonOptions?: MyoxusButtonProps;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  cancelButtonOptions?: MyoxusButtonProps;
  onConfirm?: ((text: string) => void) | ((text: string) => Promise<void>);
  label?: ReactNode;
  required: boolean;
  inputOptions?: Omit<MyoxusInputProps, "value" | "onChange">;
  defaultValue?: string;
  reverseFooter: boolean;
  autoFocusConfirm: boolean;
  autoClose: boolean;
  onSuccess?: () => void;
  onRequestClose: (reason: "cancel" | "confirmed") => void;
  onConfirmingChange?: (confirming: boolean) => void;
}

function PromptModalBody({
  open,
  children,
  confirmButtonOptions,
  confirmText,
  cancelText,
  cancelButtonOptions,
  onConfirm,
  label,
  required,
  inputOptions,
  defaultValue,
  reverseFooter,
  autoFocusConfirm,
  autoClose,
  onSuccess,
  onRequestClose,
  onConfirmingChange,
}: PromptModalBodyProps) {
  const t = useI18n();
  const [value, setValue] = useState(defaultValue ?? "");
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const inputDataTestId = (
    inputOptions as Record<string, unknown> | undefined
  )?.["data-testid"] as string | undefined;

  useEffect(() => {
    if (open) setValue(defaultValue ?? "");
  }, [defaultValue, open]);

  const setConfirmingState = (next: boolean) => {
    confirmingRef.current = next;
    setConfirming(next);
    onConfirmingChange?.(next);
  };

  const cancel = () => {
    if (confirmingRef.current) return;
    onRequestClose("cancel");
  };

  const confirm = async () => {
    if (confirmingRef.current || (required && !value)) return;
    setConfirmingState(true);
    try {
      await onConfirm?.(value);
      setValue("");
      onSuccess?.();
      if (autoClose) {
        onRequestClose("confirmed");
      }
    } catch (error) {
      console.error(error);
    } finally {
      setConfirmingState(false);
    }
  };

  const resolvedCancelText = cancelText ?? t["Cancel"]();

  const cancelAction = (
    <MyoxusButton
      data-testid="prompt-modal-cancel"
      onClick={cancel}
      {...cancelButtonOptions}
      disabled={confirming || cancelButtonOptions?.disabled}
    >
      {resolvedCancelText}
    </MyoxusButton>
  );
  const confirmAction = (
    <MyoxusButton
      data-testid="prompt-modal-confirm"
      variant="primary"
      loading={confirming}
      autoFocus={autoFocusConfirm}
      onClick={() => {
        void confirm();
      }}
      {...confirmButtonOptions}
      disabled={
        confirming || (required && !value) || confirmButtonOptions?.disabled
      }
    >
      {confirmText}
    </MyoxusButton>
  );

  return (
    <Stack gap={"calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"}>
      <Input
        {...inputOptions}
        label={label}
        value={value}
        onChange={setValue}
        autoFocus={inputOptions?.autoFocus ?? true}
        data-autofocus={inputOptions?.autoFocus === false ? undefined : true}
        data-testid={inputDataTestId ?? "prompt-modal-input"}
      />
      {children}
      <Divider />
      <DialogFooterActions>
        {reverseFooter ? confirmAction : cancelAction}
        {reverseFooter ? cancelAction : confirmAction}
      </DialogFooterActions>
    </Stack>
  );
}

function openManagedPromptModal(
  props: PromptModalProps = {},
  options: OpenPromptModalOptions = {},
) {
  const { autoClose = true, onSuccess } = options;
  const {
    title,
    description,
    children,
    confirmButtonOptions,
    confirmText,
    cancelText,
    cancelButtonOptions,
    onConfirm,
    onCancel,
    onOpenChange,
    label,
    required = true,
    inputOptions,
    defaultValue,
    reverseFooter = false,
    width = "md",
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
    scrollable = false,
    onExitTransitionEnd,
    onEscape,
    returnFocusRef,
    returnFocus,
    autoFocusConfirm = true,
    stackId: _stackId,
  } = props;

  const currentActiveElement =
    typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null;
  let openerElement = currentActiveElement;

  if (activePromptHandle) {
    const previous = activePromptHandle;
    activePromptHandle = null;
    if (previous.openerElement) {
      openerElement = previous.openerElement;
    }
    previous.setSettled();
    lockedManagedModalEscapes.delete(previous.modalId);
    modals.close(previous.modalId);
  }

  const modalId = `myoxus-prompt-modal-${++managedModalSequence}`;
  let settled = false;
  let confirming = false;
  const handle: ManagedModalHandle = {
    modalId,
    openerElement,
    setSettled: () => {
      settled = true;
    },
  };
  activePromptHandle = handle;
  setManagedModalEscapeLock(modalId, Boolean(persistent), onEscape);

  const frameProps = buildModalFrameProps({
    closeLabel: resolveCloseLabel(),
    closeButtonOptions,
    contentOptions,
    contentWrapperClassName,
    contentWrapperStyle,
    fullScreen,
    headerClassName,
    height,
    keepVisibleInStack,
    maxHeight,
    minHeight,
    modalId,
    overlayOptions,
    scrollable,
    title,
    width,
    withoutCloseButton,
  });

  const handleRequestClose = (reason: "cancel" | "confirmed") => {
    if (settled) return;
    settled = true;
    lockedManagedModalEscapes.delete(modalId);
    if (activePromptHandle === handle) {
      activePromptHandle = null;
    }
    if (reason === "cancel") {
      onCancel?.();
    }
    onOpenChange?.(false);
    modals.close(modalId);
  };

  modals.open({
    ...(frameProps as Record<string, unknown>),
    modalId,
    closeOnClickOutside: !persistent,
    closeOnEscape: !persistent,
    returnFocus,
    onKeyDownCapture: (event) => {
      if (event.key === "Escape") onEscape?.(event.nativeEvent);
    },
    onExitTransitionEnd: () => {
      if (returnFocus !== false) {
        (returnFocusRef?.current ?? openerElement)?.focus();
      }
      onExitTransitionEnd?.();
    },
    onClose: () => {
      lockedManagedModalEscapes.delete(modalId);
      if (activePromptHandle === handle) {
        activePromptHandle = null;
      }
      if (!settled) {
        settled = true;
        if (!confirming) {
          onCancel?.();
        }
        onOpenChange?.(false);
      }
    },
    children: (
      <ManagedModalLifecycle>
        <InsideModalContext.Provider
          value={`[data-myoxus-modal-portal="${modalId}"]`}
        >
          <ModalDescription
            description={description}
            className={descriptionClassName}
          />
          <PromptModalBody
            open
            confirmButtonOptions={confirmButtonOptions}
            confirmText={confirmText}
            cancelText={cancelText}
            cancelButtonOptions={cancelButtonOptions}
            onConfirm={onConfirm}
            label={label}
            required={required}
            inputOptions={inputOptions}
            defaultValue={defaultValue}
            reverseFooter={reverseFooter}
            autoFocusConfirm={autoFocusConfirm}
            autoClose={autoClose}
            onSuccess={() => {
              if (!settled) onSuccess?.();
            }}
            onRequestClose={handleRequestClose}
            onConfirmingChange={(next) => {
              confirming = next;
              if (!settled) {
                setManagedModalEscapeLock(
                  modalId,
                  Boolean(persistent) || next,
                  onEscape,
                );
                modals.updateModal({
                  modalId,
                  closeOnClickOutside: !persistent && !next,
                  closeOnEscape: !persistent && !next,
                  withCloseButton: !withoutCloseButton && !next,
                });
              }
            }}
          >
            {children}
          </PromptModalBody>
        </InsideModalContext.Provider>
      </ManagedModalLifecycle>
    ),
  });
}

function closeManagedPromptModal() {
  if (!activePromptHandle) return;
  const current = activePromptHandle;
  activePromptHandle = null;
  current.setSettled();
  lockedManagedModalEscapes.delete(current.modalId);
  modals.close(current.modalId);
}

export function usePromptModal(): {
  openPromptModal: (
    props?: PromptModalProps,
    options?: OpenPromptModalOptions,
  ) => void;
  closePromptModal: () => void;
} {
  const t = useI18n();
  const closeLabel = resolveCloseLabel(t);
  useEffect(() => {
    latestCloseLabel = closeLabel;
  }, [closeLabel]);
  return {
    openPromptModal: openManagedPromptModal,
    closePromptModal: closeManagedPromptModal,
  };
}

/**
 * Retained compatibility pass-through. `MyoxusUIProvider` owns the single
 * `<Modal.Stack>` and `<ModalsProvider>` host for all managed dialogs.
 */
export function PromptModalProvider({ children }: PropsWithChildren) {
  return children;
}

export function PromptModal({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmButtonOptions,
  confirmText,
  cancelText,
  cancelButtonOptions,
  onConfirm,
  onCancel,
  label,
  required = true,
  inputOptions,
  defaultValue,
  reverseFooter = false,
  width = "md",
  autoFocusConfirm = true,
  ...modalProps
}: PromptModalProps) {
  const confirmingRef = useRef(false);
  const close = () => onOpenChange?.(false);
  const cancel = () => {
    if (confirmingRef.current) return;
    onCancel?.();
    close();
  };

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
      <PromptModalBody
        open={!!open}
        confirmButtonOptions={confirmButtonOptions}
        confirmText={confirmText}
        cancelText={cancelText}
        cancelButtonOptions={cancelButtonOptions}
        onConfirm={onConfirm}
        label={label}
        required={required}
        inputOptions={inputOptions}
        defaultValue={defaultValue}
        reverseFooter={reverseFooter}
        autoFocusConfirm={autoFocusConfirm}
        autoClose={false}
        onConfirmingChange={(next) => {
          confirmingRef.current = next;
        }}
        onRequestClose={(reason) => {
          if (reason === "cancel") {
            cancel();
            return;
          }
          close();
        }}
      >
        {children}
      </PromptModalBody>
    </Modal>
  );
}
