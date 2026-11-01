// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Group,
  IconButton,
  Popover,
  PopoverTarget,
  PopoverContent,
  Select,
  Stack,
  MyoxusTextInput,
  Textarea,
} from "@myoxus/ui-facade";
import { SettingsIcon } from "@myoxus/icons";
import {
  mermaidMessages as m,
  REQUIREMENT_DIRECTIONS,
  type RequirementReactHostProps,
} from "@virgultum/block-mermaid";

function DiagramSettingsForm({
  props,
  close,
}: {
  props: RequirementReactHostProps;
  close: () => void;
}) {
  const t = useI18n();
  const basis = useRef(props.sourceBasis),
    [direction, setDirection] = useState(props.model.direction ?? "TB"),
    [title, setTitle] = useState(props.model.accTitle ?? ""),
    [description, setDescription] = useState(
      (props.model.accDescr ?? "").replace(/\r\n|\r/g, "\n"),
    ),
    [diagnostic, setDiagnostic] = useState<string>();
  useEffect(() => {
    if (
      props.readonly ||
      props.displayOnly ||
      basis.current !== props.sourceBasis
    )
      close();
  }, [props.readonly, props.displayOnly, props.sourceBasis, close]);
  const invalid =
    (description.includes("\n") && /[{}]/.test(description)) ||
    /[\r\n]/.test(title);
  const apply = (layout: boolean) => {
    if (invalid) return;
    const result = props.onDiagramSettings(direction, layout, basis.current, {
      title,
      description,
    });
    if (result.diagnostic) setDiagnostic(result.diagnostic);
    else close();
  };
  return (
    <Stack
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      {diagnostic ? <Alert>{diagnostic}</Alert> : null}
      <Select
        label={m.erLayoutDirection()}
        value={direction}
        comboboxProps={{ withinPortal: false }}
        data={REQUIREMENT_DIRECTIONS.map((value) => ({ value, label: value }))}
        onChange={(value) => {
          if ((REQUIREMENT_DIRECTIONS as readonly string[]).includes(value))
            setDirection(value as typeof direction);
        }}
      />
      <MyoxusTextInput
        label={m.architectureAccessibilityTitle()}
        value={title}
        onChange={setTitle}
      />
      <Textarea
        label={m.architectureAccessibilityDescription()}
        value={description}
        onChange={setDescription}
        error={invalid ? m.pieInvalid() : undefined}
        autosize
      />
      <Group>
        <Button
          disabled={props.readonly || props.displayOnly || invalid}
          onClick={() => apply(false)}
        >
          {t.Save()}
        </Button>
        <Button
          disabled={props.readonly || props.displayOnly || invalid}
          onClick={() => apply(true)}
        >
          {m.classApplyLayout()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}

export function RequirementDiagramSettings({
  props,
}: {
  props: RequirementReactHostProps;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      opened={open}
      onChange={setOpen}
      fitViewport
      trapFocus
      returnFocus={false}
      position="bottom-start"
    >
      <PopoverTarget>
        <IconButton
          aria-label={m.architectureDiagramSettings()}
          tooltip={m.architectureDiagramSettings()}
          icon={<SettingsIcon />}
          disabled={props.readonly || props.displayOnly}
          onClick={() => setOpen(true)}
        />
      </PopoverTarget>
      <PopoverContent>
        {open ? (
          <DiagramSettingsForm props={props} close={() => setOpen(false)} />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
