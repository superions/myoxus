// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Alert,
  Button,
  DialogFooterActions,
  Group,
  MenuItem,
  MyoxusTextarea,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Select,
  SimpleGrid,
  Stack,
} from "@myoxus/ui-facade";
import {
  MERMAID_ARCHITECTURE_CONFIG_RULES,
  MERMAID_ARCHITECTURE_NUMERIC_CONFIG_KEYS as NUMBER_FIELDS,
  type MermaidArchitectureConfig,
  type MermaidArchitectureSettingsProps,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

import { MermaidArchitectureCommentPopover } from "./comment-popover";

function readArchitectureSettingsDraft(incoming: string) {
  return JSON.parse(incoming) as {
    accessibilityDescription: string;
    accessibilityTitle: string;
    config: MermaidArchitectureConfig;
  };
}

export function MermaidArchitectureDiagramSettings({
  props,
  trigger = "button",
}: {
  readonly props: MermaidArchitectureSettingsProps;
  readonly trigger?: "button" | "menu-item";
}) {
  const t = useI18n();
  const [accessibilityDescription, setAccessibilityDescription] = useState("");
  const [accessibilityTitle, setAccessibilityTitle] = useState("");
  const [config, setConfig] = useState<MermaidArchitectureConfig>({});
  const [invalid, setInvalid] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const incoming = JSON.stringify({
    accessibilityDescription: props.accessibilityDescription ?? "",
    accessibilityTitle: props.accessibilityTitle ?? "",
    config: props.diagramConfig,
  });
  const metadataComments = (anchorId: string) =>
    props.comments.filter(
      (comment) =>
        comment.anchorKind === "metadata" && comment.anchorId === anchorId,
    );
  const metadataLabel = (label: string, anchorId: string) => (
    <Group justify="space-between" wrap="nowrap">
      <MyoxusText typographySlot="label-strong">{label}</MyoxusText>
      <MermaidArchitectureCommentPopover
        anchor={{ anchorId, anchorKind: "metadata" }}
        comments={metadataComments(anchorId)}
        marker
        props={props}
      />
    </Group>
  );
  const resetDraft = () => {
    const values = readArchitectureSettingsDraft(incoming);
    setAccessibilityDescription(values.accessibilityDescription);
    setAccessibilityTitle(values.accessibilityTitle);
    setConfig(values.config);
    setInvalid(null);
  };

  useEffect(() => {
    const values = readArchitectureSettingsDraft(incoming);
    setAccessibilityDescription(values.accessibilityDescription);
    setAccessibilityTitle(values.accessibilityTitle);
    setConfig(values.config);
    setInvalid(null);
  }, [incoming]);
  const handleOpenChange = (nextOpened: boolean) => {
    if (!nextOpened) resetDraft();
    setOpened(nextOpened);
  };

  return (
    <Popover opened={opened} onChange={handleOpenChange} width="auto">
      <PopoverTarget>
        {trigger === "menu-item" ? (
          <MenuItem
            aria-expanded={opened}
            onSelect={() => handleOpenChange(!opened)}
          >
            {props.labels.diagramSettings}
          </MenuItem>
        ) : (
          <Button
            aria-expanded={opened}
            onClick={() => handleOpenChange(!opened)}
            variant="secondary"
          >
            {props.labels.diagramSettings}
          </Button>
        )}
      </PopoverTarget>
      <PopoverContent>
        <Stack
          data-myoxus-ui-role="mermaid-architecture-diagram-settings"
          gap="xs"
        >
          <Accordion defaultValue="accessibility">
            <AccordionItem value="accessibility">
              <AccordionControl>{props.labels.accessibility}</AccordionControl>
              <AccordionPanel>
                <Stack gap="xs">
                  {metadataLabel(
                    props.labels.accessibilityTitle,
                    "accessibilityTitle",
                  )}
                  <MyoxusTextInput
                    aria-label={props.labels.accessibilityTitle}
                    disabled={props.readonly}
                    onChange={(value) => {
                      setInvalid(null);
                      setAccessibilityTitle(value);
                    }}
                    value={accessibilityTitle}
                  />
                  {metadataLabel(
                    props.labels.accessibilityDescription,
                    "accessibilityDescription",
                  )}
                  <MyoxusTextarea
                    aria-label={props.labels.accessibilityDescription}
                    disabled={props.readonly}
                    onChange={(value) => {
                      setInvalid(null);
                      setAccessibilityDescription(value);
                    }}
                    value={accessibilityDescription}
                  />
                </Stack>
              </AccordionPanel>
            </AccordionItem>
            <AccordionItem value="layout">
              <AccordionControl>
                {t["com.myoxus.editor.mermaid.layout-label"]()}
              </AccordionControl>
              <AccordionPanel>
                <Stack gap="xs">
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    {NUMBER_FIELDS.map((field) => {
                      const rule = MERMAID_ARCHITECTURE_CONFIG_RULES[field];
                      return (
                        <NumberInput
                          allowDecimal
                          allowNegative={
                            !("exclusiveMinimum" in rule) &&
                            !("minimum" in rule)
                          }
                          disabled={props.readonly}
                          key={field}
                          label={props.labels[field]}
                          max={"maximum" in rule ? rule.maximum : undefined}
                          min={"minimum" in rule ? rule.minimum : undefined}
                          onChange={(value) => {
                            setInvalid(null);
                            setConfig((current) => {
                              const next = { ...current };
                              if (
                                value === "" ||
                                !Number.isFinite(Number(value))
                              ) {
                                delete next[field];
                              } else {
                                next[field] = Number(value);
                              }
                              return next;
                            });
                          }}
                          value={config[field] ?? ""}
                        />
                      );
                    })}
                  </SimpleGrid>
                  <Select
                    data={[
                      {
                        label: t["com.myoxus.editor.mermaid.option-default"](),
                        value: "inherited",
                      },
                      { label: t["Enable"](), value: "enabled" },
                      { label: t["Disable"](), value: "disabled" },
                    ]}
                    disabled={props.readonly}
                    label={props.labels.randomize}
                    onChange={(value) => {
                      setInvalid(null);
                      setConfig((current) => {
                        const next = { ...current };
                        if (value === "inherited") delete next.randomize;
                        else next.randomize = value === "enabled";
                        return next;
                      });
                    }}
                    value={
                      config.randomize === undefined
                        ? "inherited"
                        : config.randomize
                          ? "enabled"
                          : "disabled"
                    }
                  />
                  {!props.readonly ? (
                    <Button
                      onClick={() => {
                        setConfig({});
                        setInvalid(null);
                      }}
                      variant="plain"
                    >
                      {t["com.myoxus.editCollection.rules.reset"]()}
                    </Button>
                  ) : null}
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
          {invalid ? (
            <Alert color="myoxusError" role="alert" variant="light">
              {invalid}
            </Alert>
          ) : null}
          {!props.readonly ? (
            <DialogFooterActions>
              <Button
                onClick={() => {
                  resetDraft();
                  setOpened(false);
                }}
                variant="secondary"
              >
                {t["com.myoxus.confirmModal.button.cancel"]()}
              </Button>
              <Button
                onClick={() => {
                  const diagnostic = props.onDiagramSettingsApply({
                    accessibilityDescription,
                    accessibilityTitle,
                    config,
                  });
                  setInvalid(diagnostic);
                  if (!diagnostic) setOpened(false);
                }}
                variant="primary"
              >
                {props.labels.apply}
              </Button>
            </DialogFooterActions>
          ) : null}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
