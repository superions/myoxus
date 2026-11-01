// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMindmapDraftBasis, handleMindmapSelectKeyDown } from "./drafts";
import { MindmapShapePreview, mindmapShapeLabel } from "./shape-preview";
import { MindmapIconPreview } from "./icon-preview";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Group,
  MyoxusText,
  Textarea,
  MyoxusTextInput,
  Stack,
  MyoxusSelect,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  mindmapRuntimeContract,
  isMindmapShape,
  isMindmapSyntaxId,
  mindmapBundledIcons,
  type MermaidMindmapShape,
  type MindmapLabelForm,
  type MindmapEditIntent,
  type MindmapReactHostProps,
} from "@virgultum/block-mermaid";

/** Draft and basis remain local until one checked command accepts the edit. */
export function MindmapNodeForm({
  props,
  intent,
  onClose,
}: {
  props: MindmapReactHostProps;
  intent: Extract<MindmapEditIntent, { type: "properties" }>;
  onClose: () => void;
}) {
  const t = useI18n();
  const node = props.model.nodes.find(
    (candidate) => candidate.sourceKey === intent.key,
  );
  const [label, setLabel] = useState(node?.label ?? "");
  const [shape, setShape] = useState<MermaidMindmapShape>(
    node?.shape ?? "default",
  );
  const [form, setForm] = useState<MindmapLabelForm>(
    node?.syntax?.labelForm ?? "bare",
  );
  // The native DB falls back to the label for ID-less shapes. This control
  // edits only the authored ID prefix, independently of that effective name.
  const sourceId = node?.syntax?.open ? node.syntax.syntaxId : "";
  const [syntaxId, setSyntaxId] = useState(sourceId);
  const [icon, setIcon] = useState(node?.icon ?? "");
  const [classes, setClasses] = useState(node?.class ?? "");
  const separateId =
    Boolean(node?.syntax?.open) || shape !== "default" || form !== "bare";
  const idInvalid = separateId && !isMindmapSyntaxId(syntaxId);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const basis = useMindmapDraftBasis(props, onClose);
  const preview = useRef<(() => void) | null>(null);
  const disposePreview = () => {
    preview.current?.();
    preview.current = null;
  };
  useEffect(() => () => preview.current?.(), []);
  const draft = { label, shape, form, syntaxId, icon, classes };
  const commandFor = (patch: Partial<typeof draft> = {}) => {
    const next = { ...draft, ...patch };
    const separate =
      Boolean(node?.syntax?.open) ||
      next.shape !== "default" ||
      next.form !== "bare";
    return {
      type: "rename" as const,
      key: intent.key,
      label: next.label,
      shape: next.shape,
      form: next.form,
      ...(next.icon !== (node?.icon ?? "") ? { icon: next.icon } : {}),
      ...(next.classes !== (node?.class ?? "")
        ? { classes: next.classes }
        : {}),
      ...(separate && next.syntaxId !== sourceId
        ? { syntaxId: next.syntaxId }
        : {}),
    };
  };
  const showPreview = (patch: Partial<typeof draft>) => {
    disposePreview();
    preview.current = props.onPreview?.(commandFor(patch), basis) ?? null;
  };
  const cancel = () => {
    disposePreview();
    onClose();
  };
  const save = () => {
    if (props.readonly || props.displayOnly || !label || idInvalid) return;
    disposePreview();
    const result = props.onCommand(commandFor(), basis);
    if (result.diagnostic) setDiagnostic(result.diagnostic);
    else onClose();
  };
  return (
    <Stack
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        } else if (
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          !event.shiftKey &&
          event.target instanceof HTMLTextAreaElement
        ) {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }}
    >
      <Textarea
        autoFocus
        autosize
        label={m.selectedNodeLabel()}
        value={label}
        disabled={props.readonly || props.displayOnly}
        onChange={(value) => {
          setLabel(value);
          setDiagnostic(null);
          showPreview({ label: value });
        }}
      />
      <MyoxusTextInput
        label={m.mindmapNodeId()}
        value={separateId ? syntaxId : label}
        disabled={props.readonly || props.displayOnly || !separateId}
        description={separateId ? undefined : m.mindmapBareIdHelp()}
        error={idInvalid ? m.mindmapIdInvalid() : undefined}
        onChange={(value) => {
          setSyntaxId(value);
          setDiagnostic(null);
          showPreview({ syntaxId: value });
        }}
      />
      <MyoxusSelect
        onKeyDown={handleMindmapSelectKeyDown}
        label={m.quadrantLabelForm()}
        comboboxProps={{ withinPortal: false }}
        value={form}
        data={[
          { value: "bare", label: m.mindmapUnquoted() },
          { value: "quoted", label: m.quadrantQuoted() },
          { value: "markdown", label: m.quadrantMarkdown() },
        ]}
        onChange={(value) => {
          if (value === "bare" || value === "quoted" || value === "markdown") {
            setForm(value);
            setDiagnostic(null);
            showPreview({ form: value });
          }
        }}
      />
      <MyoxusSelect
        onKeyDown={handleMindmapSelectKeyDown}
        label={m.selectedMindmapShape()}
        comboboxProps={{ withinPortal: false }}
        value={shape}
        disabled={props.readonly || props.displayOnly}
        data={mindmapRuntimeContract.shapes.map((value) => ({
          value,
          label: mindmapShapeLabel(value),
        }))}
        renderOption={({ option }) =>
          isMindmapShape(option.value) ? (
            <Group>
              <MindmapShapePreview shape={option.value} />
              <MyoxusText>{option.label}</MyoxusText>
            </Group>
          ) : (
            option.label
          )
        }
        onChange={(value) => {
          if (isMindmapShape(value)) {
            setShape(value);
            setDiagnostic(null);
            showPreview({ shape: value });
          }
        }}
      />
      <MyoxusTextInput
        label={m.architectureIcon()}
        value={icon}
        onChange={(value) => {
          setIcon(value);
          setDiagnostic(null);
          showPreview({ icon: value });
        }}
      />
      <MyoxusSelect
        onKeyDown={handleMindmapSelectKeyDown}
        label={t.t("com.myoxus.icon-picker.select-icon")}
        comboboxProps={{ withinPortal: false }}
        value={Object.hasOwn(mindmapBundledIcons, icon) ? icon : null}
        data={Object.keys(mindmapBundledIcons).map((value) => ({
          value,
          label: value,
        }))}
        renderOption={({ option }) => (
          <Group>
            <MindmapIconPreview name={option.value} />
            <MyoxusText>{option.label}</MyoxusText>
          </Group>
        )}
        onChange={(value) => {
          setIcon(value);
          setDiagnostic(null);
          showPreview({ icon: value });
        }}
      />
      {icon && !Object.hasOwn(mindmapBundledIcons, icon) ? (
        <Alert>{m.mindmapIconUnavailable(icon)}</Alert>
      ) : null}
      <MyoxusTextInput
        label={m.treemapClasses()}
        value={classes}
        onChange={(value) => {
          setClasses(value);
          setDiagnostic(null);
          showPreview({ classes: value });
        }}
      />
      {classes ? <Alert>{m.mindmapClassesUnavailable(classes)}</Alert> : null}
      {diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly || props.displayOnly || !label || idInvalid}
          onClick={save}
        >
          {t.Save()}
        </Button>
        <Button variant="default" onClick={cancel}>
          {t.Cancel()}
        </Button>
      </Group>
    </Stack>
  );
}
