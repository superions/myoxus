/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
// SPDX-License-Identifier: Apache-2.0
// Modified by Myoxus: React 19/XYFlow 12 and direct Facade integration; see provenance.json.

import * as React from "react";
import { usePendingEdit } from "../reactExt/PendingEdits";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "@myoxus/i18n";
import { Text } from "@myoxus/ui-facade";
import { type NodeLabelPosition } from "../nodes/NodeSvgs";
import "./EditableNodeLabel.css";

export const INVALID_NAME_CSS_PROPS = {
  color: "var(--mantine-color-error)",
  textDecoration: "dotted underline",
  textUnderlinePosition: "under",
};

export type OnEditableNodeLabelChange = (value: string | undefined) => void;

export function EditableNodeLabel({
  id,
  name,
  isEditing: _isEditing,
  setEditing: _setEditing,
  value,
  displayText,
  placeholder,
  onChange,
  position,
  truncate,
  grow,
  shouldCommitOnBlur,
  skipValidation,
  validate,
  fontCssProperties,
  setLabelHeight,
  enableAutoFocusing,
  bounds,
}: {
  id?: string;
  shouldCommitOnBlur?: boolean;
  grow?: boolean;
  truncate?: boolean;
  name: string | undefined;
  position: NodeLabelPosition;
  isEditing: boolean;
  value: string | undefined;
  /** Read-only notation (for example a data state); never initializes rename drafts. */
  displayText?: string;
  placeholder?: string;
  setEditing: React.Dispatch<React.SetStateAction<boolean>>;
  onChange: OnEditableNodeLabelChange;
  skipValidation?: boolean;
  validate: (name: string | undefined) => boolean;
  fontCssProperties?: React.CSSProperties;
  setLabelHeight?: React.Dispatch<React.SetStateAction<number>>;
  enableAutoFocusing?: boolean;
  /** Authored notation rectangle relative to the owning shape, never UI chrome. */
  bounds?: { x: number; y: number; width: number; height: number };
}) {
  const t = useI18n();
  const displayValue = useMemo(() => {
    if (!value) {
      return undefined;
    }

    if (!name) {
      return value;
    }

    return value;
  }, [name, value]);

  const isEditing = useMemo(() => {
    return _isEditing; // Can't ever change the names of external nodes
  }, [_isEditing]);

  const setEditing = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (args) => {
      _setEditing(args);
    },
    [_setEditing],
  );

  const [internalValue, setInternalValue] = useState(displayValue);
  const renderedValue = displayText ?? displayValue;
  useEffect(() => {
    // Give `value` priority over `internalValue`, if it changes externally, we take that as the new `internalValue`.
    setInternalValue(displayValue);
  }, [displayValue]);

  // If `shouldCommitOnBlur` is true, pressing `Esc` will override this.
  // If `shouldCommitOnBlur` is false, pressing `Enter` will override this.
  const _shouldCommitOnBlur = shouldCommitOnBlur ?? false; // Defaults to false
  const [shouldCommit, setShouldCommit] = useState(_shouldCommitOnBlur);
  useEffect(() => {
    setShouldCommit(_shouldCommitOnBlur); // Keeps the internal state aligned with the prop.
  }, [_shouldCommitOnBlur]);

  const restoreFocus = useCallback(() => {
    // We only restore the focus to the previously focused element if we're still holding focus. If focus has changed, we let it be.
    setTimeout(() => {
      if (document.activeElement === ref.current) {
        (previouslyFocusedElement.current as any)?.focus?.();
      }
    }, 0);
  }, []);

  const isValid = useMemo(() => {
    if (skipValidation) {
      return true;
    }

    return validate(internalValue);
  }, [skipValidation, validate, internalValue]);

  const onBlur = useCallback(() => {
    setEditing(false);
    setShouldCommit(_shouldCommitOnBlur); // Only gets propagated after this function ends. `shouldCommit` is unchanged after this line.
    restoreFocus();

    if (isValid && internalValue !== value && shouldCommit) {
      onChange(internalValue);
    } else {
      setInternalValue(value);
    }
  }, [
    internalValue,
    onChange,
    restoreFocus,
    _shouldCommitOnBlur,
    setEditing,
    shouldCommit,
    isValid,
    value,
  ]);

  // Finish editing on `Enter` pressed.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // In macOS, we can not stopPropagation here because, otherwise, shortcuts are not handled
      // See https://github.com/apache/incubator-kie-issues/issues/1164
      if (!e.metaKey) {
        e.stopPropagation();
      }
      if (e.key === "Enter") {
        if (!isValid) {
          return; // Simply ignore and don't allow user to go outside the component using only the keyboard.
        } else {
          setShouldCommit(true);
          restoreFocus(); // This will trigger `onBlur`, which will commit the change.
        }
      } else if (e.key === "Escape") {
        setShouldCommit(false);
        restoreFocus(); // This will trigger `onBlur`, which will ignore  the change.
      }
    },
    [restoreFocus, isValid],
  );

  // Very important to restore the focus after editing is done.
  const previouslyFocusedElement = useRef<Element | undefined>(undefined);
  useLayoutEffect(() => {
    if (isEditing && enableAutoFocusing !== false) {
      previouslyFocusedElement.current = document.activeElement ?? undefined; // Save potential focused element. Most likely the node itself.
      ref.current?.focus();
    }
  }, [isEditing, enableAutoFocusing]);

  // Make sure the component is rendered with its text already selected.
  // `useLayoutEffect` is just like `useEffect`, but runs before the DOM mutates.
  useLayoutEffect(() => {
    if (isEditing) {
      ref.current?.setSelectionRange(0, 0);
    }
  }, [isEditing]);
  // It's important to do this in two steps, so the text is selected and shows always from the start, not from the end.
  useEffect(() => {
    if (isEditing) {
      ref.current?.setSelectionRange(0, ref.current?.value.length, "forward");
    }
  }, [isEditing]);

  const ref = useRef<HTMLInputElement>(null);
  usePendingEdit(isEditing && internalValue !== value, {
    commit: () => {
      if (!isValid) return false;
      onChange(internalValue);
      setEditing(false);
      return true;
    },
    discard: () => {
      setInternalValue(value);
      setEditing(false);
    },
    focus: () => ref.current?.focus(),
  });

  return (
    <div
      className={`xyflow-react-kie-diagram--editable-node-name-input ${bounds ? "center-center" : position} ${grow ? "grow" : ""}`}
      style={
        bounds
          ? {
              position: "absolute",
              left: bounds.x,
              top: bounds.y,
              width: bounds.width,
              height: bounds.height,
            }
          : undefined
      }
    >
      {(isEditing && (
        <input
          id={id}
          spellCheck={false}
          aria-label={t.Edit()}
          style={{
            ...fontCssProperties,
            ...(isValid ? {} : INVALID_NAME_CSS_PROPS),
          }}
          onMouseDownCapture={(e) => e.stopPropagation()} // Make sure mouse events stay inside the node.
          onKeyDown={onKeyDown}
          tabIndex={-1}
          ref={ref}
          onBlur={onBlur}
          placeholder={placeholder}
          onChange={(e) => setInternalValue(e.target.value)}
          value={internalValue}
        />
      )) || (
        <span
          // clientHeight isn't affected by the zoom in/out
          ref={(ref) => setLabelHeight?.(ref?.clientHeight ?? 0)}
          style={{
            whiteSpace: "pre-wrap",
            ...fontCssProperties,
            ...(isValid ? {} : INVALID_NAME_CSS_PROPS),
          }}
        >
          {!renderedValue ? (
            <Text span>{t.Edit()}</Text>
          ) : !truncate ? (
            renderedValue
          ) : (
            <Text span truncate>
              {renderedValue}
            </Text>
          )}
        </span>
      )}
    </div>
  );
}

/** Editing belongs to the mounted label and closes when the host becomes read-only. */
export function useEditableNodeLabel(
  _id: string | undefined,
  readOnly = false,
) {
  const [isEditingLabel, setEditingLabel] = useState(false);
  React.useEffect(() => {
    if (readOnly) setEditingLabel(false);
  }, [readOnly]);

  const triggerEditing = useCallback<React.EventHandler<React.SyntheticEvent>>(
    (e) => {
      if (readOnly) return;
      e.stopPropagation();
      e.preventDefault();
      setEditingLabel(true);
    },
    [readOnly],
  );

  // Trigger editing on `Enter` pressed.
  const triggerEditingIfEnter = useCallback<React.KeyboardEventHandler>(
    (e) => {
      if (e.key === "Enter") {
        triggerEditing(e);
      }
    },
    [triggerEditing],
  );

  return useMemo(
    () => ({
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    }),
    [isEditingLabel, triggerEditing, triggerEditingIfEnter],
  );
}
