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
  type ClassReactHostProps,
  type MermaidClassStyle,
} from "@virgultum/block-mermaid";
import { useClassDraft } from "./drafts";
export function ClassAppearanceForm({
  props,
  classId,
  onClose,
}: {
  props: ClassReactHostProps;
  classId?: string;
  onClose?: () => void;
}) {
  const t = useI18n(),
    config = props.config,
    d = useClassDraft(
      {
        direction: props.model.direction,
        padding: config.padding,
        nodeSpacing: config.nodeSpacing,
        rankSpacing: config.rankSpacing,
        defaultRenderer: config.defaultRenderer,
        htmlLabels: config.htmlLabels,
        useMaxWidth: config.useMaxWidth,
        hideEmptyMembersBox: config.hideEmptyMembersBox,
        hierarchicalNamespaces: config.hierarchicalNamespaces,
      },
      props,
    );
  const [addingStyle, setAddingStyle] = useState(false);
  const styles = props.model.styles.filter(
    (s) => s.kind === "definition" || !classId || s.owners.includes(classId),
  );
  return (
    <Stack>
      {!classId ? (
        <>
          <Select
            label={m.classDirection()}
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
          <NumberInput
            label={m.architecturePadding()}
            value={d.value.padding}
            disabled={props.readonly}
            onChange={(value) => d.set("padding", Number(value))}
          />
          <Checkbox
            label={m.classHideEmpty()}
            checked={d.value.hideEmptyMembersBox}
            disabled={props.readonly}
            onChange={(event) =>
              d.set("hideEmptyMembersBox", event.currentTarget.checked)
            }
          />
          <Checkbox
            label={m.classHierarchical()}
            checked={d.value.hierarchicalNamespaces}
            disabled={props.readonly}
            onChange={(event) =>
              d.set("hierarchicalNamespaces", event.currentTarget.checked)
            }
          />
          <NumberInput
            label={m.classNodeSpacing()}
            value={d.value.nodeSpacing}
            disabled={props.readonly}
            onChange={(value) => d.set("nodeSpacing", Number(value))}
          />
          <NumberInput
            label={m.classRankSpacing()}
            value={d.value.rankSpacing}
            disabled={props.readonly}
            onChange={(value) => d.set("rankSpacing", Number(value))}
          />
          <Accordion>
            <AccordionItem value="native">
              <AccordionControl>{m.classNativeRenderer()}</AccordionControl>
              <AccordionPanel>
                <Stack>
                  <Select
                    label={m.classNativeRenderer()}
                    data={[
                      ...new Set([
                        d.value.defaultRenderer,
                        "dagre-wrapper",
                        "dagre",
                      ]),
                    ].map((value) => ({ value, label: value }))}
                    value={d.value.defaultRenderer}
                    disabled={props.readonly}
                    onChange={(value) =>
                      d.set("defaultRenderer", value ?? config.defaultRenderer)
                    }
                  />
                  <Checkbox
                    label={m.classNativeHtml()}
                    checked={d.value.htmlLabels}
                    disabled={props.readonly}
                    onChange={(event) =>
                      d.set("htmlLabels", event.currentTarget.checked)
                    }
                  />
                  <Checkbox
                    label={m.classNativeWidth()}
                    checked={d.value.useMaxWidth}
                    disabled={props.readonly}
                    onChange={(event) =>
                      d.set("useMaxWidth", event.currentTarget.checked)
                    }
                  />
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
          <MyoxusText>{m.classConfigHelp()}</MyoxusText>
          {d.diagnostic ? (
            <Alert color="myoxusError" role="alert">
              {d.diagnostic}
            </Alert>
          ) : null}
          {!props.readonly ? (
            <Group>
              <Button
                onClick={() => {
                  const { direction, ...config } = d.value;
                  const result = d.commit("editClassAppearance", [
                    { direction, config },
                  ]);
                  if (!result.diagnostic) onClose?.();
                }}
              >
                {t["com.myoxus.editCollection.save"]()}
              </Button>
              <Button
                onClick={() => {
                  const { direction, ...config } = d.value;
                  const result = d.commit("editClassAppearance", [
                    { direction, config, layout: true },
                  ]);
                  if (!result.diagnostic) onClose?.();
                }}
              >
                {m.classApplyLayout()}
              </Button>
            </Group>
          ) : null}
        </>
      ) : null}
      <Accordion>
        {styles.map((style) => (
          <AccordionItem key={style.id} value={style.id}>
            <AccordionControl>
              {style.kind === "definition"
                ? style.styles.join(",")
                : style.owners.join(",")}
            </AccordionControl>
            <AccordionPanel>
              <ClassStyleForm props={props} style={style} onClose={onClose} />
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
                <ClassNewStyleForm
                  props={props}
                  classId={classId}
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
function ClassStyleForm({
  props,
  style,
  onClose,
}: {
  props: ClassReactHostProps;
  style: MermaidClassStyle;
  onClose?: () => void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [removeUses, setRemoveUses] = useState(false);
  const t = useI18n(),
    d = useClassDraft(
      {
        name: style.styles[0] ?? "",
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
          <MyoxusTextInput
            label={m.treemapClassName()}
            value={v.name}
            disabled={props.readonly}
            onChange={(value) => d.set("name", value)}
          />
          {!props.readonly ? (
            <Button
              onClick={() => {
                const result = d.commit("renameClassStyleDefinition", [
                  style.id,
                  v.name,
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
                  .flatMap((s) => s.styles),
              ]),
            ]}
            onChange={(value) => d.set("styles", value)}
          />
          {!props.readonly ? (
            <Button
              onClick={() => {
                const result = d.commit("editClassStyleAssignment", [
                  style.id,
                  v.styles,
                ]);
                if (!result.diagnostic) onClose?.();
              }}
            >
              {t["com.myoxus.editCollection.save"]()}
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
                  const result = d.commit("setClassStyleProperty", [
                    style.id,
                    property.name,
                    v.values[property.name],
                  ]);
                  if (!result.diagnostic) onClose?.();
                }}
              >
                {t["com.myoxus.editCollection.save"]()}
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
              const result = d.commit("setClassStyleProperty", [
                style.id,
                v.property,
                v.value,
              ]);
              if (!result.diagnostic) onClose?.();
            }}
          >
            {t["com.myoxus.editCollection.save"]()}
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
            ? d.commit("setClassStyleProperty", [style.id, deleting, undefined])
            : d.commit("deleteClassStyle", [style.id, removeUses]);
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
                        ref.kind === "style" && style.styles.includes(ref.id),
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
function ClassNewStyleForm({
  props,
  classId,
  onClose,
}: {
  props: ClassReactHostProps;
  classId?: string;
  onClose?: () => void;
}) {
  const t = useI18n(),
    d = useClassDraft(
      {
        kind: classId ? "inline" : "definition",
        owner: classId ?? "",
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
          v.kind === "definition" ? m.treemapClassName() : m.classClassId()
        }
        value={v.owner}
        onChange={(value) => d.set("owner", value)}
      />
      {v.kind === "assignment" ? (
        <MultiSelect
          label={m.treemapClassName()}
          data={props.model.styles
            .filter((s) => s.kind === "definition")
            .flatMap((s) => s.styles)}
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
          const result = d.commit("addClassStyle", [
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
        {t["com.myoxus.editCollection.save"]()}
      </Button>
    </Stack>
  );
}
