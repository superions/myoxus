// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { useI18n } from "@myoxus/i18n";
import { LinkIcon, WebIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { Image, Loading, NavLink, Paper } from "@myoxus/ui-facade";
import { getAttachmentFileIconRC } from "@virgultum/editor/components/icons";
import type { EditorCitationControls } from "@virgultum/editor/shared/services";
import { useSyncExternalStore } from "react";

function DocumentIcon({ docId }: { docId: string }) {
  const meta = useService(DocDisplayMetaService);
  const Icon = useLiveData(meta.icon$(docId));
  return <Icon />;
}

export function EditorCitationPreview({
  controls,
}: {
  controls: EditorCitationControls;
}) {
  const t = useI18n();
  const state = useSyncExternalStore(controls.subscribe, controls.getSnapshot);
  const AttachmentIcon = getAttachmentFileIconRC(state.fileType ?? "");
  const label =
    state.title ||
    (state.loading
      ? t["Loading"]()
      : t["com.myoxus.reference.target-unavailable"]());
  return (
    <Paper withBorder shadow="md" data-myoxus-ui-role="citation-preview">
      <NavLink
        component="button"
        type="button"
        label={label}
        description={state.description}
        title={state.tooltip || label}
        disabled={!state.available}
        // NavLink's disabled prop sets visual state; the native button also needs its disabled attribute.
        attributes={{ root: { disabled: !state.available } }}
        aria-busy={state.loading}
        onClick={controls.activate}
        leftSection={
          state.loading ? (
            <Loading />
          ) : state.kind === "doc" ? (
            state.docId ? (
              <DocumentIcon docId={state.docId} />
            ) : (
              <LinkIcon />
            )
          ) : state.kind === "attachment" ? (
            <AttachmentIcon />
          ) : state.image ? (
            <Image src={state.image} alt="" w="1em" h="1em" fit="contain" />
          ) : (
            <WebIcon />
          )
        }
      />
    </Paper>
  );
}
