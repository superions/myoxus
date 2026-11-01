// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { Alert, ConfirmModal, MyoxusText } from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  mindmapDeleteImpact,
  type MindmapReactHostProps,
} from "@virgultum/block-mermaid";

export function MindmapDeleteConfirmation({
  props,
  nodeKeys,
  onClose,
  onDeleting,
  resolveReturnFocus,
}: {
  props: MindmapReactHostProps;
  nodeKeys: readonly string[] | null;
  onClose: () => void;
  onDeleting: (root: boolean) => void;
  resolveReturnFocus: () => HTMLElement | null;
}) {
  const t = useI18n();
  const snapshot = useRef<{
    keys: readonly string[];
    signature: string;
    basis: string;
    root: boolean;
    impact: ReturnType<typeof mindmapDeleteImpact>;
  } | null>(null);
  const wasOpen = useRef(false);
  const open = Boolean(nodeKeys?.length);
  const signature = nodeKeys?.join("\0");
  if (
    nodeKeys &&
    (!wasOpen.current || snapshot.current?.signature !== signature)
  ) {
    snapshot.current = {
      keys: [...nodeKeys],
      signature: signature!,
      basis: props.sourceBasis,
      root: Boolean(
        props.model.nodes.some(
          (node) => node.root && nodeKeys.includes(node.sourceKey),
        ),
      ),
      impact: mindmapDeleteImpact(props.model, nodeKeys),
    };
  }
  wasOpen.current = open;
  const target = useRef(resolveReturnFocus);
  target.current = resolveReturnFocus;
  // Resolve after Mantine releases the trap: the deleted invoker may no longer exist.
  const returnFocusRef = useMemo(
    () => ({
      get current() {
        return target.current();
      },
    }),
    [],
  );
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const disabled =
    props.readonly || props.displayOnly || !snapshot.current?.impact;
  useEffect(() => {
    if (open && (disabled || snapshot.current?.basis !== props.sourceBasis))
      onClose();
  }, [open, disabled, props.sourceBasis, onClose]);
  useEffect(() => {
    if (open) setDiagnostic(null);
  }, [open]);
  const impact = snapshot.current?.impact;
  return (
    <ConfirmModal
      open={open}
      title={m.visualDelete()}
      confirmText={m.visualDelete()}
      cancelText={t.Cancel()}
      closeOnConfirm={false}
      returnFocusRef={returnFocusRef}
      confirmButtonOptions={{ variant: "destructive", disabled }}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      onConfirm={() => {
        const selected = snapshot.current;
        if (disabled || !selected) return;
        const result = props.onCommand(
          { type: "delete", keys: selected.keys },
          selected.basis,
        );
        onDeleting(result.changed && selected.root);
        if (result.diagnostic) setDiagnostic(result.diagnostic);
        else onClose();
      }}
    >
      {impact ? <MyoxusText>{m.mindmapDeleteImpact(impact)}</MyoxusText> : null}
      {diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {diagnostic}
        </Alert>
      ) : null}
    </ConfirmModal>
  );
}
