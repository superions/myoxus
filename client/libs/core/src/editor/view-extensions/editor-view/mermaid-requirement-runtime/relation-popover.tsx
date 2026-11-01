// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Group,
  MyoxusText,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  addRequirementRelation,
  editRequirementRelation,
  mermaidMessages as m,
  REQUIREMENT_RELATIONS,
  type MermaidGfxObjectEditIntent,
  type RequirementReactHostProps,
  type RequirementRelationDraft,
} from "@virgultum/block-mermaid";

export function RequirementReferenceDiagnostics({
  props,
  relationKeys,
}: {
  props: RequirementReactHostProps;
  relationKeys: readonly string[];
}) {
  return props.model.diagnostics
    ?.filter(
      (diagnostic) =>
        relationKeys.includes(diagnostic.sourceKey ?? "") &&
        (diagnostic.code === "missing-reference" ||
          diagnostic.code === "ambiguous-reference"),
    )
    .map((diagnostic, index) => (
      <Alert key={index}>
        {diagnostic.code === "missing-reference"
          ? m.requirementReferenceMissing(diagnostic.construct)
          : m.requirementReferenceAmbiguous(diagnostic.construct)}
      </Alert>
    ));
}

type Proposal = NonNullable<MermaidGfxObjectEditIntent["connection"]>;

/** The form owns only an ephemeral choice. The checked command and the active
 * viewport preview port own the semantic candidate and its actual notation. */
export function RequirementRelationForm({
  props,
  proposal,
  close,
}: {
  props: RequirementReactHostProps;
  proposal: Proposal;
  close: () => void;
}) {
  const t = useI18n(),
    basis = useRef(props.sourceBasis);
  const objects = [...props.model.requirements, ...props.model.elements];
  const relation = props.model.relations.find(
    (relation) => relation.id === proposal.edgeId,
  );
  const [draft, setDraft] = useState<RequirementRelationDraft>(() => ({
    sourceKey:
      objects.find((object) => object.id === proposal.sourceNodeId)
        ?.sourceKey ?? "",
    targetKey:
      objects.find((object) => object.id === proposal.targetNodeId)
        ?.sourceKey ?? "",
    kind: (relation?.kind as RequirementRelationDraft["kind"]) ?? "satisfies",
    sourceForm: relation?.sourceForm ?? "right",
  }));
  const [diagnostic, setDiagnostic] = useState<string>();
  const source = objects.find((object) => object.sourceKey === draft.sourceKey),
    target = objects.find((object) => object.sourceKey === draft.targetKey);
  const candidate = relation?.sourceKey
    ? editRequirementRelation(props.model, relation.sourceKey, draft, {
        baseSource: basis.current,
      })
    : addRequirementRelation(props.model, draft, {
        baseSource: basis.current,
      });
  const valid =
    candidate.status !== "rejected" &&
    !props.readonly &&
    !props.displayOnly &&
    basis.current === props.sourceBasis;
  const preview = useRef<(() => void) | null>(null);
  const clearPreview = () => {
    const dispose = preview.current;
    preview.current = null;
    dispose?.();
  };
  const finish = () => {
    clearPreview();
    close();
  };
  const ports = useRef({ preview: props.previewRelation, close: finish });
  ports.current = { preview: props.previewRelation, close: finish };
  useEffect(() => {
    if (
      props.readonly ||
      props.displayOnly ||
      basis.current !== props.sourceBasis
    )
      ports.current.close();
  }, [props.readonly, props.displayOnly, props.sourceBasis]);
  useEffect(() => {
    const dispose = ports.current.preview(draft, basis.current, proposal);
    preview.current = dispose;
    return () => {
      if (preview.current === dispose) {
        preview.current = null;
        dispose?.();
      }
    };
  }, [draft, proposal]);
  const save = () => {
    if (!valid) return;
    // Restore the real wrappers before the transaction and selection handoff;
    // selecting a still-hidden retained connector would silently clear it.
    clearPreview();
    const result = props.onSaveRelation(draft, basis.current, proposal);
    if (result.diagnostic) setDiagnostic(result.diagnostic);
    else finish();
  };
  const options = objects.flatMap((object) =>
    object.sourceKey
      ? [
          {
            value: object.sourceKey,
            label:
              objects.filter((other) => other.name === object.name).length > 1
                ? `${object.name} (${"requirementType" in object ? object.requirementType : "element"})`
                : object.name,
            disabled:
              objects.filter((other) => other.name === object.name).length !==
              1,
          },
        ]
      : [],
  );
  return (
    <Stack
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish();
        } else if (
          event.key === "Enter" &&
          !(
            event.target instanceof HTMLInputElement &&
            event.target.getAttribute("role") === "combobox"
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }}
    >
      {diagnostic ? <Alert>{diagnostic}</Alert> : null}
      <RequirementReferenceDiagnostics
        props={props}
        relationKeys={relation?.sourceKey ? [relation.sourceKey] : []}
      />
      <Select
        label={m.chartSource()}
        comboboxProps={{ withinPortal: false }}
        value={draft.sourceKey}
        data={options}
        onChange={(value) =>
          setDraft((current) => ({ ...current, sourceKey: value }))
        }
      />
      <Select
        label={m.chartTarget()}
        comboboxProps={{ withinPortal: false }}
        value={draft.targetKey}
        data={options}
        onChange={(value) =>
          setDraft((current) => ({ ...current, targetKey: value }))
        }
      />
      <Select
        label={m.selectedEdgeType()}
        comboboxProps={{ withinPortal: false }}
        value={draft.kind}
        data={REQUIREMENT_RELATIONS.map((value) => ({ value, label: value }))}
        onChange={(value) => {
          if ((REQUIREMENT_RELATIONS as readonly string[]).includes(value))
            setDraft((current) => ({
              ...current,
              kind: value as RequirementRelationDraft["kind"],
            }));
        }}
      />
      {!relation ? (
        <Select
          label={m.relationSourceForm()}
          comboboxProps={{ withinPortal: false }}
          value={draft.sourceForm}
          data={[
            { value: "right", label: `- ${draft.kind} ->` },
            { value: "left", label: `<- ${draft.kind} -` },
          ]}
          onChange={(value) => {
            if (value === "left" || value === "right")
              setDraft((current) => ({ ...current, sourceForm: value }));
          }}
        />
      ) : null}
      {relation ? (
        <Button
          onClick={() =>
            setDraft((current) => ({
              ...current,
              sourceKey: current.targetKey,
              targetKey: current.sourceKey,
            }))
          }
        >
          {t["com.myoxus.editor.toolbar.flip-direction"]()}
        </Button>
      ) : null}
      <MyoxusText>
        {source?.name ?? m.chartSource()} → {target?.name ?? m.chartTarget()}:{" "}
        {`<<${draft.kind}>>`}
      </MyoxusText>
      {candidate.status === "rejected" ? (
        <Alert>
          {[source, target]
            .filter(
              (object) =>
                object &&
                objects.filter((other) => other.name === object.name).length >
                  1,
            )
            .map((object) => object!.name)
            .join(", ")}
          {source && target ? ": " : ""}
          {m.visualConnectionInvalidTarget()}
        </Alert>
      ) : null}
      <Group>
        <Button disabled={!valid} onClick={save}>
          {t.Apply()}
        </Button>
        <Button onClick={finish}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
