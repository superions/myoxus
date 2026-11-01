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
  Checkbox,
  ConfirmModal,
  Group,
  MultiSelect,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Popover,
  PopoverContent,
  Scrollable,
  PopoverTarget,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type ErReactHostProps,
  type MermaidErStyle,
} from "@virgultum/block-mermaid";
import { useErDraft } from "./drafts";
const configLabels = {
  titleTopMargin: m.erTitleTopMargin,
  diagramPadding: m.erDiagramPadding,
  minEntityWidth: m.erMinEntityWidth,
  minEntityHeight: m.erMinEntityHeight,
  entityPadding: m.erEntityPadding,
  nodeSpacing: m.erNodeSpacing,
  rankSpacing: m.erRankSpacing,
  fontSize: m.erFontSize,
  fill: m.erFill,
  stroke: m.erStroke,
};
export function ErAppearanceForm({
  props,
  objectId,
  onClose,
}: {
  props: ErReactHostProps;
  objectId?: string;
  onClose?: () => void;
}) {
  const t = useI18n(),
    config = props.config,
    d = useErDraft({ direction: props.model.direction, ...config }, props);
  const [addingStyle, setAddingStyle] = useState(false);
  const styles = props.model.styles.filter(
    (s) => s.kind === "definition" || !objectId || s.owners.includes(objectId),
  );
  return (
    <Stack>
      {!objectId ? (
        <>
          <Select
            label={m.erLayoutDirection()}
            data={["TB", "BT", "LR", "RL"].map((value) => ({
              value,
              label: value,
            }))}
            value={d.value.direction}
            disabled={props.readonly}
            onChange={(value) =>
              d.set("direction", value as typeof d.value.direction)
            }
          />
          <Select
            label={`${m.erLayoutDirection()} · ${m.visualAppearance()}`}
            data={["TB", "BT", "LR", "RL"].map((value) => ({
              value,
              label: value,
            }))}
            value={d.value.layoutDirection}
            disabled={props.readonly}
            onChange={(value) =>
              d.set("layoutDirection", value as typeof d.value.layoutDirection)
            }
          />
          {(
            [
              "titleTopMargin",
              "diagramPadding",
              "minEntityWidth",
              "minEntityHeight",
              "entityPadding",
              "nodeSpacing",
              "rankSpacing",
              "fontSize",
            ] as const
          ).map((key) => (
            <NumberInput
              key={key}
              label={configLabels[key]()}
              value={d.value[key]}
              disabled={props.readonly}
              onChange={(value) => d.set(key, Number(value))}
            />
          ))}
          {(["fill", "stroke"] as const).map((key) => (
            <MyoxusTextInput
              key={key}
              label={configLabels[key]()}
              value={d.value[key]}
              disabled={props.readonly}
              onChange={(value) => d.set(key, value)}
            />
          ))}
          <Checkbox
            label={m.erUseMaxWidth()}
            checked={d.value.useMaxWidth}
            disabled={props.readonly}
            onChange={(event) =>
              d.set("useMaxWidth", event.currentTarget.checked)
            }
          />
          <MyoxusText>{m.erConfigHelp()}</MyoxusText>
          {onClose ? <Button onClick={onClose}>{m.cancel()}</Button> : null}
          {d.diagnostic ? (
            <Alert color="myoxusError" role="alert">
              {d.diagnostic}
            </Alert>
          ) : null}
          {!props.readonly ? (
            <Group>
              {[false, true].map((layout) => (
                <Button
                  key={String(layout)}
                  onClick={() => {
                    const { direction, ...config } = d.value;
                    const changes = Object.fromEntries(
                      Object.entries(config).filter(
                        ([key, value]) =>
                          value !==
                          props.config[key as keyof typeof props.config],
                      ),
                    );
                    const result = d.commit("editErAppearance", [
                      { direction, config: changes, layout },
                    ]);
                    if (!result.diagnostic) onClose?.();
                  }}
                >
                  {layout ? m.classApplyLayout() : t["Save"]()}
                </Button>
              ))}
            </Group>
          ) : null}
        </>
      ) : null}
      <Accordion>
        {styles.map((style) => (
          <AccordionItem key={style.id} value={style.id}>
            <AccordionControl>
              {style.kind === "definition"
                ? style.owners.join(",")
                : style.owners.join(",")}
            </AccordionControl>
            <AccordionPanel>
              <ErStyleForm props={props} style={style} onClose={onClose} />
            </AccordionPanel>
          </AccordionItem>
        ))}
      </Accordion>
      {!props.readonly ? (
        <Popover fitViewport opened={addingStyle} onChange={setAddingStyle}>
          <PopoverTarget>
            <Button onClick={() => setAddingStyle(!addingStyle)}>
              {t["Add"]()}
            </Button>
          </PopoverTarget>
          <PopoverContent>
            <Scrollable.Viewport autosize maxHeight="floating">
              {addingStyle ? (
                <ErNewStyleForm
                  props={props}
                  objectId={objectId}
                  onClose={() => setAddingStyle(false)}
                />
              ) : null}
            </Scrollable.Viewport>
          </PopoverContent>
        </Popover>
      ) : null}
    </Stack>
  );
}
function ErStyleForm({
  props,
  style,
  onClose,
}: {
  props: ErReactHostProps;
  style: MermaidErStyle;
  onClose?: () => void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [removeUses, setRemoveUses] = useState(false);
  const t = useI18n(),
    d = useErDraft(
      {
        name: style.owners[0] ?? "",
        previousName: style.owners[0] ?? "",
        values: Object.fromEntries(
          style.properties.map((p) => [p.name, p.value]),
        ),
        styles: [...style.styles],
        property: "",
        value: "",
      },
      props,
    ),
    v = d.value;
  return (
    <Stack>
      {style.kind === "definition" ? (
        <>
          <Select
            label={m.treemapClasses()}
            data={style.owners.map((value) => ({ value, label: value }))}
            value={v.previousName}
            disabled={props.readonly}
            onChange={(value) => d.set("previousName", value)}
          />
          <MyoxusTextInput
            label={m.treemapClassName()}
            value={v.name}
            disabled={props.readonly}
            onChange={(value) => d.set("name", value)}
          />
          {!props.readonly ? (
            <Button
              onClick={() => {
                const result = d.commit("renameErStyleDefinition", [
                  style.id,
                  v.name,
                  v.previousName,
                ]);
                if (!result.diagnostic) onClose?.();
              }}
            >
              {t["Rename"]()}
            </Button>
          ) : null}
        </>
      ) : null}
      {style.kind === "assignment" ? (
        <>
          <MultiSelect
            label={m.treemapClassName()}
            value={v.styles}
            disabled={props.readonly}
            data={[
              ...new Set([
                ...v.styles,
                ...props.model.styles
                  .filter((s) => s.kind === "definition")
                  .flatMap((s) => s.owners),
              ]),
            ]}
            onChange={(value) => d.set("styles", value)}
          />
          {!props.readonly ? (
            <Button
              onClick={() => {
                const result = d.commit("editErStyleAssignment", [
                  style.id,
                  v.styles,
                ]);
                if (!result.diagnostic) onClose?.();
              }}
            >
              {t["Save"]()}
            </Button>
          ) : null}
        </>
      ) : null}
      {style.properties.map((property) => (
        <Group key={property.name}>
          <MyoxusTextInput
            label={property.name}
            value={v.values[property.name] ?? property.value}
            disabled={props.readonly}
            onChange={(value) =>
              d.set("values", { ...v.values, [property.name]: value })
            }
          />
          {!props.readonly ? (
            <>
              <Button
                onClick={() => {
                  const result = d.commit("setErStyleProperty", [
                    style.id,
                    property.name,
                    v.values[property.name],
                  ]);
                  if (!result.diagnostic) onClose?.();
                }}
              >
                {t["Save"]()}
              </Button>
              <Button
                onClick={() => {
                  setDeleting(property.name);
                }}
              >
                {m.visualDelete()}
              </Button>
            </>
          ) : null}
        </Group>
      ))}
      {style.kind !== "assignment" && !props.readonly ? (
        <>
          <MyoxusTextInput
            label={m.property()}
            value={v.property}
            onChange={(value) => d.set("property", value)}
          />
          <MyoxusTextInput
            label={m.value()}
            value={v.value}
            onChange={(value) => d.set("value", value)}
          />
          <Button
            onClick={() => {
              const result = d.commit("setErStyleProperty", [
                style.id,
                v.property,
                v.value,
              ]);
              if (!result.diagnostic) onClose?.();
            }}
          >
            {t["Save"]()}
          </Button>
        </>
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {!props.readonly ? (
        <Button
          onClick={() => {
            setDeleting("");
          }}
        >
          {m.visualDelete()}
        </Button>
      ) : null}
      <ConfirmModal
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          const result = deleting
            ? d.commit("setErStyleProperty", [style.id, deleting, undefined])
            : d.commit("deleteErStyle", [style.id, removeUses]);
          if (!result.diagnostic) {
            setDeleting(null);
            onClose?.();
          }
        }}
      >
        <Stack>
          <MyoxusText>
            {deleting
              ? `${deleting}: ${v.values[deleting] ?? ""}`
              : props.model.sourceDocument.records.find(
                  (r) => r.sourceKey === style.id,
                )?.raw}
          </MyoxusText>
          {!deleting && style.kind === "definition" ? (
            <>
              {props.model.sourceDocument.records
                .filter(
                  (r) =>
                    r.sourceKey !== style.id &&
                    r.references.some(
                      (ref) =>
                        ref.kind === "style" && style.owners.includes(ref.id),
                    ),
                )
                .map((r) => (
                  <MyoxusText key={r.sourceKey}>{r.raw}</MyoxusText>
                ))}
              <Checkbox
                checked={removeUses}
                onChange={(e) => setRemoveUses(e.currentTarget.checked)}
                label={m.visualDelete()}
              />
            </>
          ) : null}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
function ErNewStyleForm({
  props,
  objectId,
  onClose,
}: {
  props: ErReactHostProps;
  objectId?: string;
  onClose?: () => void;
}) {
  const t = useI18n(),
    d = useErDraft(
      {
        kind: objectId ? "inline" : "definition",
        owner: objectId ?? "",
        property: "",
        value: "",
        styles: [] as string[],
      },
      props,
    ),
    v = d.value;
  return (
    <Stack>
      <Select
        label={m.treemapType()}
        value={v.kind}
        data={[
          { value: "definition", label: m.treemapClassDefinition() },
          { value: "inline", label: m.quadrantInlineStyle() },
          { value: "assignment", label: m.treemapClasses() },
        ]}
        onChange={(value) => d.set("kind", value)}
      />
      <MyoxusTextInput
        label={v.kind === "definition" ? m.treemapClassName() : m.erEntityId()}
        value={v.owner}
        onChange={(value) => d.set("owner", value)}
      />
      {v.kind === "assignment" ? (
        <MultiSelect
          label={m.treemapClassName()}
          data={props.model.styles
            .filter((s) => s.kind === "definition")
            .flatMap((s) => s.owners)}
          value={v.styles}
          onChange={(value) => d.set("styles", value)}
        />
      ) : (
        <>
          <MyoxusTextInput
            label={m.property()}
            value={v.property}
            onChange={(value) => d.set("property", value)}
          />
          <MyoxusTextInput
            label={m.value()}
            value={v.value}
            onChange={(value) => d.set("value", value)}
          />
        </>
      )}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Button
        onClick={() => {
          const result = d.commit("addErStyle", [
            {
              kind: v.kind as "definition" | "inline" | "assignment",
              owner: v.owner,
              properties: [{ name: v.property, value: v.value }],
              styles: v.styles,
            },
          ]);
          if (!result.diagnostic) onClose?.();
        }}
      >
        {t["Save"]()}
      </Button>
    </Stack>
  );
}
