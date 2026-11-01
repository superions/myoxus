// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  KeyboardEventHandler,
  ReactNode,
} from "react";

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

export interface DialogModalProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  minHeight?: CSSProperties["minHeight"];
  contentOptions?: HTMLAttributes<HTMLDivElement> & {
    [key: `data-${string}`]: unknown;
    style?: CSSProperties;
  };
  withoutCloseButton?: boolean;
  closeButtonOptions?: DialogButtonOptions;
  headerClassName?: string;
  descriptionClassName?: string;
  persistent?: boolean;
  fullScreen?: boolean;
}

export interface ConfirmDialogProps extends DialogModalProps {
  customConfirmButton?: () => ReactNode;
  confirmButtonOptions?: DialogButtonOptions;
  childrenContentClassName?: string;
  onConfirm?: (() => void) | (() => Promise<void>);
  onCancel?: (() => void) | false;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  cancelButtonOptions?: DialogButtonOptions;
  reverseFooter?: boolean;
  rowFooter?: boolean;
  autoFocusConfirm?: boolean;
}

export interface PromptDialogProps extends DialogModalProps {
  confirmButtonOptions?: DialogButtonOptions;
  onConfirm?: ((text: string) => void) | ((text: string) => Promise<void>);
  onCancel?: () => void;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  label?: ReactNode;
  defaultValue?: string;
  required?: boolean;
  cancelButtonOptions?: DialogButtonOptions;
  inputOptions?: DialogInputOptions;
  reverseFooter?: boolean;
  autoFocusConfirm?: boolean;
}

export type OpenConfirmDialogOptions = {
  autoClose?: boolean;
  onSuccess?: () => void;
};

export type OpenPromptDialogOptions = {
  autoClose?: boolean;
  onSuccess?: () => void;
};

type DialogListener<T> = (props: T) => void;

const confirmListeners = new Set<DialogListener<ConfirmDialogProps>>();
const promptListeners = new Set<DialogListener<PromptDialogProps>>();

let confirmProps: ConfirmDialogProps = { open: false };
let promptProps: PromptDialogProps = { open: false };

function emitConfirm() {
  const snapshot = { ...confirmProps };
  confirmListeners.forEach((listener) => listener(snapshot));
}

function emitPrompt() {
  const snapshot = { ...promptProps };
  promptListeners.forEach((listener) => listener(snapshot));
}

function setConfirmLoading(value: boolean) {
  confirmProps = {
    ...confirmProps,
    confirmButtonOptions: {
      ...confirmProps.confirmButtonOptions,
      loading: value,
    },
  };
  emitConfirm();
}

function setPromptLoading(value: boolean) {
  promptProps = {
    ...promptProps,
    confirmButtonOptions: {
      ...promptProps.confirmButtonOptions,
      loading: value,
    },
  };
  emitPrompt();
}

/**
 * Renderer-free command store for global confirm/prompt dialogs.
 *
 * UI packages may subscribe and render the state with their own primitives, but
 * command callsites never import a concrete modal framework. This keeps the
 * Mantine cut-over from creating a second React context while old component
 * hooks are being retired.
 */
export function subscribeConfirmDialog(
  listener: DialogListener<ConfirmDialogProps>,
) {
  confirmListeners.add(listener);
  listener({ ...confirmProps });
  return () => {
    confirmListeners.delete(listener);
  };
}

export function subscribePromptDialog(
  listener: DialogListener<PromptDialogProps>,
) {
  promptListeners.add(listener);
  listener({ ...promptProps });
  return () => {
    promptListeners.delete(listener);
  };
}

export function closeConfirmDialog() {
  // Keep transition callbacks and the durable return-focus ref until the
  // closing Modal exits. The next open replaces this completed dialog.
  confirmProps = { ...confirmProps, open: false };
  emitConfirm();
}

export function closePromptDialog() {
  promptProps = { open: false };
  emitPrompt();
}

export function setConfirmDialogOpen(open: boolean) {
  confirmProps.onOpenChange?.(open);
  confirmProps = { ...confirmProps, open };
  emitConfirm();
}

export function setPromptDialogOpen(open: boolean) {
  promptProps.onOpenChange?.(open);
  promptProps = { ...promptProps, open };
  emitPrompt();
}

export function openConfirmDialog(
  props: ConfirmDialogProps = {},
  options: OpenConfirmDialogOptions = {},
) {
  const { autoClose = true, onSuccess } = options;
  const { onConfirm: originalOnConfirm, ...rest } = props;
  const onConfirm = async () => {
    setConfirmLoading(true);
    try {
      await originalOnConfirm?.();
      onSuccess?.();
      if (autoClose) closeConfirmDialog();
    } finally {
      setConfirmLoading(false);
    }
  };
  confirmProps = { ...rest, onConfirm, open: true };
  emitConfirm();
}

export function openPromptDialog(
  props: PromptDialogProps = {},
  options: OpenPromptDialogOptions = {},
) {
  const { autoClose = true, onSuccess } = options;
  const { onConfirm: originalOnConfirm, ...rest } = props;
  const onConfirm = async (value: string) => {
    setPromptLoading(true);
    try {
      await originalOnConfirm?.(value);
      onSuccess?.();
      if (autoClose) closePromptDialog();
    } finally {
      setPromptLoading(false);
    }
  };
  promptProps = { ...rest, onConfirm, open: true };
  emitPrompt();
}

export function resetDialogStoreForTests() {
  confirmProps = { open: false };
  promptProps = { open: false };
  emitConfirm();
  emitPrompt();
}
