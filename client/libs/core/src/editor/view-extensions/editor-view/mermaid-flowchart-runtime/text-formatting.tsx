// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { TextIcon } from "@myoxus/icons";
import {
  Checkbox,
  IconButton,
  Menu,
  NumberInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages,
  type MermaidFlowchartTypographyReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

/** One form is consumed by Page, embedded and native Surface selections. */
export function FlowchartTextFormatting({
  props,
}: {
  readonly props: MermaidFlowchartTypographyReactHostProps;
}) {
  const t = useI18n();
  const label = mermaidMessages.architectureFontSize();
  const [size, setSize] = useState<string | number>(props.value.fontSize ?? "");
  useEffect(() => setSize(props.value.fontSize ?? ""), [props.value.fontSize]);
  const commit = () => {
    const value = Number(size);
    if (
      !props.readonly &&
      size !== "" &&
      Number.isFinite(value) &&
      value >= 1 &&
      value !== props.value.fontSize
    )
      props.onChange({ fontSize: value });
  };
  return (
    <Menu
      title={label}
      items={
        <Stack
          onKeyDown={(event) => {
            if (event.key !== "Escape") event.stopPropagation();
          }}
        >
          <NumberInput
            label={label}
            min={1}
            value={size}
            disabled={props.readonly}
            onChange={setSize}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
          />
          <Checkbox
            label={t.Bold()}
            disabled={props.readonly}
            checked={props.value.bold === true}
            indeterminate={props.value.bold === null}
            onChange={(event) =>
              props.onChange({ bold: event.currentTarget.checked })
            }
          />
          <Checkbox
            label={t["com.myoxus.editor.keyboard.italic"]()}
            disabled={props.readonly}
            checked={props.value.italic === true}
            indeterminate={props.value.italic === null}
            onChange={(event) =>
              props.onChange({ italic: event.currentTarget.checked })
            }
          />
        </Stack>
      }
    >
      <IconButton
        aria-label={label}
        tooltip={label}
        icon={<TextIcon />}
        disabled={props.readonly}
      />
    </Menu>
  );
}
