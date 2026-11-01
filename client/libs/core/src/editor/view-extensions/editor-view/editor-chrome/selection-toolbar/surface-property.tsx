// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  ColorInput,
  ColorPicker,
  ColorSwatch,
  IconButton,
  Group,
  Input,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
  MyoxusText,
} from "@myoxus/ui-facade";
import type {
  SelectionAction,
  SelectionControl,
} from "@virgultum/editor/shared/services";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActionButton } from "./block-actions";

function ColorControl({
  action,
  control: c,
  compact = false,
}: {
  action: SelectionAction;
  control: Extract<SelectionControl, { type: "color" }>;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState(c.value);
  const [opened, setOpened] = useState(false);
  const end = useRef<(() => void) | undefined>(undefined);
  useEffect(() => setDraft(c.value), [c.value]);
  const finish = () => {
    const release = end.current;
    end.current = undefined;
    release?.();
  };
  useEffect(() => finish, []);
  const change = (value: string) => {
    setDraft(value);
    if (value === c.value || !CSS.supports("color", value)) return;
    end.current ??= c.start?.();
    c.change(value);
  };
  const open = (next: boolean) => {
    if (!next) finish();
    setOpened(next);
  };
  if (compact)
    return (
      <Popover opened={opened} onChange={open} withinPortal={false} returnFocus>
        <PopoverTarget>
          <IconButton
            aria-label={action.label}
            tooltip={action.label}
            disabled={action.disabled}
            icon={<ColorSwatch color={draft} shape="circle" />}
            onClick={() => open(!opened)}
          />
        </PopoverTarget>
        <PopoverContent role="dialog" aria-label={action.label}>
          <Stack>
            <ColorPicker
              value={draft}
              format="hexa"
              withPicker={c.custom !== false}
              swatches={c.swatches ? [...c.swatches] : undefined}
              onChange={change}
              onChangeEnd={finish}
            />
            {c.custom !== false ? (
              <Input
                aria-label={action.label}
                value={draft}
                onChange={change}
                onBlur={finish}
                onEnter={finish}
              />
            ) : null}
          </Stack>
        </PopoverContent>
      </Popover>
    );
  return (
    <ColorInput
      popoverProps={{ withinPortal: false }}
      allowEmpty
      format="hexa"
      aria-label={action.label}
      label={action.label}
      value={draft}
      swatches={c.swatches ? [...c.swatches] : undefined}
      disabled={action.disabled}
      disallowInput={c.custom === false}
      withPicker={c.custom !== false}
      withEyeDropper={c.custom !== false}
      onChange={change}
      onChangeEnd={finish}
      onBlur={finish}
    />
  );
}
function NumberControl({
  action,
  control: c,
  compact = false,
}: {
  action: SelectionAction;
  control: Extract<SelectionControl, { type: "number" }>;
  compact?: boolean;
}) {
  const [value, setValue] = useState(c.value);
  const [opened, setOpened] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setValue(c.value);
  }, [c.value]);
  const commit = () => {
    if (value === "" || !Number.isFinite(Number(value))) {
      setValue(c.value);
      return;
    }
    const next = Math.min(
      c.max ?? Infinity,
      Math.max(c.min ?? -Infinity, Number(value)),
    );
    setValue(next);
    if (next !== Number(c.value)) c.change(next);
  };
  const open = (next: boolean) => {
    if (next) {
      setValue(c.value);
      c.onOpen?.();
    } else focused.current = false;
    setOpened(next);
  };
  const input = (
    <NumberInput
      aria-label={action.label}
      label={action.label}
      value={value}
      min={c.min}
      max={c.max}
      step={c.step}
      suffix={c.suffix}
      disabled={action.disabled}
      onChange={setValue}
      onFocus={() => {
        focused.current = true;
        if (!compact) c.onOpen?.();
      }}
      onBlur={() => {
        focused.current = false;
        if (!compact) commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          if (compact) setOpened(false);
        }
      }}
    />
  );
  if (!compact) return input;
  return (
    <Popover opened={opened} onChange={open} withinPortal={false} returnFocus>
      <PopoverTarget>
        <Button
          aria-label={action.label}
          tooltip={action.label}
          disabled={action.disabled}
          onClick={() => open(!opened)}
        >
          {c.value}
          {c.suffix}
        </Button>
      </PopoverTarget>
      <PopoverContent role="dialog" aria-label={action.label}>
        <Stack>
          {c.presets?.length ? (
            <Group>
              {c.presets.map((preset) => (
                <Button
                  key={preset}
                  variant={preset === Number(c.value) ? "secondary" : "plain"}
                  aria-pressed={preset === Number(c.value)}
                  onClick={() => {
                    setValue(preset);
                    if (preset !== Number(c.value)) c.change(preset);
                    setOpened(false);
                  }}
                >
                  {preset}
                  {c.suffix}
                </Button>
              ))}
            </Group>
          ) : null}
          {input}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
function TextControl({
  action,
  control: c,
}: {
  action: SelectionAction;
  control: Extract<SelectionControl, { type: "text" }>;
}) {
  const t = useI18n();
  const [opened, setOpened] = useState(false),
    [value, setValue] = useState(c.value),
    [error, setError] = useState<string | null | void>(null);
  const open = (next: boolean) => {
    if (next) {
      setValue(c.value);
      setError(null);
      c.change(c.value);
    }
    setOpened(next);
  };
  const submit = () => {
    c.change(value);
    const next = c.submit?.();
    setError(next);
    if (!next) setOpened(false);
  };
  return (
    <Popover
      opened={opened}
      onChange={open}
      returnFocus
      closeOnEscape
      withinPortal={false}
    >
      <PopoverTarget>
        <ActionButton action={{ ...action, run: () => open(!opened) }} />
      </PopoverTarget>
      <PopoverContent>
        <Stack>
          <Input
            aria-label={action.label}
            value={value}
            placeholder={c.placeholder}
            error={error || undefined}
            onChange={(value) => {
              setValue(value);
              setError(null);
              c.change(value);
            }}
            onEnter={submit}
          />
          <Group>
            <Button onClick={submit}>{t["Save"]()}</Button>
          </Group>
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
export function SurfacePropertyControl({
  action,
  compact = false,
}: {
  action: SelectionAction;
  compact?: boolean;
}) {
  const c = action.control;
  if (!c) return null;
  switch (c.type) {
    case "color":
      return <ColorControl action={action} control={c} compact={compact} />;
    case "number":
      return <NumberControl action={action} control={c} compact={compact} />;
    case "text":
      return <TextControl action={action} control={c} />;
    case "native":
      return c.node as ReactNode;
    case "notice":
      return (
        <MyoxusText role="status">
          {String(c.title)}: {String(c.message)}
        </MyoxusText>
      );
    default:
      return null;
  }
}
