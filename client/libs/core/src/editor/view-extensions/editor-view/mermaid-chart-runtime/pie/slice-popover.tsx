// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  NumberInput,
  Stack,
  MyoxusTextInput,
  type DataPieChartItem,
} from "@myoxus/ui-facade";
import type { MermaidPieReactHostProps } from "@virgultum/block-mermaid";
import { type KeyboardEvent, useEffect, useState } from "react";

export function MermaidPieSlicePopover({
  close,
  draft,
  draftDiagnosis,
  draftValid,
  item,
  onDraftApply,
  onDraftChange,
  onValueApply,
  props,
}: {
  readonly close: () => void;
  readonly draft: boolean;
  readonly draftDiagnosis: string | null;
  readonly draftValid: boolean;
  readonly item: DataPieChartItem;
  readonly onDraftApply: () => void;
  readonly onDraftChange: (label: string, value: number) => void;
  readonly onValueApply: (sliceId: string, value: number) => void;
  readonly props: MermaidPieReactHostProps;
}) {
  const [labelDraft, setLabelDraft] = useState(item.label);
  const [valueDraft, setValueDraft] = useState<number | string>(item.value);
  useEffect(() => {
    setLabelDraft(item.label);
    setValueDraft(item.value);
  }, [item.id, item.label, item.value]);
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (draft) {
        if (
          draftValid &&
          labelDraft.trim() &&
          typeof valueDraft === "number" &&
          Number.isFinite(valueDraft) &&
          valueDraft >= 0
        ) {
          onDraftApply();
        }
      } else if (
        typeof valueDraft === "number" &&
        Number.isFinite(valueDraft) &&
        valueDraft >= 0
      ) {
        onValueApply(item.id, valueDraft);
        close();
      }
    }
  };
  if (draft) {
    const labelInvalid =
      draftDiagnosis === "pie.slice-label-empty" ||
      draftDiagnosis === "pie.slice-label-duplicate";
    const valueInvalid =
      typeof valueDraft !== "number" ||
      !Number.isFinite(valueDraft) ||
      valueDraft < 0 ||
      draftDiagnosis === "pie.slice-value-invalid";
    return (
      <Stack gap="xs">
        <MyoxusTextInput
          autoFocus
          aria-label={props.labels.label}
          disabled={props.readonly}
          error={labelInvalid ? props.labels.invalid : undefined}
          onChange={(label) => {
            setLabelDraft(label);
            if (typeof valueDraft === "number") {
              onDraftChange(label, valueDraft);
            }
          }}
          onKeyDown={handleKeyDown}
          value={labelDraft}
        />
        <NumberInput
          aria-label={props.labels.value}
          disabled={props.readonly}
          error={valueInvalid ? props.labels.invalid : undefined}
          min={0}
          onChange={(value) => {
            setValueDraft(value);
            if (typeof value === "number") {
              onDraftChange(labelDraft, value);
            }
          }}
          onKeyDown={handleKeyDown}
          value={valueDraft}
        />
        <Button
          disabled={props.readonly || !draftValid || valueInvalid}
          onClick={onDraftApply}
        >
          {props.labels.add}
        </Button>
      </Stack>
    );
  }
  return (
    <NumberInput
      autoFocus
      aria-label={`${props.labels.value}: ${item.label}`}
      disabled={props.readonly}
      error={
        typeof valueDraft !== "number" ||
        !Number.isFinite(valueDraft) ||
        valueDraft < 0
          ? props.labels.invalid
          : undefined
      }
      min={0}
      onChange={(value) => {
        setValueDraft(value);
      }}
      onKeyDown={handleKeyDown}
      value={valueDraft}
    />
  );
}
