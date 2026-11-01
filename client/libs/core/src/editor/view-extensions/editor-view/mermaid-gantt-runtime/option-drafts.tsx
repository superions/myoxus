// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, Group, MyoxusText, Select, Stack } from "@myoxus/ui-facade";
import {
  isGanttConfigField,
  mermaidMessages as messages,
  type GanttCommand,
  type GanttOptionName,
  type MermaidGanttModel,
} from "@virgultum/block-mermaid";
import { useState } from "react";

/** Calendar and appearance share statement selection, not a second option model. */
export function useGanttOptionDrafts(model: MermaidGanttModel) {
  const [basis] = useState(model.sourceDocument.source);
  const conflicted = basis !== model.sourceDocument.source;
  const [drafts, setDrafts] = useState<
    Partial<
      Record<
        GanttOptionName,
        {
          statementId?: string;
          value: string;
          remove: boolean;
        }
      >
    >
  >({});
  const occurrences = (name: GanttOptionName) =>
    isGanttConfigField(name)
      ? model.configOccurrences
          .filter((item) => item.field === name)
          .map((item) => ({
            id: item.record.id,
            value: String(item.resolvedValue),
            line: model.sourceDocument.source
              .slice(0, item.record.range.start)
              .split(/\r\n|\r|\n/).length,
          }))
      : model.sourceDocument.statements
          .filter((item) => item.kind === "option" && item.optionName === name)
          .map((item) => ({
            id: item.id,
            value: item.raw.trim().slice(name.length).trim(),
            line: model.sourceDocument.source
              .slice(0, item.range.start)
              .split(/\r\n|\r|\n/).length,
          }));
  const selected = (name: GanttOptionName) => {
    const items = occurrences(name);
    const draft = drafts[name];
    return draft?.statementId
      ? items.find((item) => item.id === draft.statementId)
      : items.at(-1);
  };
  const value = (name: GanttOptionName, fallback = "") =>
    drafts[name]?.remove
      ? fallback
      : (drafts[name]?.value ?? selected(name)?.value ?? fallback);
  const setValue = (name: GanttOptionName, next: string) =>
    setDrafts((before) => ({
      ...before,
      [name]: { statementId: selected(name)?.id, value: next, remove: false },
    }));
  const commands: GanttCommand[] = [];
  for (const [key, draft] of Object.entries(drafts)) {
    if (conflicted) break;
    const name = key as GanttOptionName;
    const before = selected(name);
    if (draft.remove) {
      if (before)
        commands.push({ type: "option.remove", name, statementId: before.id });
    } else if (!before || draft.value !== before.value) {
      // Empty text removes an override; only the two native flags and normal
      // displayMode have meaningful empty values.
      const emptyIsValue =
        name === "topAxis" ||
        name === "inclusiveEndDates" ||
        name === "displayMode";
      if (!draft.value && !emptyIsValue) {
        if (before)
          commands.push({
            type: "option.remove",
            name,
            statementId: before.id,
          });
      } else
        commands.push({
          type: "option.set",
          name,
          value: draft.value,
          statementId: before?.id,
        });
    }
  }
  const controls = (
    name: GanttOptionName,
    label: string,
    effective?: string,
  ) => {
    const items = occurrences(name);
    const current = selected(name);
    return (
      <Stack gap="xs">
        {items.length > 1 ? (
          <Select
            comboboxProps={{ withinPortal: false }}
            label={label}
            value={current?.id ?? null}
            data={items.map((item, index) => ({
              value: item.id,
              label: `${index + 1} · ${item.line} · ${name === "includes" || name === "excludes" || index === items.length - 1 ? messages.effectiveValue(item.value) : messages.sourceValue(item.value)}`,
            }))}
            onChange={(id) => {
              const item = items.find((candidate) => candidate.id === id);
              if (item)
                setDrafts((before) => ({
                  ...before,
                  [name]: {
                    statementId: item.id,
                    value: item.value,
                    remove: false,
                  },
                }));
            }}
          />
        ) : null}
        <Group justify="space-between">
          <MyoxusText typographySlot="caption">
            {messages.sourceValue(current?.value ?? "—")}
          </MyoxusText>
          <Button
            size="compact-sm"
            variant="ghost"
            disabled={!current || drafts[name]?.remove}
            onClick={() =>
              setDrafts((before) => ({
                ...before,
                [name]: { statementId: current?.id, value: "", remove: true },
              }))
            }
          >
            {messages.resetOverride()}
          </Button>
        </Group>
        {effective !== undefined ? (
          <MyoxusText typographySlot="caption">
            {messages.effectiveValue(effective)}
          </MyoxusText>
        ) : null}
      </Stack>
    );
  };
  const reset = (name: GanttOptionName) =>
    setDrafts((before) => ({
      ...before,
      [name]: { statementId: selected(name)?.id, value: "", remove: true },
    }));
  return {
    value,
    setValue,
    controls,
    commands,
    conflicted,
    reset,
    hasOverride: (name: GanttOptionName) =>
      Boolean(selected(name)) && !drafts[name]?.remove,
    cancel: () => setDrafts({}),
  };
}
