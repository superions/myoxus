// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import type { MermaidArchitecturePropertiesProps } from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

export function MermaidArchitectureObjectPopover({
  props,
}: {
  readonly props: MermaidArchitecturePropertiesProps;
}) {
  const t = useI18n();
  const [invalid, setInvalid] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const incomingValues = JSON.stringify(
    Object.fromEntries(
      props.fields.map((field) => [field.control, field.value]),
    ),
  );
  const initialKind = props.fields.find(
    (field) => field.control === "architectureNodeKind",
  )?.value;
  const selectedKind = values.architectureNodeKind ?? initialKind;
  const conversionNotice =
    initialKind === "service" && selectedKind === "junction"
      ? props.labels.serviceToJunctionWarning
      : initialKind === "junction" && selectedKind === "service"
        ? props.labels.junctionToServiceNotice
        : "";

  useEffect(() => {
    setValues(JSON.parse(incomingValues));
  }, [incomingValues]);
  useEffect(() => {
    setOpened(false);
    setInvalid(null);
  }, [props.selectionKey]);

  if (!props.fields.length) return null;
  return (
    <Popover opened={opened} onChange={setOpened}>
      <PopoverTarget>
        <Button
          aria-expanded={opened}
          onClick={() => setOpened((current) => !current)}
          variant="secondary"
        >
          {props.labels.properties}
        </Button>
      </PopoverTarget>
      <PopoverContent>
        <Stack gap="xs">
          {props.fields.map((field) =>
            field.options ? (
              <Select
                aria-label={field.label}
                data={[...field.options]}
                disabled={props.readonly}
                key={field.control}
                label={field.label}
                onChange={(value) => {
                  setInvalid(null);
                  setValues((current) => ({
                    ...current,
                    [field.control]: value,
                  }));
                }}
                value={values[field.control] ?? field.value}
              />
            ) : (
              <MyoxusTextInput
                aria-label={field.label}
                disabled={props.readonly}
                key={field.control}
                label={field.label}
                onChange={(value) => {
                  setInvalid(null);
                  setValues((current) => ({
                    ...current,
                    [field.control]: value,
                  }));
                }}
                value={values[field.control] ?? field.value}
              />
            ),
          )}
          {invalid ? (
            <Alert color="myoxusError" role="alert" variant="light">
              {invalid}
            </Alert>
          ) : null}
          {conversionNotice ? (
            <Alert color="myoxusWarning" role="status" variant="light">
              {conversionNotice}
            </Alert>
          ) : null}
          {props.iconDiagnostic ? (
            <Alert color="myoxusWarning" role="status" variant="light">
              {props.iconDiagnostic}
            </Alert>
          ) : null}
          {!props.readonly ? (
            <Button
              onClick={() => {
                const diagnostic = props.onPropertiesApply(
                  props.fields.map((field) => ({
                    control: field.control,
                    value: values[field.control] ?? field.value,
                  })),
                );
                setInvalid(diagnostic);
                if (!diagnostic) setOpened(false);
              }}
              variant="primary"
            >
              {t["com.myoxus.editCollection.save"]()}
            </Button>
          ) : null}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
