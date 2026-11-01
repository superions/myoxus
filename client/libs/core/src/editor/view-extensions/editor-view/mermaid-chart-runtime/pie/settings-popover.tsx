// SPDX-License-Identifier: AGPL-3.0-or-later

import { DownloadIcon, MoreHorizontalIcon, PaletteIcon } from "@myoxus/icons";
import {
  Button,
  Group,
  IconButton,
  MyoxusSelect,
  MyoxusTextInput,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
  Switch,
  Textarea,
} from "@myoxus/ui-facade";
import type {
  MermaidPieAppearanceDraft,
  MermaidPieReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useRef, useState } from "react";

const HIGHLIGHT_NONE = "pie-highlight:none";
const HIGHLIGHT_HOVER = "pie-highlight:hover";

type AppearanceControlDraft = {
  readonly donutHole: number | string;
  readonly highlightSlice: string;
  readonly legendPosition: MermaidPieAppearanceDraft["options"]["legendPosition"];
  readonly showData: boolean;
  readonly textPosition: number | string;
};

function appearanceControlDraft(
  props: MermaidPieReactHostProps,
): AppearanceControlDraft {
  return {
    donutHole: props.model.options.donutHole,
    highlightSlice: props.model.options.highlightSlice,
    legendPosition: props.model.options.legendPosition,
    showData: props.model.showData,
    textPosition: props.model.options.textPosition,
  };
}

function appearanceProjection(
  draft: AppearanceControlDraft,
  props: MermaidPieReactHostProps,
): MermaidPieAppearanceDraft | null {
  if (
    typeof draft.textPosition !== "number" ||
    !Number.isFinite(draft.textPosition) ||
    draft.textPosition < 0 ||
    draft.textPosition > 1 ||
    typeof draft.donutHole !== "number" ||
    !Number.isFinite(draft.donutHole) ||
    draft.donutHole < 0 ||
    draft.donutHole > 0.9 ||
    (draft.highlightSlice !== "" &&
      draft.highlightSlice !== "hover" &&
      !props.sliceIdForLabel(draft.highlightSlice))
  ) {
    return null;
  }
  return {
    options: {
      donutHole: draft.donutHole,
      highlightSlice: draft.highlightSlice,
      legendPosition: draft.legendPosition,
      textPosition: draft.textPosition,
    },
    showData: draft.showData,
  };
}

export function MermaidPieSettingsPopover({
  onApply,
  onPreview,
  onStale,
  props,
}: {
  readonly onApply: (draft: MermaidPieAppearanceDraft) => boolean;
  readonly onPreview: (draft: MermaidPieAppearanceDraft | null) => void;
  readonly onStale: () => void;
  readonly props: MermaidPieReactHostProps;
}) {
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState(() => appearanceControlDraft(props));
  const sourceHashRef = useRef(props.model.sourceHash);
  const updateDraft = (next: AppearanceControlDraft) => {
    setDraft(next);
    onPreview(appearanceProjection(next, props));
  };
  const cancel = () => {
    setDraft(appearanceControlDraft(props));
    onPreview(null);
    setOpened(false);
  };
  const open = () => {
    const next = appearanceControlDraft(props);
    setDraft(next);
    onPreview(appearanceProjection(next, props));
    setOpened(true);
  };
  const valid = appearanceProjection(draft, props);
  const highlightValid =
    draft.highlightSlice === "" ||
    draft.highlightSlice === "hover" ||
    Boolean(props.sliceIdForLabel(draft.highlightSlice));
  useEffect(() => {
    if (sourceHashRef.current === props.model.sourceHash) return;
    sourceHashRef.current = props.model.sourceHash;
    if (!opened) return;
    cancel();
    onStale();
  }, [onStale, opened, props.model.sourceHash]);
  if (props.readonly) return null;
  return (
    <Popover
      opened={opened}
      onChange={(nextOpened) => {
        if (nextOpened) {
          open();
        } else cancel();
      }}
      returnFocus
      trapFocus
    >
      <PopoverTarget>
        <IconButton
          aria-label={props.labels.appearance}
          aria-pressed={opened}
          icon={<PaletteIcon />}
          onClick={() => (opened ? cancel() : open())}
          tooltip={props.labels.appearance}
          variant={opened ? "solid" : "plain"}
        />
      </PopoverTarget>
      <PopoverContent>
        <Stack gap="xs">
          <Switch
            aria-label={props.labels.showData}
            checked={draft.showData}
            onChange={(showData) => updateDraft({ ...draft, showData })}
          >
            {props.labels.showData}
          </Switch>
          <NumberInput
            aria-label={props.labels.textPosition}
            error={
              typeof draft.textPosition !== "number" ||
              !Number.isFinite(draft.textPosition) ||
              draft.textPosition < 0 ||
              draft.textPosition > 1
                ? props.labels.invalid
                : undefined
            }
            label={props.labels.textPosition}
            max={1}
            min={0}
            onChange={(textPosition) => updateDraft({ ...draft, textPosition })}
            step={0.05}
            value={draft.textPosition}
          />
          <NumberInput
            aria-label={props.labels.donutHole}
            error={
              typeof draft.donutHole !== "number" ||
              !Number.isFinite(draft.donutHole) ||
              draft.donutHole < 0 ||
              draft.donutHole > 0.9
                ? props.labels.invalid
                : undefined
            }
            label={props.labels.donutHole}
            max={0.9}
            min={0}
            onChange={(donutHole) => updateDraft({ ...draft, donutHole })}
            step={0.05}
            value={draft.donutHole}
          />
          <MyoxusSelect
            aria-label={props.labels.legendPosition}
            data={Object.entries(props.labels.legendPositions).map(
              ([value, label]) => ({ label, value }),
            )}
            label={props.labels.legendPosition}
            onChange={(legendPosition) =>
              updateDraft({
                ...draft,
                legendPosition:
                  legendPosition as AppearanceControlDraft["legendPosition"],
              })
            }
            value={draft.legendPosition}
          />
          <MyoxusSelect
            aria-label={props.labels.highlightSlice}
            data={[
              { label: props.labels.highlightNone, value: HIGHLIGHT_NONE },
              { label: props.labels.highlightHover, value: HIGHLIGHT_HOVER },
              ...props.sliceOptions,
            ]}
            error={highlightValid ? undefined : props.labels.invalid}
            label={props.labels.highlightSlice}
            onChange={(value) => {
              const highlightSlice =
                value === HIGHLIGHT_NONE
                  ? ""
                  : value === HIGHLIGHT_HOVER
                    ? "hover"
                    : (props.sliceLabelForId(value) ?? draft.highlightSlice);
              updateDraft({ ...draft, highlightSlice });
            }}
            value={
              draft.highlightSlice === ""
                ? HIGHLIGHT_NONE
                : draft.highlightSlice === "hover"
                  ? HIGHLIGHT_HOVER
                  : props.sliceIdForLabel(draft.highlightSlice)
            }
          />
          <Group justify="flex-end" wrap="nowrap">
            <Button onClick={cancel} variant="plain">
              {props.labels.cancel}
            </Button>
            <Button
              disabled={!valid}
              onClick={() => {
                if (valid && onApply(valid)) cancel();
              }}
            >
              {props.labels.apply}
            </Button>
          </Group>
        </Stack>
      </PopoverContent>
    </Popover>
  );
}

export function MermaidPieAccessibilityPopover({
  onApply,
  onStale,
  props,
}: {
  readonly onApply: (title: string, description: string) => boolean;
  readonly onStale: () => void;
  readonly props: MermaidPieReactHostProps;
}) {
  const [opened, setOpened] = useState(false);
  const [title, setTitle] = useState(props.model.accessibilityTitle);
  const [description, setDescription] = useState(
    props.model.accessibilityDescription,
  );
  const sourceHashRef = useRef(props.model.sourceHash);
  const reset = () => {
    setTitle(props.model.accessibilityTitle);
    setDescription(props.model.accessibilityDescription);
  };
  const close = () => {
    reset();
    setOpened(false);
  };
  const open = () => {
    reset();
    setOpened(true);
  };
  useEffect(() => {
    if (sourceHashRef.current === props.model.sourceHash) return;
    sourceHashRef.current = props.model.sourceHash;
    if (!opened) return;
    close();
    onStale();
  }, [onStale, opened, props.model.sourceHash]);
  if (props.readonly) return null;
  return (
    <Popover
      opened={opened}
      onChange={(nextOpened) => {
        if (nextOpened) {
          open();
        } else close();
      }}
      returnFocus
      trapFocus
    >
      <PopoverTarget>
        <IconButton
          aria-label={props.labels.more}
          aria-pressed={opened}
          icon={<MoreHorizontalIcon />}
          onClick={() => (opened ? close() : open())}
          tooltip={props.labels.more}
          variant={opened ? "solid" : "plain"}
        />
      </PopoverTarget>
      <PopoverContent>
        <Stack gap="xs">
          <MyoxusTextInput
            aria-label={props.labels.accessibilityTitle}
            label={props.labels.accessibilityTitle}
            onChange={setTitle}
            value={title}
          />
          <Textarea
            aria-label={props.labels.accessibilityDescription}
            autosize
            label={props.labels.accessibilityDescription}
            minRows={3}
            onChange={setDescription}
            value={description}
          />
          {props.embedded ? (
            <Button
              prefix={<DownloadIcon />}
              onClick={() => {
                props.onExportMmd();
                close();
              }}
              variant="plain"
            >
              {props.labels.exportMmd}
            </Button>
          ) : null}
          <Group justify="flex-end" wrap="nowrap">
            <Button onClick={close} variant="plain">
              {props.labels.cancel}
            </Button>
            <Button
              onClick={() => {
                if (onApply(title, description)) close();
              }}
            >
              {props.labels.apply}
            </Button>
          </Group>
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
