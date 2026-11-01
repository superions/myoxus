// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Alert,
  Button,
  ColorInput,
  Group,
  MyoxusTextInput,
  NumberInput,
  Select,
  Stack,
  Text,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  C4_CONFIG_FIELDS,
  C4_RENDERED_CONFIG_FIELDS,
  c4ConfigHasRendererEffect,
  C4_CONFIG_BOOLEAN_FIELDS,
  C4_CONFIG_GEOMETRY,
  readC4Config,
  editC4Configuration,
  editC4LayoutRows,
  type MermaidC4Config,
  type C4ReactHostProps,
} from "@virgultum/block-mermaid";
import {
  handleC4DraftKeyDown,
  useC4Draft,
  useC4CommandPreview,
} from "./drafts";
import { C4AccessibilityControls } from "./accessibility-popover";
import { C4PreambleControls } from "./data-popover";

export function C4DiagramSettings({
  props,
  onClose,
}: {
  props: C4ReactHostProps;
  onClose: () => void;
}) {
  return (
    <Tabs defaultValue="appearance">
      <TabsList>
        <TabsTrigger value="appearance">{m.visualAppearance()}</TabsTrigger>
        <TabsTrigger value="layout">{m.layoutLabel()}</TabsTrigger>
        <TabsTrigger value="accessibility">
          {m.architectureAccessibility()}
        </TabsTrigger>
        <TabsTrigger value="data">{m.c4Data()}</TabsTrigger>
      </TabsList>
      <TabsContent value="appearance" forceMount={false}>
        <C4ConfigForm props={props} onClose={onClose} />
      </TabsContent>
      <TabsContent value="layout" forceMount={false}>
        <C4LayoutForm props={props} onClose={onClose} />
      </TabsContent>
      <TabsContent value="accessibility" forceMount={false}>
        <C4AccessibilityControls props={props} onClose={onClose} />
      </TabsContent>
      <TabsContent value="data" forceMount={false}>
        <C4PreambleControls props={props} onClose={onClose} />
      </TabsContent>
    </Tabs>
  );
}
function C4LayoutForm({
  props,
  onClose,
}: {
  props: C4ReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useC4Draft(
      {
        shapes: props.model.layoutShapeInRow,
        boundaries: props.model.layoutBoundaryInRow,
      },
      props,
    ),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const prepared = editC4LayoutRows(props.model, d.value);
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    preview.clear();
    if (!d.commit("editC4LayoutRows", [d.value]).diagnostic) close();
  };
  const keys = {
    shapes: "com.myoxus.editor.mermaid.c4-shapes-per-row",
    boundaries: "com.myoxus.editor.mermaid.c4-boundaries-per-row",
  } as const;
  const ignored = readC4Config(props.model.sourceDocument);
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <Text>{m.layoutLabel()} · UpdateLayoutConfig</Text>
      {(["shapes", "boundaries"] as const).map((field) => (
        <NumberInput
          key={field}
          label={t[keys[field]]()}
          value={d.value[field]}
          min={1}
          allowDecimal={false}
          disabled={!writable}
          onChange={(v) => {
            preview.clear();
            d.set(field, typeof v === "number" ? v : Number.NaN);
          }}
        />
      ))}
      {ignored.ignoredRows.map((field) => (
        <Text key={field}>
          {t["com.myoxus.editor.mermaid.c4-ignored-row-config"]({
            field,
            value: String(ignored.effective[field]),
          })}
        </Text>
      ))}
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || prepared.status === "invalid"}
            onClick={() => preview.preview("editC4LayoutRows", [d.value])}
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button
          disabled={!writable || prepared.status === "invalid"}
          onClick={save}
        >
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
function C4ConfigForm({
  props,
  onClose,
}: {
  props: C4ReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n(),
    config = readC4Config(props.model.sourceDocument),
    d = useC4Draft(config.config, props),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const [field, setField] = useState<keyof MermaidC4Config>("c4ShapePadding");
  const changes = Object.fromEntries(
    Object.entries(d.value).filter(
      ([key, value]) =>
        !Object.is(config.config[key as keyof MermaidC4Config], value),
    ),
  ) as Partial<MermaidC4Config>;
  const prepared = editC4Configuration(props.model, changes);
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    preview.clear();
    if (!d.commit("editC4Configuration", [changes]).diagnostic) close();
  };
  const origin = (key: keyof MermaidC4Config) => {
    const provider = config.providers[key],
      owner = config.scopes.find(
        (s) => s.record.sourceKey === provider?.sourceKey,
      );
    return owner
      ? t["com.myoxus.editor.mermaid.c4-record-position"]({
          call: owner.record.kind,
          line: new Intl.NumberFormat(t.language).format(
            owner.record.range.line,
          ),
        })
      : t["com.myoxus.editor.mermaid.c4-new-config-owner"]();
  };
  const set = (
    key: keyof MermaidC4Config,
    value: string | number | boolean,
  ) => {
    preview.clear();
    d.set(key, value);
  };
  const control = (key: keyof MermaidC4Config) => {
    const value = d.value[key],
      label = key === "wrap" ? m.sequenceWrap() : key;
    if ((C4_CONFIG_BOOLEAN_FIELDS as readonly string[]).includes(key))
      return (
        <Select
          key={key}
          label={label}
          description={origin(key)}
          value={value === undefined ? null : String(value)}
          placeholder={m.optionDefault()}
          disabled={!writable}
          data={[
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ]}
          onChange={(v) => {
            if (v === "true" || v === "false") set(key, v === "true");
          }}
        />
      );
    if ((C4_CONFIG_GEOMETRY as readonly string[]).includes(key))
      return (
        <NumberInput
          key={key}
          label={label}
          description={origin(key)}
          value={typeof value === "number" ? value : ""}
          disabled={!writable}
          onChange={(v) => set(key, typeof v === "number" ? v : Number.NaN)}
        />
      );
    if (key.endsWith("_color"))
      return (
        <ColorInput
          allowEmpty
          fixOnBlur={false}
          key={key}
          label={label}
          description={origin(key)}
          value={typeof value === "string" ? value : ""}
          disabled={!writable}
          onChange={(v) => set(key, v)}
        />
      );
    return (
      <MyoxusTextInput
        key={key}
        label={label}
        description={origin(key)}
        value={value === undefined ? "" : String(value)}
        disabled={!writable}
        onChange={(value) => set(key, value)}
      />
    );
  };
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      {control("wrap")}
      {control("width")}
      <Accordion>
        <AccordionItem value="config">
          <AccordionControl>
            {m.visualAppearance()} · config.c4
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              <Select
                label={m.property()}
                value={field}
                searchable
                data={C4_RENDERED_CONFIG_FIELDS.filter(
                  (key) =>
                    key !== "wrap" &&
                    key !== "width" &&
                    c4ConfigHasRendererEffect(key, d.value),
                ).map((key) => ({ value: key, label: key }))}
                onChange={(v) => {
                  const key = C4_CONFIG_FIELDS.find((key) => key === v);
                  if (key) setField(key);
                }}
              />
              {c4ConfigHasRendererEffect(field, d.value)
                ? control(field)
                : null}
              {C4_CONFIG_FIELDS.filter(
                (key) =>
                  Object.hasOwn(config.effective, key) &&
                  !c4ConfigHasRendererEffect(key, d.value),
              ).map((key) => (
                <Text key={key}>
                  {key}: {String(config.effective[key])} ·{" "}
                  {m.stateNoNativeEffect()}
                </Text>
              ))}
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || prepared.status === "invalid"}
            onClick={() => preview.preview("editC4Configuration", [changes])}
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button
          disabled={!writable || prepared.status === "invalid"}
          onClick={save}
        >
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
