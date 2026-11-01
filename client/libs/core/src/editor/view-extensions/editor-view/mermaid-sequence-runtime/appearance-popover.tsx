// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Alert,
  Button,
  Checkbox,
  Group,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  SEQUENCE_CONFIG_FIELDS,
  type SequenceConfig,
  type SequenceConfigField,
  type SequenceReactHostProps,
} from "@virgultum/block-mermaid";
import { useSequenceDraft, changedSequenceFields } from "./drafts";
export function SequenceAppearanceForm({
  props,
  onClose,
}: {
  props: SequenceReactHostProps;
  onClose: () => void;
}) {
  const d = useSequenceDraft({ ...props.config }, props),
    numbers = useSequenceDraft({ ...props.model.autonumber }, props);
  const control = (key: SequenceConfigField) =>
    typeof props.config[key] === "boolean" ? (
      <Checkbox
        key={key}
        label={m.sequenceConfigLabel(key)}
        disabled={props.readonly}
        checked={Boolean(d.value[key])}
        onChange={(event) =>
          d.set(key, event.currentTarget.checked as SequenceConfig[typeof key])
        }
      />
    ) : key.endsWith("Align") ? (
      <Select
        key={key}
        label={m.sequenceConfigLabel(key)}
        value={String(d.value[key])}
        disabled={props.readonly}
        data={[
          { value: "left", label: m.pieLegendLeft() },
          { value: "center", label: m.pieLegendCenter() },
          { value: "right", label: m.pieLegendRight() },
        ]}
        onChange={(value) => d.set(key, value as SequenceConfig[typeof key])}
      />
    ) : key.endsWith("Family") ||
      key.endsWith("FontSize") ||
      key.endsWith("Weight") ? (
      <MyoxusTextInput
        key={key}
        label={m.sequenceConfigLabel(key)}
        value={String(d.value[key])}
        disabled={props.readonly}
        onChange={(value) =>
          d.set(
            key,
            (key.endsWith("Family") || !/^\d+(?:\.\d+)?$/.test(value)
              ? value
              : Number(value)) as SequenceConfig[typeof key],
          )
        }
      />
    ) : (
      <NumberInput
        key={key}
        label={m.sequenceConfigLabel(key)}
        value={Number(d.value[key])}
        disabled={props.readonly}
        onChange={(value) =>
          d.set(key, Number(value) as SequenceConfig[typeof key])
        }
      />
    );
  const fields = SEQUENCE_CONFIG_FIELDS.filter(
      (key) => !["arrowMarkerAbsolute", "useMaxWidth"].includes(key),
    ),
    sections = [
      {
        id: "layout",
        label: m.layoutLabel(),
        fields: fields.filter(
          (key) => !key.includes("Font") && !key.endsWith("Align"),
        ),
      },
      {
        id: "participants",
        label: m.sequenceParticipant(),
        fields: fields.filter((key) => key.startsWith("actorFont")),
      },
      {
        id: "messages",
        label: m.sequenceMessage(),
        fields: fields.filter(
          (key) => key.startsWith("messageFont") || key === "messageAlign",
        ),
      },
      {
        id: "notes",
        label: m.sequenceNote(),
        fields: fields.filter(
          (key) => key.startsWith("noteFont") || key === "noteAlign",
        ),
      },
    ];
  return (
    <Stack>
      <Accordion>
        {sections.map((section) => (
          <AccordionItem key={section.id} value={section.id}>
            <AccordionControl>{section.label}</AccordionControl>
            <AccordionPanel>
              <Stack>{section.fields.map(control)}</Stack>
            </AccordionPanel>
          </AccordionItem>
        ))}
        <AccordionItem value="svg">
          <AccordionControl>{m.classNativeRenderer()}</AccordionControl>
          <AccordionPanel>
            <Stack>
              <MyoxusText>{m.sequenceSvgOnly()}</MyoxusText>
              {control("arrowMarkerAbsolute")}
              {control("useMaxWidth")}
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly}
          onClick={() =>
            d.preview("editSequenceAppearance", [
              changedSequenceFields(props.config, d.value),
            ])
          }
        >
          {m.sequencePreview()}
        </Button>
        <Button
          disabled={props.readonly}
          onClick={() => {
            if (
              !d.commit("editSequenceAppearance", [
                changedSequenceFields(props.config, d.value),
              ]).diagnostic
            )
              onClose();
          }}
        >
          {m.sequenceApply()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
      <MyoxusText>{m.sequenceAutonumber()}</MyoxusText>
      <Checkbox
        label={m.sequenceAutonumber()}
        checked={numbers.value.enabled}
        disabled={props.readonly}
        onChange={(event) =>
          numbers.set("enabled", event.currentTarget.checked)
        }
      />
      <NumberInput
        label={m.sequenceNumberStart()}
        value={numbers.value.start}
        disabled={props.readonly}
        onChange={(value) => numbers.set("start", Number(value))}
      />
      <NumberInput
        label={m.sequenceNumberStep()}
        value={numbers.value.step}
        disabled={props.readonly}
        onChange={(value) => numbers.set("step", Number(value))}
      />
      <Group>
        <Button
          disabled={props.readonly}
          onClick={() =>
            numbers.preview("editSequenceAutonumber", [numbers.value])
          }
        >
          {m.sequencePreview()}
        </Button>
        <Button
          disabled={props.readonly}
          onClick={() => {
            if (
              !numbers.commit("editSequenceAutonumber", [numbers.value])
                .diagnostic
            )
              onClose();
          }}
        >
          {m.sequenceApply()}
        </Button>
      </Group>
      {numbers.diagnostic ? (
        <Alert color="myoxusError">{numbers.diagnostic}</Alert>
      ) : null}
    </Stack>
  );
}
