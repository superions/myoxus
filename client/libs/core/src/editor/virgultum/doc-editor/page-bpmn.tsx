// SPDX-License-Identifier: AGPL-3.0-or-later
import { inspectBpmnSource } from "@myoxus/bpmn-editor/source";
import { useI18n } from "@myoxus/i18n";
import { useServiceOptional } from "@myoxus/infra";
import type { DocFrontendDocState } from "@myoxus/storage";
import {
  coerceBpmnBlockText,
  readBpmnSourceRevisions,
  setBpmnBlockTitle,
  type BpmnBlockPresentationProps,
} from "@virgultum/block-bpmn";
import type { BpmnBlockModel } from "@virgultum/core/models";
import { downloadBlob } from "@virgultum/core/utils";
import { nanoid } from "nanoid";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { of } from "rxjs";
import * as Y from "yjs";
import { BpmnEditorService } from "../../../modules/bpmn-editor/session";
import { ViewService } from "../../../modules/workbench";
import { WorkspaceService } from "../../../modules/workspace";
import {
  BpmnBlockPresentation,
  type PreviewDocStorage,
} from "../../view-extensions/editor-view/bpmn-block-presentation";

const FALLBACK_DOC_STATE: DocFrontendDocState = {
  ready: true,
  loaded: true,
  syncing: false,
  synced: true,
  updating: false,
  remoteMissing: false,
  syncRetrying: false,
  syncErrorMessage: null,
};

const FALLBACK_DOC_STORAGE: PreviewDocStorage = {
  docState$: () => of(FALLBACK_DOC_STATE),
  waitForSynced: () => Promise.resolve(),
};

export default function PageBpmn({
  model,
  readonly,
}: {
  model: BpmnBlockModel;
  readonly: boolean;
}) {
  const t = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    setContainerEl(el);
  }, []);
  const hostIdRef = useRef<string | null>(null);
  const inspectionRef = useRef<{ source: string; accepted: boolean } | null>(
    null,
  );
  const [revision, refresh] = useReducer((n) => n + 1, 0);

  const workspaceService = useServiceOptional(WorkspaceService);
  const bpmnEditorService = useServiceOptional(BpmnEditorService);
  const originView = useServiceOptional(ViewService)?.view;

  useEffect(() => {
    model.yBlock.observeDeep(refresh);
    const stopReadonly = model.store.readonly$.subscribe(refresh);
    return () => {
      model.yBlock.unobserveDeep(refresh);
      stopReadonly();
    };
  }, [model]);

  const effectiveReadonly = readonly || model.store.readonly;
  const docStorage: PreviewDocStorage =
    workspaceService?.workspace.engine.doc ?? FALLBACK_DOC_STORAGE;

  const openEditor = useCallback(async () => {
    const workspaceId = workspaceService?.workspace.id;
    if (!bpmnEditorService || !workspaceId) {
      throw new Error("BPMN_SESSION_UNAVAILABLE");
    }
    hostIdRef.current ??= nanoid();
    const result = await bpmnEditorService.open(
      {
        workspaceId,
        docId: model.store.id,
        blockId: model.id,
        editorHostId: hostIdRef.current,
      },
      effectiveReadonly,
      originView,
    );
    const host = containerRef.current;
    if (host?.isConnected && model.store.getModelById(model.id) === model) {
      host.focus({ preventScroll: true });
    }
    return result;
  }, [
    bpmnEditorService,
    effectiveReadonly,
    model,
    originView,
    workspaceService,
  ]);

  const downloadRevision = useCallback(
    (rev: string) => {
      const heads = model.yBlock.get("prop:sourceHeads");
      const source = heads instanceof Y.Map ? heads.get(rev) : undefined;
      if (typeof source !== "string") {
        throw new Error("BPMN_REVISION_MISSING_SOURCE");
      }
      downloadBlob(
        new Blob([source], { type: "application/xml;charset=utf-8" }),
        `BPMN-${model.id}-${rev}.bpmn`,
      );
    },
    [model],
  );

  const presentation = useMemo<BpmnBlockPresentationProps>(() => {
    void revision;
    let sourceState: BpmnBlockPresentationProps["sourceState"] = "error";
    let sourceRevision: string | null = null;
    try {
      const state = readBpmnSourceRevisions(model.yBlock);
      if (state.status === "conflict") {
        sourceState = "conflict";
      } else if (state.selected) {
        sourceRevision = state.selected;
        const source = state.heads.get(state.selected)!;
        if (inspectionRef.current?.source !== source) {
          inspectionRef.current = {
            source,
            accepted: inspectBpmnSource(source).status === "accepted",
          };
        }
        sourceState = inspectionRef.current.accepted ? "ready" : "error";
      }
    } catch {
      sourceState = "error";
    }
    const rawHeads = model.yBlock.get("prop:sourceHeads");
    const rawPreview = model.props.preview;
    const preview =
      rawPreview &&
      typeof rawPreview.revision === "string" &&
      typeof rawPreview.sourceId === "string" &&
      rawPreview.sourceId
        ? rawPreview
        : null;
    const downloads =
      rawHeads instanceof Y.Map
        ? [...rawHeads]
            .filter(([, value]) => typeof value === "string")
            .map(([rev]) => ({
              revision: rev,
              download: () => downloadRevision(rev),
            }))
        : [];
    return {
      docId: model.store.id,
      title:
        coerceBpmnBlockText(model.props.title) ||
        t["com.myoxus.editor.bpmn.default-title"](),
      titleValue: model.props.title.toString(),
      readonly: effectiveReadonly,
      sourceState,
      sourceRevision,
      preview,
      previewErrorRevision:
        typeof model.props.previewErrorRevision === "string"
          ? model.props.previewErrorRevision
          : null,
      loadPreview: (sourceId) => model.store.blobSync.get(sourceId),
      downloads,
      onTitleChange: (value) => setBpmnBlockTitle(model, value),
      onOpen: async () => {
        await openEditor();
      },
      onRetry: async () => {
        await openEditor();
      },
    };
  }, [downloadRevision, effectiveReadonly, model, openEditor, revision, t]);

  return (
    <div
      ref={setContainerRef}
      data-page-bpmn={model.id}
      data-block-id={model.id}
      contentEditable={false}
      tabIndex={0}
    >
      <BpmnBlockPresentation
        {...presentation}
        docStorage={docStorage}
        projectionRoot={containerEl}
      />
    </div>
  );
}
