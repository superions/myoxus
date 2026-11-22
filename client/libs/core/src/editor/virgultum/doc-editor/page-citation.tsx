// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useService } from "@myoxus/infra";
import { Popover, PopoverContent, PopoverTarget } from "@myoxus/ui-facade";
import { createAbsolutePositionFromRelativePosition } from "yjs";
import {
  LinkPreviewCache,
  awaitDocEmbedReference,
  type EditorCitationControls,
} from "@virgultum/core/services";
import { buildImageProxyURL } from "@virgultum/core/adapters";
import { isValidUrl, normalizeUrl } from "@virgultum/core/utils/url";
import { citationControls } from "@virgultum/content/citation-controls";
import { CoreDocEmbedProvider, DocsService } from "../../../modules/doc";
import { WorkspaceService } from "../../../modules/workspace";
import { DocDisplayMetaService } from "../../../modules/doc-display-meta";
import { GuardService } from "../../../modules/permissions";
import { PeekViewService } from "../../../modules/peek-view";
import { ServerService } from "../../../modules/server";
import { workspaceLinkPreview } from "../../view-extensions/link-preview-service/link-preview-service";
import { FootnoteMarker } from "../../view-extensions/editor-view/footnote";
import { EditorCitationPreview } from "../../view-extensions/editor-view/editor-chrome/citation-preview";
import type { PageInlineObject } from "./page-inline-object";
import type { PageLine } from "./plain-page-model";

export default function PageCitation({
  object,
  line,
  field,
  readonly,
}: {
  object: Extract<PageInlineObject, { kind: "citation" }>;
  line: PageLine;
  field: HTMLElement;
  readonly: boolean;
}) {
  const guard = useService(GuardService),
    docs = useService(DocsService),
    workspace = useService(WorkspaceService).workspace,
    meta = useService(DocDisplayMetaService),
    peek = useService(PeekViewService).peekView,
    base = useService(ServerService).server.baseUrl;
  const [open, setOpen] = useState(false),
    [controls, setControls] = useState<EditorCitationControls>(),
    timer = useRef<ReturnType<typeof setTimeout>>(undefined),
    lease = useRef<AbortController | null>(null);
  const store = line.model.store,
    footnote = object.value;
  const offset = () => {
    if (!field.isConnected || store.getModelById(line.model.id) !== line.model)
      return;
    const at = createAbsolutePositionFromRelativePosition(
      object.start,
      store.spaceDoc,
    );
    if (
      at?.type === line.text &&
      JSON.stringify(
        line.model.text?.sliceToDelta(at.index, at.index + 1)[0]?.attributes
          ?.footnote,
      ) === JSON.stringify(footnote)
    )
      return at.index;
    return undefined;
  };
  const activate = async () => {
    const { reference: r } = footnote;
    if (offset() === undefined) return;
    if (r.type === "url" && r.url) {
      const url = normalizeUrl(r.url);
      if (url && isValidUrl(url))
        window.open(url, "_blank", "noopener,noreferrer");
    }
    if (r.type !== "doc" || !r.docId) return;
    lease.current?.abort();
    const abort = new AbortController();
    lease.current = abort;
    const provider = new CoreDocEmbedProvider(guard, docs, workspace);
    try {
      const target = await awaitDocEmbedReference(
        provider,
        r.docId,
        r.workspaceId ?? workspace.id,
        AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
      );
      try {
        if (
          target &&
          (await target.access.canRead(target.docId)) &&
          !abort.signal.aborted &&
          offset() !== undefined
        )
          void peek
            .open({
              docRef: {
                docId: target.docId,
                workspaceId: target.collection.id,
              },
            })
            .catch(console.error);
      } finally {
        target?.dispose();
      }
    } catch (e) {
      if (!abort.signal.aborted) console.error(e);
    } finally {
      provider.dispose();
    }
  };
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      lease.current?.abort();
    },
    [],
  );
  useLayoutEffect(() => {
    if (!open) {
      setControls(undefined);
      return;
    }
    const abort = new AbortController(),
      provider = new CoreDocEmbedProvider(guard, docs, workspace),
      links = workspaceLinkPreview(base, LinkPreviewCache.getInstance());
    const owned = citationControls(
      {
        provider,
        workspace: store.workspace,
        title: (id) => meta.title$(id).signal,
        query: (u, s) => links.query(u, s),
        image: (u) =>
          buildImageProxyURL(u, new URL(BUILD_CONFIG.imageProxyUrl, base).href),
        readonly: () =>
          readonly || store.readonly || store.hasFixedText(line.model),
      },
      field,
      footnote,
      () => (offset() === undefined ? undefined : footnote),
      abort,
      () => {
        void activate();
        setOpen(false);
      },
      (next) => {
        const at = offset();
        if (at !== undefined)
          store.transact(() => line.text.format(at, 1, { footnote: next }));
      },
    );
    setControls(owned);
    return () => {
      abort.abort();
      provider.dispose();
    };
  }, [
    open,
    guard,
    docs,
    workspace,
    base,
    meta,
    store,
    field,
    footnote,
    readonly,
    line.model,
  ]);
  const hover = (value: boolean) => {
    clearTimeout(timer.current);
    if (value && !document.getSelection()?.isCollapsed) return;
    timer.current = setTimeout(() => setOpen(value), value ? 300 : 180);
  };
  return (
    <Popover opened={open} onChange={setOpen} position="top" fitViewport>
      <PopoverTarget>
        <sup onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
          <FootnoteMarker
            label={footnote.label}
            missing={false}
            navigate={() => void activate()}
          />
        </sup>
      </PopoverTarget>
      <PopoverContent>
        <div
          onMouseEnter={() => clearTimeout(timer.current)}
          onMouseLeave={() => hover(false)}
        >
          {controls && <EditorCitationPreview controls={controls} />}
        </div>
      </PopoverContent>
    </Popover>
  );
}
