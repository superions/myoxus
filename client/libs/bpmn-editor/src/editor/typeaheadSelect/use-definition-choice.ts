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
// Modified by Myoxus; see provenance.json for retained source and patches.

import { useId, useState } from "react";
import {
  type SearchComboboxOption,
  type SearchComboboxProps,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { useBpmnEditorStore } from "../store/StoreContext";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
export type DefinitionChoice = {
  value: string;
  label: string;
  disabled?: boolean;
};

/**
 * Retained typeahead controller for XML definition references, never a registry
 * or visual component. Choosing a label submits its stable XML ID. Creating a
 * definition delegates to the existing mutation owner before submitting its ID.
 */
export function useDefinitionChoice({
  choices,
  selected,
  disabled,
  label,
  emptyLabel,
  onSelect,
  create,
  createLabel,
  createEvenWhenMatched = false,
  referenceOwner,
  canCreate,
}: {
  choices: DefinitionChoice[];
  selected: string | undefined;
  disabled?: boolean;
  label: string;
  emptyLabel: string;
  onSelect: (
    value: string | undefined,
    label: string | undefined,
    reason: "existing" | "created" | "cleared",
  ) => void;
  create?: (label: string) => string;
  createLabel?: string;
  /** Expressions may deliberately have the same text as a declaration's display name. */
  createEvenWhenMatched?: boolean;
  /** Actual XML field owner, not a copied row or its declaration target. Used
   * only for presentation; the mutation callback encodes the selected ID. */
  referenceOwner?: object;
  /** Validate technical input before exposing Create; partial field queries are
   * not declaration commands and must not throw from an event handler. */
  canCreate?: (label: string) => boolean;
}): SearchComboboxProps {
  const t = useI18n();
  const definitions = useBpmnEditorStore((s) => s.bpmn.model.definitions);
  const selectedId = referenceOwner
    ? indexBpmnIds(definitions).resolveReference(referenceOwner, selected)
    : selected;
  const id = useId();
  const [isOpen, setOpen] = useState(false);
  const [query, setQuery] = useState<string | undefined>();
  const [focused, setFocused] = useState(0);
  const term = query?.trim() ?? "";
  const options: SearchComboboxOption[] = choices
    .filter(
      (choice) =>
        !term ||
        choice.label
          .toLocaleLowerCase(t.language)
          .includes(term.toLocaleLowerCase(t.language)),
    )
    .map((choice, index) => ({
      ...choice,
      id: `${id}-option-${index}`,
      title: choice.label,
      selected: choice.value === selectedId,
    }));
  const createId = `${id}-create`;
  const clearId = `${id}-clear`;
  if (
    create &&
    createLabel &&
    term &&
    (!canCreate || canCreate(term)) &&
    (createEvenWhenMatched || !choices.some((choice) => choice.label === term))
  ) {
    options.push({
      id: createId,
      value: createId,
      title: createLabel,
      meta: term,
    });
  }
  if (selected !== undefined)
    options.push({
      id: clearId,
      value: clearId,
      title: t["com.myoxus.common.clear-selection"](),
    });
  const enabled = options.filter((option) => !option.disabled);
  const active = enabled[Math.min(focused, Math.max(0, enabled.length - 1))];
  const close = () => {
    setOpen(false);
    setQuery(undefined);
    setFocused(0);
  };
  const commit = (option: SearchComboboxOption) => {
    if (disabled || option.disabled) return;
    if (option.id === createId) {
      if (!create || !term || (canCreate && !canCreate(term))) return;
      onSelect(create(term), term, "created");
    } else if (option.id === clearId) onSelect(undefined, undefined, "cleared");
    else
      onSelect(
        option.value,
        choices.find((choice) => choice.value === option.value)?.label,
        "existing",
      );
    close();
  };
  return {
    value:
      query ??
      choices.find((choice) => choice.value === selectedId)?.label ??
      selected ??
      "",
    placeholder: label,
    label,
    disabled,
    inputId: id,
    listboxId: `${id}-options`,
    isOpen,
    activeDescendant: isOpen ? active?.id : undefined,
    state: options.length
      ? {
          kind: "options",
        }
      : {
          kind: "empty",
          label: emptyLabel,
        },
    options,
    onInputChange: (value) => {
      setQuery(value);
      setFocused(0);
      setOpen(true);
    },
    onInputFocus: () => setOpen(true),
    onClose: close,
    onOptionCommit: commit,
    onInputKeyDown: (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
        if (enabled.length)
          setFocused(
            (index) =>
              (index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) %
              enabled.length,
          );
      } else if (event.key === "Enter" && isOpen && active) {
        event.preventDefault();
        event.stopPropagation();
        commit(active);
      }
    },
  };
}
