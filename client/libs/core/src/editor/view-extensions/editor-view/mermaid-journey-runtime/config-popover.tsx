// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Alert,
  Button,
  Group,
  SimpleGrid,
  Checkbox,
  Select,
  NumberInput,
  Stack,
  MyoxusText,
  MyoxusTextInput,
  Textarea,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@myoxus/ui-facade";
import {
  readJourneyConfig,
  JOURNEY_EFFECTIVE_GEOMETRY_FIELDS,
  sourceValuesEqual,
  mermaidMessages as messages,
  type MermaidJourneyReactHostProps,
  type JourneyCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";
import { MermaidDataValue } from "../mermaid-data-value";
import { JourneyActorsPopover } from "./actors-popover";
export function JourneyConfigPopover({
  props,
  kind,
  onClose,
  highlight,
  onHighlight,
  onOpenStep,
}: {
  props: MermaidJourneyReactHostProps;
  kind: "appearance" | "accessibility" | "actors" | "data";
  onClose: () => void;
  highlight?: string;
  onHighlight: (value: string | undefined) => void;
  onOpenStep: (id: string) => void;
}) {
  const [basis] = useState(props.model.sourceDocument.source);
  const [initial] = useState(
    () => readJourneyConfig(props.model.sourceDocument).effective,
  );
  const [values, setValues] = useState(initial);
  const [title, setTitle] = useState(props.model.accessibilityTitle);
  const [description, setDescription] = useState(
    props.model.accessibilityDescription,
  );
  const [notice, setNotice] = useState(false);
  const readonly = props.readonly || props.model.ambiguous;
  const commands: JourneyCommand[] =
    kind === "appearance" || kind === "data"
      ? [...new Set([...Object.keys(initial), ...Object.keys(values)])]
          .filter((f) => !sourceValuesEqual(values[f], initial[f]))
          .map((field) => ({ type: "config", field, value: values[field] }))
      : kind === "accessibility"
        ? [
            { type: "accessibility", field: "title", value: title },
            { type: "accessibility", field: "description", value: description },
          ]
        : [];
  return (
    <Stack>
      {notice ? <Alert>{messages.ganttDiagnosticConflict()}</Alert> : null}
      {kind === "actors" ? (
        <JourneyActorsPopover
          model={props.model}
          highlight={highlight}
          onHighlight={onHighlight}
          onOpenStep={onOpenStep}
        />
      ) : null}
      {kind === "appearance" ? (
        readonly ? (
          <MermaidDataValue
            label={messages.visualAppearance()}
            value={Object.fromEntries(
              [
                ...JOURNEY_EFFECTIVE_GEOMETRY_FIELDS,
                "useMaxWidth",
                "textPlacement",
              ].map((field) => [field, values[field]]),
            )}
            readonly
            onChange={() => undefined}
          />
        ) : (
          <>
            <SimpleGrid cols={2}>
              {JOURNEY_EFFECTIVE_GEOMETRY_FIELDS.map((field) => (
                <NumberInput
                  key={field}
                  label={messages.timelineConfigProperty(field)}
                  value={Number(values[field])}
                  min={field === "width" || field === "height" ? 1 : 0}
                  readOnly={readonly}
                  hideControls={readonly}
                  onChange={(value) => setValues({ ...values, [field]: value })}
                />
              ))}
            </SimpleGrid>
            <Checkbox
              label={messages.xyUseMaxWidth()}
              checked={values.useMaxWidth !== false}
              disabled={readonly}
              onChange={(event) =>
                setValues({
                  ...values,
                  useMaxWidth: event.currentTarget.checked,
                })
              }
            />
            <Select
              label={messages.timelineConfigProperty("textPlacement")}
              value={String(values.textPlacement ?? "tspan")}
              disabled={readonly}
              data={["tspan", "fo", "old"].map((value) => ({
                value,
                label: value,
              }))}
              onChange={(textPlacement) =>
                setValues({ ...values, textPlacement })
              }
            />
          </>
        )
      ) : null}
      {kind === "accessibility" ? (
        <>
          <MyoxusTextInput
            label={messages.visualAccessibilityTitle()}
            value={title}
            readOnly={readonly}
            onChange={setTitle}
          />
          <Textarea
            label={messages.visualAccessibilityDescription()}
            value={description}
            readOnly={readonly}
            onChange={setDescription}
          />
        </>
      ) : null}
      {kind === "data" ? (
        <>
          <MyoxusText>{messages.journeyRawNoop()}</MyoxusText>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{messages.journeySection()}</TableHead>
                <TableHead>{messages.journeyStep()}</TableHead>
                <TableHead>{messages.journeyScore()}</TableHead>
                <TableHead>{messages.journeyActors()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.model.steps.map((step) => (
                <TableRow key={step.id}>
                  <TableCell>
                    {
                      props.model.sections.find((s) => s.id === step.sectionId)
                        ?.title
                    }
                  </TableCell>
                  <TableCell>
                    <Button variant="plain" onClick={() => onOpenStep(step.id)}>
                      {step.label}
                    </Button>
                  </TableCell>
                  <TableCell>{step.scoreLexeme}</TableCell>
                  <TableCell>{step.actors.join(", ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <MermaidDataValue
            label={messages.treemapData()}
            value={values}
            readonly={readonly}
            onChange={(value) => {
              if (value && typeof value === "object" && !Array.isArray(value))
                setValues(value as Record<string, unknown>);
            }}
          />
        </>
      ) : null}
      <Group>
        <Button variant="plain" onClick={onClose}>
          {messages.cancel()}
        </Button>
        {!readonly &&
        (kind === "appearance" ||
          kind === "accessibility" ||
          kind === "data") ? (
          <Button
            onClick={() => {
              const result = props.onCommand(commands, basis);
              if (result.changed || result.reason === "no-change") onClose();
              else setNotice(true);
            }}
          >
            {messages.architectureApply()}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
