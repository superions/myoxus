// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Group,
  MyoxusTextarea,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
} from "@myoxus/ui-facade";
import type {
  MermaidFlowchartMetadataReactHostProps,
  MermaidFlowchartReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

export function MermaidFlowchartAccessibility({
  embedded = false,
  props,
}: {
  readonly embedded?: boolean;
  readonly props:
    MermaidFlowchartReactHostProps | MermaidFlowchartMetadataReactHostProps;
}) {
  const t = useI18n();
  const [description, setDescription] = useState(
    props.accessibilityDescription ?? "",
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [title, setTitle] = useState(props.accessibilityTitle ?? "");

  useEffect(() => {
    setDescription(props.accessibilityDescription ?? "");
    setTitle(props.accessibilityTitle ?? "");
  }, [props.accessibilityDescription, props.accessibilityTitle]);

  const closeAndReset = () => {
    setDescription(props.accessibilityDescription ?? "");
    setInvalid(null);
    setOpened(false);
    setTitle(props.accessibilityTitle ?? "");
  };

  const fields = (
    <Stack gap="xs">
      <MyoxusTextInput
        disabled={props.readonly}
        label={props.labels.accessibilityTitle}
        onChange={setTitle}
        value={title}
      />
      <MyoxusTextarea
        disabled={props.readonly}
        label={props.labels.accessibilityDescription}
        onChange={setDescription}
        value={description}
      />
      {invalid ? (
        <Alert color="myoxusError" role="alert" variant="light">
          {invalid}
        </Alert>
      ) : null}
      {!props.readonly ? (
        <Group justify="flex-end">
          {!embedded ? (
            <Button onClick={closeAndReset} variant="plain">
              {t["Cancel"]()}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              const diagnostic = props.onAccessibilityApply({
                description,
                title,
              });
              setInvalid(diagnostic);
              if (!diagnostic) setOpened(false);
            }}
            variant="primary"
          >
            {embedded
              ? t["com.myoxus.editCollection.save"]()
              : t["com.myoxus.m.selector.confirm-default"]()}
          </Button>
        </Group>
      ) : null}
    </Stack>
  );

  return embedded ? (
    fields
  ) : (
    <Popover
      opened={opened}
      onChange={(nextOpened) => {
        if (nextOpened) setOpened(true);
        else closeAndReset();
      }}
      returnFocus
      trapFocus
      zIndex="var(--myoxus-z-index-popover)"
    >
      <PopoverTarget>
        <Button
          aria-expanded={opened}
          onClick={() => setOpened((current) => !current)}
          variant="secondary"
        >
          {props.labels.accessibility}
        </Button>
      </PopoverTarget>
      <PopoverContent>{fields}</PopoverContent>
    </Popover>
  );
}
