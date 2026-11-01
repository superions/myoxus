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
  Group,
  MyoxusTextInput,
  Popover,
  PopoverTarget,
  PopoverContent,
  Select,
  Stack,
  Text,
  Scrollable,
} from "@myoxus/ui-facade";
import {
  C4_BOUNDARY_KINDS,
  isC4BoundaryKind,
  readC4BoundaryFields,
  c4BoundaryPresentation,
  editC4BoundaryFields,
  createC4Boundary,
  c4BoundarySourceData,
  mermaidMessages as m,
  type C4ReactHostProps,
  type C4InsertTarget,
  type C4BoundaryFields,
  type MermaidC4BoundaryKind,
  type MermaidC4Boundary,
} from "@virgultum/block-mermaid";
import { C4BoundaryRecordForm } from "./boundary-record-popover";
import { C4DeleteControl } from "./delete-controls";
import { C4AppearanceControl } from "./appearance-popover";
import { C4AliasControl } from "./alias-popover";
import { C4ElementForm } from "./element-popover";
import { C4InsertControls } from "./insert-controls";
import { C4StructureControl } from "./structure-popover";
import {
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
  useC4Draft,
  useC4CommandPreview,
} from "./drafts";

/** Local boundary controls share Source/draft ports with the element editor. */
export function C4BoundaryForm(input: {
  props: C4ReactHostProps;
  boundary?: MermaidC4Boundary;
  initialTarget?: C4InsertTarget;
  onClose: () => void;
}) {
  return input.boundary ? (
    <C4BoundaryEditForm
      key={input.boundary.resolution!.selectionId}
      {...input}
      boundary={input.boundary}
    />
  ) : (
    <C4BoundaryCreateForm {...input} />
  );
}
function C4BoundaryCreateForm({
  props,
  initialTarget,
  onClose,
}: {
  props: C4ReactHostProps;
  initialTarget?: C4InsertTarget;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useC4Draft(
      {
        kind: (props.model.headerLine === "C4Deployment"
          ? "Deployment_Node"
          : "System_Boundary") as MermaidC4BoundaryKind,
        label: "",
        parentKey: initialTarget?.parentKey ?? "",
        beforeKey: initialTarget?.beforeKey ?? "",
      },
      props,
    ),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const value = {
    kind: d.value.kind,
    label: d.value.label,
    target: {
      parentKey: d.value.parentKey || null,
      beforeKey: d.value.beforeKey || undefined,
    },
  };
  const prepared = createC4Boundary(props.model, value);
  const edit = <K extends keyof typeof d.value>(
    key: K,
    value: (typeof d.value)[K],
  ) => {
    preview.clear();
    d.set(key, value);
  };
  const close = () => {
    preview.clear();
    onClose();
    props.resolveReturnFocusTarget()?.focus();
  };
  const save = () => {
    preview.clear();
    if (!d.commit("createC4Boundary", [value]).diagnostic) close();
  };
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <Select
        label={m.erType()}
        value={d.value.kind}
        disabled={!writable}
        data={C4_BOUNDARY_KINDS.map((kind) => ({ value: kind, label: kind }))}
        onChange={(kind) => {
          if (isC4BoundaryKind(kind)) edit("kind", kind);
        }}
      />
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={m.timelineLabel()}
        value={d.value.label}
        disabled={!writable}
        onChange={(value) => edit("label", value)}
      />
      <C4InsertControls
        props={props}
        value={d.value}
        disabled={!writable}
        onChange={edit}
      />
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {prepared.diagnostic ?? d.diagnostic ?? preview.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || prepared.status === "invalid"}
            onClick={() => preview.preview("createC4Boundary", [value])}
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
function C4BoundaryEditForm({
  props,
  boundary,
  onClose,
}: {
  props: C4ReactHostProps;
  boundary: MermaidC4Boundary;
  onClose: () => void;
}) {
  const t = useI18n(),
    id = boundary.resolution!.selectionId;
  const d = useC4Draft(readC4BoundaryFields(props.model, id), props),
    preview = useC4CommandPreview(props);
  const [presentationDiagnostic, setPresentationDiagnostic] = useState<
    string | null
  >(null);
  const writable = !props.readonly && !props.displayOnly,
    prepared = editC4BoundaryFields(props.model, id, d.value);
  const close = () => {
    preview.clear();
    onClose();
    props.resolveReturnFocusTarget()?.focus();
  };
  const save = () => {
    preview.clear();
    if (!d.commit("editC4BoundaryFields", [id, d.value]).diagnostic) close();
  };
  const labels = {
    label: m.timelineLabel(),
    type: m.erType(),
    descr: m.selectedC4Description(),
    tags: m.selectedC4Tags(),
    link: m.selectedC4Link(),
  };
  const visual = props.visualModel?.subgraphs?.find((g) => g.id === id),
    collapsed = !!c4BoundaryPresentation(visual?.familyData).collapsed;
  const fields = Object.keys(d.value) as (keyof C4BoundaryFields)[];
  const renderField = (field: keyof C4BoundaryFields) => {
    const provider = boundary.resolution!.providers[field],
      record = props.model.sourceDocument.records.find(
        (r) => r.sourceKey === provider?.sourceKey,
      );
    return (
      <Stack key={field}>
        <MyoxusTextInput
          autoFocus={field === "label"}
          data-autofocus={field === "label" || undefined}
          label={labels[field]}
          value={d.value[field] ?? ""}
          disabled={!writable}
          onChange={(value) => {
            preview.clear();
            d.set(field, value);
          }}
        />
        <Text>
          {record &&
          provider?.argumentIndex !== undefined &&
          provider.form !== "omitted"
            ? t["com.myoxus.editor.mermaid.c4-record-position"]({
                call: record.callKind!,
                line: new Intl.NumberFormat(t.language).format(
                  record.range.line,
                ),
              })
            : t["com.myoxus.editor.mermaid.c4-new-metadata-update"]()}
        </Text>
      </Stack>
    );
  };
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <Text>{boundary.kind}</Text>
      <Accordion defaultValue="general">
        <AccordionItem value="general">
          <AccordionControl>
            {t["com.myoxus.editor.mermaid.general"]()}
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              {fields
                .filter((key) => key !== "tags" && key !== "link")
                .map(renderField)}
            </Stack>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="metadata">
          <AccordionControl>
            {t["com.myoxus.editor.mermaid.metadata"]()}
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              {fields
                .filter((key) => key === "tags" || key === "link")
                .map(renderField)}
              <C4DeleteControl
                props={props}
                target={{ selectionId: id }}
                onDeleted={onClose}
              />
              <C4AliasControl props={props} selectionId={id} />
              <C4BoundaryRecords props={props} boundary={boundary} />
              <C4StructureControl props={props} selectionId={id} />
              <C4AddChildControl
                props={props}
                parentKey={boundary.resolution!.declarationKey}
              />
            </Stack>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="appearance">
          <AccordionControl>{m.visualAppearance()}</AccordionControl>
          <AccordionPanel>
            <C4AppearanceControl props={props} selectionId={id} />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
      {prepared.diagnostic ||
      d.diagnostic ||
      preview.diagnostic ||
      presentationDiagnostic ? (
        <Alert color="myoxusError" role="alert">
          {prepared.diagnostic ??
            d.diagnostic ??
            preview.diagnostic ??
            presentationDiagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || prepared.status === "invalid"}
            onClick={() =>
              preview.preview("editC4BoundaryFields", [id, d.value])
            }
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
      <Button
        disabled={!writable || !visual || !props.onBoundaryCollapsed}
        onClick={() => {
          preview.clear();
          const result = props.onBoundaryCollapsed?.(
            id,
            !collapsed,
            props.sourceBasis,
          );
          setPresentationDiagnostic(result?.diagnostic ?? null);
          if (result && !result.diagnostic) close();
        }}
      >
        {collapsed ? t["Expand"]() : t["Collapse"]()}
      </Button>
    </Stack>
  );
}
function C4BoundaryRecords({
  props,
  boundary,
}: {
  props: C4ReactHostProps;
  boundary: MermaidC4Boundary;
}) {
  const [opened, setOpened] = useState<string | null>(null),
    t = useI18n();
  const declarations = c4BoundarySourceData(props.model, boundary).declarations;
  if (!declarations.length) return null;
  return (
    <Popover
      closeOnEscape={false}
      fitViewport
      trapFocus
      opened={opened !== null}
      onChange={(value) => {
        if (!value) setOpened(null);
      }}
    >
      <PopoverTarget>
        <Button onClick={() => setOpened("")}>
          {t["com.myoxus.editor.mermaid.c4-records"]({
            count: new Intl.NumberFormat(t.language).format(
              declarations.length,
            ),
          })}
        </Button>
      </PopoverTarget>
      <PopoverContent
        data-myoxus-editor-keyboard-owner="c4"
        onMouseDown={isolateC4PortalledMouseDown}
        onKeyDown={(event) =>
          handleC4PopoverKeyDown(event, () => setOpened(null))
        }
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack>
            {declarations.map((occurrence) => {
              const record = props.model.sourceDocument.records.find(
                (r) => r.sourceKey === occurrence.sourceKey,
              )!;
              return (
                <Stack key={record.sourceKey}>
                  <Button onClick={() => setOpened(record.sourceKey)}>
                    {t["com.myoxus.editor.mermaid.c4-record-position"]({
                      call: record.callKind!,
                      line: new Intl.NumberFormat(t.language).format(
                        record.range.line,
                      ),
                    })}
                  </Button>
                  <Text>
                    {t["com.myoxus.editor.mermaid.c4-record-effects"]({
                      fields: occurrence.effectiveFields.join(", "),
                    })}
                  </Text>
                </Stack>
              );
            })}
            {opened ? (
              <>
                <C4BoundaryRecordForm
                  key={opened}
                  props={props}
                  boundary={boundary}
                  recordKey={opened}
                  onClose={() => setOpened(null)}
                />
                <C4AddChildControl props={props} parentKey={opened} />
              </>
            ) : null}
          </Stack>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
function C4AddChildControl({
  props,
  parentKey,
}: {
  props: C4ReactHostProps;
  parentKey: string;
}) {
  const [opened, setOpened] = useState(false),
    [kind, setKind] = useState<"element" | "boundary" | null>(null),
    t = useI18n();
  return (
    <Popover
      closeOnEscape={false}
      fitViewport
      trapFocus
      opened={opened}
      onChange={setOpened}
    >
      <PopoverTarget>
        <Button
          disabled={props.readonly || props.displayOnly}
          onClick={() => {
            setKind(null);
            setOpened(true);
          }}
        >
          {t["com.myoxus.editor.mermaid.add-child"]()}
        </Button>
      </PopoverTarget>
      <PopoverContent
        data-myoxus-editor-keyboard-owner="c4"
        onMouseDown={isolateC4PortalledMouseDown}
        onKeyDown={(event) =>
          handleC4PopoverKeyDown(event, () => setOpened(false))
        }
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack>
            <Group>
              <Button onClick={() => setKind("element")}>
                {m.visualAddNode()}
              </Button>
              <Button onClick={() => setKind("boundary")}>
                {m.visualAddSubgraph()}
              </Button>
            </Group>
            {kind === "element" ? (
              <C4ElementForm
                key={parentKey}
                props={props}
                initialTarget={{ parentKey }}
                onClose={() => setOpened(false)}
              />
            ) : kind === "boundary" ? (
              <C4BoundaryForm
                key={parentKey}
                props={props}
                initialTarget={{ parentKey }}
                onClose={() => setOpened(false)}
              />
            ) : null}
          </Stack>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
