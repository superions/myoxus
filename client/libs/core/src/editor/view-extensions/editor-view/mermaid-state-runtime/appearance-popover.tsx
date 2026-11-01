// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { isValidUrl, normalizeUrl } from "@virgultum/shared/utils";
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
  type StateReactHostProps,
  type StateStyle,
  stateStyleUses,
  STATE_CONFIG_CONSUMERS,
} from "@virgultum/block-mermaid";
import { useStateDraft } from "./drafts";
export function StateAppearanceForm({
  props,
  objectId,
  onClose,
}: {
  props: StateReactHostProps;
  objectId?: string;
  onClose?: () => void;
}) {
  const t = useI18n(),
    initial = {
      direction: props.model.direction,
      ...props.config,
      hideEmptyDescription: props.model.hideEmptyDescription,
      scaleWidth: props.model.scaleWidth ?? (null as number | null),
    },
    d = useStateDraft(initial, props);
  const [addingStyle, setAddingStyle] = useState(false);
  const styles = props.model.styles.filter(
    (s) => s.kind === "definition" || !objectId || s.owners.includes(objectId),
  );
  const groups = [
    {
      id: "layout",
      label: m.layoutLabel(),
      fields: [
        "titleTopMargin",
        "dividerMargin",
        "padding",
        "miniPadding",
        "nodeSpacing",
        "rankSpacing",
        "noteMargin",
        "labelHeight",
        "edgeLengthFactor",
      ],
    },
    {
      id: "notation",
      label: m.statePseudostate(),
      fields: ["sizeUnit", "forkWidth", "forkHeight", "radius"],
    },
    {
      id: "text",
      label: m.stateHeading(),
      fields: ["fontSize", "textHeight", "titleShift", "compositTitleSize"],
    },
    {
      id: "svg",
      label: m.stateSvgOptions(),
      fields: [
        "defaultRenderer",
        "arrowMarkerAbsolute",
        "useMaxWidth",
        "fontSizeFactor",
      ],
    },
  ] as const;
  const save = (layout: boolean) => {
    const { direction, hideEmptyDescription, scaleWidth, ...config } = d.value;
    const changes = Object.fromEntries(
      Object.entries(config).filter(
        ([key, value]) =>
          value !== props.config[key as keyof typeof props.config],
      ),
    );
    const r = d.commit("editStateAppearance", [
      {
        direction,
        config: changes,
        hideEmptyDescription,
        scaleWidth,
        layout,
      },
    ]);
    if (!r.diagnostic) onClose?.();
  };
  return (
    <Stack>
      {!objectId ? (
        <>
          <Select
            label={m.erLayoutDirection()}
            value={d.value.direction}
            disabled={props.readonly}
            data={["TB", "BT", "LR", "RL"].map((value) => ({
              value,
              label: value,
            }))}
            onChange={(value) =>
              d.set("direction", value as typeof d.value.direction)
            }
          />
          <Accordion>
            {groups.map((group) => (
              <AccordionItem key={group.id} value={group.id}>
                <AccordionControl>{group.label}</AccordionControl>
                <AccordionPanel>
                  <Stack>
                    {group.id === "svg" ? (
                      <MyoxusText>{m.stateSvgOptions()}</MyoxusText>
                    ) : null}
                    {group.fields.map((key) =>
                      key === "defaultRenderer" ? (
                        <Select
                          key={key}
                          label={m.classNativeRenderer()}
                          value={d.value.defaultRenderer}
                          data={["dagre-d3", "dagre-wrapper", "elk"].map(
                            (value) => ({ value, label: value }),
                          )}
                          disabled={props.readonly}
                          onChange={(value) =>
                            d.set(
                              "defaultRenderer",
                              value as typeof d.value.defaultRenderer,
                            )
                          }
                        />
                      ) : key === "arrowMarkerAbsolute" ||
                        key === "useMaxWidth" ? (
                        <Checkbox
                          key={key}
                          label={
                            key === "useMaxWidth"
                              ? m.erUseMaxWidth()
                              : m.sequenceConfigLabel("arrowMarkerAbsolute")
                          }
                          checked={d.value[key]}
                          disabled={props.readonly}
                          onChange={(event) =>
                            d.set(key, event.currentTarget.checked)
                          }
                        />
                      ) : (
                        <NumberInput
                          key={key}
                          label={m.stateConfigLabel(key)}
                          description={
                            STATE_CONFIG_CONSUMERS[key] === "svg"
                              ? m.stateSvgOptions()
                              : undefined
                          }
                          value={Number(d.value[key])}
                          disabled={props.readonly}
                          onChange={(value) =>
                            key === "edgeLengthFactor"
                              ? d.set(key, String(value))
                              : d.set(key, Number(value))
                          }
                        />
                      ),
                    )}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
            ))}
          </Accordion>
          <Checkbox
            label={m.stateConfigHideEmpty()}
            checked={d.value.hideEmptyDescription}
            disabled={props.readonly}
            onChange={(event) =>
              d.set("hideEmptyDescription", event.currentTarget.checked)
            }
          />
          <NumberInput
            label={m.stateConfigScaleWidth()}
            value={d.value.scaleWidth ?? ""}
            disabled={props.readonly}
            onChange={(value) =>
              d.set("scaleWidth", typeof value === "number" ? value : null)
            }
          />
          <MyoxusText>{m.stateNoNativeEffect()}</MyoxusText>
          <Group>
            <Button disabled={props.readonly} onClick={() => save(false)}>
              {t["Save"]()}
            </Button>
            <Button disabled={props.readonly} onClick={() => save(true)}>
              {m.classApplyLayout()}
            </Button>
            {onClose ? <Button onClick={onClose}>{m.cancel()}</Button> : null}
          </Group>
          {d.diagnostic ? (
            <Alert color="myoxusError" role="alert">
              {d.diagnostic}
            </Alert>
          ) : null}
        </>
      ) : null}
      <Accordion>
        {styles.map((style) => (
          <AccordionItem key={style.id} value={style.id}>
            <AccordionControl>{style.owners.join(",")}</AccordionControl>
            <AccordionPanel>
              <StateStyleForm props={props} style={style} onClose={onClose} />
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
                <StateNewStyleForm
                  props={props}
                  objectId={objectId}
                  onClose={() => setAddingStyle(false)}
                />
              ) : null}
            </Scrollable.Viewport>
          </PopoverContent>
        </Popover>
      ) : null}
      {objectId ? <StateLinkForm props={props} objectId={objectId} /> : null}
    </Stack>
  );
}
function StateStyleForm({
  props,
  style,
  onClose,
}: {
  props: StateReactHostProps;
  style: StateStyle;
  onClose?: () => void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [removeUses, setRemoveUses] = useState(false);
  const t = useI18n(),
    d = useStateDraft(
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
                const result = d.commit("renameStateStyleDefinition", [
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
                const result = d.commit("editStateStyle", [
                  style.id,
                  {
                    kind: "assignment",
                    targets: style.owners,
                    classes: v.styles,
                  },
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
                  const result = d.commit("setStateStyleProperty", [
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
              const result = d.commit("setStateStyleProperty", [
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
            ? d.commit("setStateStyleProperty", [style.id, deleting, undefined])
            : d.commit("deleteStateStyle", [style.id, removeUses]);
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
                    style.owners.some((name) =>
                      stateStyleUses(props.model, name).some(
                        (use) => use.key === r.sourceKey,
                      ),
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
function StateNewStyleForm({
  props,
  objectId,
  onClose,
}: {
  props: StateReactHostProps;
  objectId?: string;
  onClose?: () => void;
}) {
  const t = useI18n(),
    d = useStateDraft(
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
        label={
          v.kind === "definition" ? m.treemapClassName() : m.stateIdentifier()
        }
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
          const result = d.commit("addStateStyle", [
            {
              kind: v.kind as "definition" | "inline" | "assignment",
              ...(v.kind === "definition"
                ? { name: v.owner }
                : { targets: v.owner.split(",").map((s) => s.trim()) }),
              properties: [{ name: v.property, value: v.value }],
              classes: v.styles,
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

function StateLinkForm({
  props,
  objectId,
}: {
  props: StateReactHostProps;
  objectId: string;
}) {
  const t = useI18n(),
    links = props.model.links.filter((l) => l.stateId === objectId);
  const d = useStateDraft(
    {
      key: links.at(-1)?.sourceKey ?? "",
      url: links.at(-1)?.url ?? "",
      tooltip: links.at(-1)?.tooltip ?? "",
    },
    props,
  );
  const [deleting, setDeleting] = useState(false);
  return (
    <Stack>
      {links.length > 1 ? (
        <Select
          label={m.ganttBindingUrl()}
          value={d.value.key}
          data={links.map((l) => ({ value: l.sourceKey!, label: l.url }))}
          onChange={(value) => {
            const l = links.find((l) => l.sourceKey === value);
            d.set("key", value);
            d.set("url", l?.url ?? "");
            d.set("tooltip", l?.tooltip ?? "");
          }}
        />
      ) : null}
      <MyoxusTextInput
        label={m.ganttBindingUrl()}
        value={d.value.url}
        disabled={props.readonly}
        onChange={(value) => d.set("url", value)}
      />
      <MyoxusTextInput
        label={m.stateConfigLinkTooltip()}
        value={d.value.tooltip}
        disabled={props.readonly}
        onChange={(value) => d.set("tooltip", value)}
      />
      <Group>
        {d.value.url && isValidUrl(d.value.url) ? (
          <Button
            onClick={() =>
              window.open(
                normalizeUrl(d.value.url),
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            {m.sequenceOpenLink()}
          </Button>
        ) : null}
        <Button
          disabled={props.readonly}
          onClick={() =>
            d.commit("editStateLink", [
              {
                target: objectId,
                key: d.value.key || undefined,
                url: d.value.url,
                tooltip: d.value.tooltip,
              },
            ])
          }
        >
          {t["Save"]()}
        </Button>
        {d.value.key ? (
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
        ) : null}
      </Group>
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (
            !d.commit("editStateLink", [
              { target: objectId, key: d.value.key, url: null },
            ]).diagnostic
          )
            setDeleting(false);
        }}
      >
        <MyoxusText>{d.value.url}</MyoxusText>
      </ConfirmModal>
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
    </Stack>
  );
}
