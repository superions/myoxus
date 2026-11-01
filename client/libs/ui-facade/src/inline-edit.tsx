// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, Text, TextInput, UnstyledButton } from "@mantine/core";
import {
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type CSSProperties,
  type ForwardedRef,
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

export const InlineContentTrigger = forwardRef<
  HTMLButtonElement,
  PropsWithChildren<
    ButtonHTMLAttributes<HTMLButtonElement> & {
      "data-myoxus-ui-role"?: string;
    }
  >
>(function InlineContentTrigger(
  {
    children,
    type = "button",
    "data-myoxus-ui-role": uiRole = "inline-content-trigger",
    ...props
  },
  ref,
) {
  return (
    <UnstyledButton
      {...props}
      ref={ref}
      type={type}
      display="block"
      miw={0}
      ta="start"
      w="100%"
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </UnstyledButton>
  );
});

export interface InlineEditHandle {
  triggerEdit: () => void;
  discardDraft: () => void;
}

export interface InlineEditProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange" | "onInput"
> {
  value?: string;
  editable?: boolean;
  exitible?: boolean;
  onInput?: (value: string) => void;
  onChange?: (value: string) => void;
  onEditEnd?: (outcome: "commit" | "cancel") => void;
  onEditStart?: () => void;
  trigger?: "click" | "doubleClick";
  placeholder?: string;
  /** False allows natural wrapping; omitted retains the single-line truncation default. */
  displayLineClamp?: number | false;
  /** Format only the display; the input, accessible name and committed value retain the raw label. */
  renderDisplay?: (value: string) => ReactNode;
  handleRef?: ForwardedRef<InlineEditHandle>;
  inputAttrs?: Omit<HTMLAttributes<HTMLInputElement>, "onChange" | "onBlur">;
}

export const InlineEdit = ({
  value,
  editable,
  exitible = true,
  className,
  style,
  trigger = "click",
  onInput,
  onChange,
  onEditEnd,
  onEditStart,
  placeholder,
  displayLineClamp,
  renderDisplay,
  handleRef,
  inputAttrs,
  ...attrs
}: InlineEditProps) => {
  const [editing, setEditing] = useState(false);
  const [editingValue, setEditingValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayRef = useRef<HTMLButtonElement>(null);
  const editingRef = useRef(false);
  const restoreFocusRef = useRef(false);

  const triggerEdit = useCallback(() => {
    if (!editable) return;
    onEditStart?.();
    editingRef.current = true;
    restoreFocusRef.current = true;
    setEditing(true);
  }, [editable, onEditStart]);

  const discardDraft = useCallback(() => {
    const wasEditing = editingRef.current;
    editingRef.current = false;
    setEditing(false);
    setEditingValue(value);
    if (wasEditing) onEditEnd?.("cancel");
  }, [onEditEnd, value]);

  // Rights can change while the input is mounted. A revoked draft must never resume when rights return.
  useEffect(() => {
    if (!editable && editingRef.current) discardDraft();
  }, [editable, discardDraft]);

  useImperativeHandle<InlineEditHandle, InlineEditHandle>(handleRef, () => ({
    discardDraft,
    triggerEdit,
  }));

  const submit = useCallback(() => {
    onChange?.(editingValue || "");
  }, [editingValue, onChange]);

  const finishEditing = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    submit();
    onEditEnd?.("commit");
    inputRef.current?.scrollTo(0, 0);
  }, [onEditEnd, submit]);

  const onBlur = useCallback(() => {
    finishEditing();
  }, [finishEditing]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      inputAttrs?.onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key === "Enter") {
        event.preventDefault();
        finishEditing();
        return;
      }
      if (exitible && event.key === "Escape") {
        event.preventDefault();
        discardDraft();
      }
    },
    [discardDraft, exitible, finishEditing, inputAttrs],
  );

  const handleInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setEditingValue(event.target.value);
      onInput?.(event.target.value);
    },
    [onInput],
  );

  useEffect(() => {
    // Query invalidation may deliver a newer server projection while the user
    // is typing. Keep that local draft until save or explicit cancellation;
    // conflict handling owns the later reload/overwrite decision.
    if (!editingRef.current) setEditingValue(value);
  }, [value]);

  useEffect(() => {
    if (!editing) return;
    const timeout = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.clearTimeout(timeout);
  }, [editing]);

  useEffect(() => {
    if (editing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    displayRef.current?.focus();
  }, [editing]);

  const displayValue = useMemo(
    () => (editingValue ? editingValue.replace(/\n/g, "") : ""),
    [editingValue],
  );

  // Inline editing must preserve the consumer's title/cell typography. Mantine's
  // unstyled input still projects field border and minimum height, which causes
  // a screenshot-proven baseline jump; reset only that field chrome here.
  const inheritedInputStyle = {
    margin: "inherit",
    padding: 0,
    border: 0,
    borderRadius: "inherit",
    height: "auto",
    minHeight: "unset",
    fontSize: "inherit",
    fontFamily: "inherit",
    lineHeight: "inherit",
    fontWeight: "inherit",
    letterSpacing: "inherit",
    textAlign: "inherit",
    color: "inherit",
    backgroundColor: "inherit",
  } as CSSProperties;
  const {
    className: inputClassName,
    style: inputStyle,
    ...textInputAttrs
  } = inputAttrs ?? {};
  const accessibleName =
    textInputAttrs["aria-label"] ?? (displayValue || placeholder || "Edit");
  const stopCardActivation = (event: { stopPropagation: () => void }) =>
    event.stopPropagation();
  const handleDisplayClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (trigger === "click") triggerEdit();
  };
  const handleDisplayDoubleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (trigger === "doubleClick") triggerEdit();
  };

  return (
    <Box
      component="div"
      miw={0}
      w="100%"
      data-myoxus-ui-role="inline-edit"
      data-editing={editing ? "true" : undefined}
      className={className}
      style={style}
      {...attrs}
    >
      {editing ? (
        <TextInput
          {...textInputAttrs}
          ref={inputRef}
          variant="unstyled"
          classNames={{
            input: inputClassName,
          }}
          data-myoxus-ui-role="inline-edit-input"
          value={editingValue}
          placeholder={placeholder}
          onChange={handleInput}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onClick={stopCardActivation}
          onDoubleClick={stopCardActivation}
          onPointerDown={stopCardActivation}
          styles={{
            input: { ...inheritedInputStyle, ...inputStyle },
          }}
        />
      ) : editable ? (
        <UnstyledButton
          ref={displayRef}
          aria-label={accessibleName}
          fz="inherit"
          lh="inherit"
          display="block"
          miw={0}
          ta="start"
          w="100%"
          data-myoxus-ui-role="inline-edit-display"
          onClick={handleDisplayClick}
          onDoubleClick={handleDisplayDoubleClick}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "F2") {
              event.preventDefault();
              triggerEdit();
            }
          }}
          onPointerDown={stopCardActivation}
        >
          <Text
            inherit
            lineClamp={
              displayLineClamp === false ? undefined : displayLineClamp
            }
            truncate={
              displayLineClamp === false || displayLineClamp ? undefined : "end"
            }
            c={displayValue ? "inherit" : "dimmed"}
          >
            {displayValue
              ? (renderDisplay?.(displayValue) ?? displayValue)
              : placeholder}
          </Text>
        </UnstyledButton>
      ) : (
        <Text
          component="span"
          inherit
          lineClamp={displayLineClamp === false ? undefined : displayLineClamp}
          truncate={
            displayLineClamp === false || displayLineClamp ? undefined : "end"
          }
          c={displayValue ? "inherit" : "dimmed"}
          tabIndex={0}
          data-myoxus-ui-role="inline-edit-display"
        >
          {displayValue
            ? (renderDisplay?.(displayValue) ?? displayValue)
            : placeholder}
        </Text>
      )}
    </Box>
  );
};
