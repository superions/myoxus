// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  ConfirmModal,
  MyoxusText,
  Radio,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  requirementDeleteImpact,
  type RequirementReactHostProps,
} from "@virgultum/block-mermaid";

export function RequirementDeleteConfirmation({
  props,
  close,
}: {
  props: RequirementReactHostProps;
  close: () => void;
}) {
  const t = useI18n();
  const groupName = useId();
  const basis = useRef({
    source: props.sourceBasis,
    keys: props.selectedKeys.join("\0"),
  });
  const [references, setReferences] = useState<"keep" | "remove">("keep");
  const [diagnostic, setDiagnostic] = useState<string>();
  const impact = requirementDeleteImpact(props.model, props.selectedKeys);
  useEffect(() => {
    if (
      props.readonly ||
      props.displayOnly ||
      basis.current.source !== props.sourceBasis ||
      basis.current.keys !== props.selectedKeys.join("\0")
    )
      close();
  }, [
    props.readonly,
    props.displayOnly,
    props.sourceBasis,
    props.selectedKeys,
    close,
  ]);
  return (
    <ConfirmModal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={m.visualDelete()}
      confirmText={m.visualDelete()}
      cancelText={m.cancel()}
      onConfirm={() => {
        const result = props.onDelete(
          props.selectedKeys,
          basis.current.source,
          references,
          true,
        );
        if (result.diagnostic) setDiagnostic(result.diagnostic);
        else close();
      }}
    >
      <Stack>
        {diagnostic ? <Alert>{diagnostic}</Alert> : null}
        {impact.changesResolution ? (
          <>
            <MyoxusText>
              {t["com.myoxus.editor.mermaid.requirement-delete-resolution"]()}
            </MyoxusText>
            {impact.resolutions.map((resolution) => (
              <MyoxusText key={resolution.alias}>
                {resolution.before} → {resolution.after}
              </MyoxusText>
            ))}
            <Stack role="radiogroup" aria-label={m.erRelationship()}>
              <Radio
                name={groupName}
                checked={references === "keep"}
                onChange={() => setReferences("keep")}
                label={t[
                  "com.myoxus.editor.mermaid.requirement-delete-keep-relations"
                ]()}
              />
              <Radio
                name={groupName}
                checked={references === "remove"}
                onChange={() => setReferences("remove")}
                label={t[
                  "com.myoxus.editor.mermaid.requirement-delete-remove-relations"
                ]()}
              />
            </Stack>
          </>
        ) : null}
        {impact.records.map((record) => (
          <MyoxusText key={record.key}>
            {record.line}: {record.source}
          </MyoxusText>
        ))}
      </Stack>
    </ConfirmModal>
  );
}
