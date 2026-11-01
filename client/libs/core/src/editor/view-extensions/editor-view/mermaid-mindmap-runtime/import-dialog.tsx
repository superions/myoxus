// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from "react";
import { Modal } from "@myoxus/ui-facade";
import {
  insertMermaidEdgelessDiagramCommand,
  mermaidMessages as m,
  type MindmapImportHostProps,
} from "@virgultum/block-mermaid";
import { FileSizeLimitProvider } from "@virgultum/shared/services";
import { MindmapFileImportForm } from "./import-popover";

/** Native Create shares the owner import form. Candidate reads, loss acceptance
 * and Cancel never create a placeholder diagram or document history entry. */
export function MindmapImportDialog({
  props,
}: {
  props: MindmapImportHostProps;
}) {
  const [open, setOpen] = useState(true);
  const returnFocusRef = useRef<HTMLElement | null>(props.host);
  const close = () => setOpen(false);
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      onExitTransitionEnd={props.onClose}
      returnFocusRef={returnFocusRef}
      title={m.mindmapImport()}
    >
      <MindmapFileImportForm
        native
        fillEmpty={false}
        readonly={!open || props.host.store.readonly}
        importFileSizeLimit={
          props.host.std.get(FileSizeLimitProvider).maxFileSize
        }
        onClose={close}
        onImport={(candidate, position) => {
          if (!open || props.host.store.readonly)
            return { changed: false, diagnostic: m.chartSourceChanged() };
          const [, result] = props.host.std.command.exec(
            insertMermaidEdgelessDiagramCommand,
            {
              source: candidate.source,
              visualModel: candidate.visualModel,
              position,
            },
          );
          return { changed: Boolean(result.insertedMermaidBlockId) };
        }}
      />
    </Modal>
  );
}
