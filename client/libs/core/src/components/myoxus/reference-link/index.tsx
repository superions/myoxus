import {
  WorkspaceService,
  WorkspacesService,
  type Workspace as CoreWorkspace,
} from "@myoxus/core/modules/workspace";
import { DocsService } from "@myoxus/core/modules/doc";
import { GuardService } from "@myoxus/core/modules/permissions";
import { parseDocSearchParams } from "@myoxus/core/modules/navigation/utils";
import { useI18n } from "@myoxus/i18n";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { JournalService } from "@myoxus/core/modules/journal";
import { PeekViewService } from "@myoxus/core/modules/peek-view/services/peek-view";
import { useInsidePeekView } from "@myoxus/core/modules/peek-view/view/modal-container";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import {
  FrameworkScope,
  LiveData,
  useLiveData,
  useService,
} from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  InlineDocumentReferenceContent,
  InlineDocumentReferenceIcon,
  InlineDocumentReferenceLink,
  InlineDocumentReferenceTitle,
} from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import type { Store, Workspace } from "@virgultum/editor/store";
import { nanoid } from "nanoid";
import {
  type ComponentType,
  type MouseEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";

interface MyoxusPageReferenceProps {
  pageId: string;
  /** Pending/unavailable canonical resolution overrides the raw source cache. */
  resolutionState?: "checking" | "unavailable";
  workspaceId?: string;
  params?: URLSearchParams;
  title?: string; // title alias
  Icon?: ComponentType;
  onClick?: (e: MouseEvent) => void;
}

type ReferenceState = "checking" | "ready" | "unavailable";

function reachableTarget(store: Store, id: string) {
  let model = store.getModelById(id);
  const root = store.root;
  const seen = new Set<string>();
  for (let depth = 0; model && root && depth <= 100; depth++) {
    if (model.id === root.id) return true;
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    model = store.getParent(model);
  }
  return false;
}

/** Keep native identity, not a heading slug or a once-loaded cached block. */
function useReferenceState(pageId: string, params?: URLSearchParams) {
  const guard = useService(GuardService);
  const docs = useService(DocsService);
  const permission$ = useMemo(
    () => guard.can$("Doc_Read", pageId),
    [guard, pageId],
  );
  const readable = useLiveData(permission$);
  useEffect(
    () => guard.revalidateDocPermissionIfMissing("Doc_Read", pageId),
    [guard, pageId],
  );
  const selector = params?.toString() ?? "";
  const blockIds = useMemo(
    () => parseDocSearchParams(selector).blockIds,
    [selector],
  );
  const precise = params?.has("blockIds") ?? false;
  const record$ = useMemo<ReturnType<typeof docs.list.doc$>>(
    () =>
      readable === true
        ? docs.list.doc$(pageId)
        : new LiveData<ReturnType<typeof docs.list.doc$>["value"]>(undefined),
    [docs, pageId, readable],
  );
  const record = useLiveData(record$);
  const listReady = useLiveData(docs.list.isReady$);
  const trash$ = useMemo(() => record?.trash$ ?? new LiveData(false), [record]);
  const trashed = useLiveData(trash$);
  const loadedStore = useRef<
    | {
        pageId: string;
        selector: string;
        store: Store;
      }
    | undefined
  >(undefined);
  const [resolved, setResolved] = useState<{
    pageId: string;
    selector: string;
    state: ReferenceState;
  }>();

  useEffect(() => {
    if (readable !== true || !record || trashed || !precise) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30_000),
    ]);
    let reference: ReturnType<DocsService["open"]>;
    let unsubscribe: (() => void) | undefined;
    const publish = (state: ReferenceState) => {
      // The deadline bounds loading only. Live deletion/undo must still update
      // this link after that deadline; only unmount invalidates publication.
      if (!controller.signal.aborted) setResolved({ pageId, selector, state });
    };
    publish("checking");
    const load = async () => {
      if (
        !Array.isArray(blockIds) ||
        !blockIds.length ||
        blockIds.some((id) => typeof id !== "string" || !id)
      ) {
        publish("unavailable");
        return;
      }
      if (!(await guard.can("Doc_Read", pageId))) {
        publish("unavailable");
        return;
      }
      signal.throwIfAborted();
      reference = docs.open(pageId);
      if (!reference) throw new Error("Reference document missing");
      reference.doc.virgultumDoc.load();
      await reference.doc.waitForSyncReady(signal);
      signal.throwIfAborted();
      if (!(await guard.can("Doc_Read", pageId))) {
        publish("unavailable");
        return;
      }
      signal.throwIfAborted();
      const store = reference.doc.virgultumDoc;
      loadedStore.current = { pageId, selector, store };
      const update = () =>
        publish(
          blockIds.every((id) => reachableTarget(store, id))
            ? "ready"
            : "unavailable",
        );
      const subscription = store.slots.blockUpdated.subscribe(update);
      unsubscribe = () => subscription.unsubscribe();
      update();
    };
    void load()
      .catch(() => publish("unavailable"))
      .finally(() => {
        if (!unsubscribe) {
          reference?.release();
          reference = null;
        }
      });
    return () => {
      controller.abort();
      loadedStore.current = undefined;
      unsubscribe?.();
      reference?.release();
      reference = null;
    };
  }, [
    blockIds,
    docs,
    guard,
    pageId,
    precise,
    readable,
    record,
    selector,
    trashed,
  ]);

  const state: ReferenceState =
    readable !== true
      ? readable === false
        ? "unavailable"
        : "checking"
      : !record && !listReady
        ? "checking"
        : !record || trashed
          ? "unavailable"
          : !precise
            ? "ready"
            : resolved?.pageId === pageId && resolved.selector === selector
              ? resolved.state
              : "checking";
  const canNavigate = useCallback(() => {
    if (permission$.value !== true || !record$.value || trash$.value)
      return false;
    if (!precise) return true;
    const loaded = loadedStore.current;
    return (
      loaded?.pageId === pageId &&
      loaded.selector === selector &&
      Array.isArray(blockIds) &&
      !!blockIds.length &&
      blockIds.every(
        (id) => typeof id === "string" && reachableTarget(loaded.store, id),
      )
    );
  }, [blockIds, pageId, permission$, precise, record$, selector, trash$]);
  return { state, canNavigate };
}

function keepReferenceEnterNative(event: KeyboardEvent<HTMLAnchorElement>) {
  // The editor dispatches document-level hotkeys from its retained selection.
  // Do not let Enter on this focused anchor split that unrelated paragraph.
  // Keep the browser's default click, modifiers and existing Peek owner intact.
  if (event.key === "Enter") event.stopPropagation();
}

function MyoxusPageReferenceInner({
  pageId,
  params,
  title,
  Icon: UserIcon,
  state,
}: MyoxusPageReferenceProps & { state: ReferenceState }) {
  const t = useI18n();
  const docDisplayMetaService = useService(DocDisplayMetaService);

  let referenceWithMode: DocMode | null = null;
  let referenceToNode = false;
  if (params) {
    const m = params.get("mode");
    if (m && (m === "page" || m === "edgeless")) {
      referenceWithMode = m as DocMode;
    }
    referenceToNode = params.has("blockIds") || params.has("elementIds");
  }

  const Icon = useLiveData(
    LiveData.computed((get) => {
      if (state !== "ready") return () => null;
      if (UserIcon) {
        return UserIcon;
      }
      return get(
        docDisplayMetaService.icon$(pageId, {
          mode: referenceWithMode ?? undefined,
          reference: true,
          referenceToNode,
          title,
        }),
      );
    }),
  );

  const resolvedTitle = useLiveData(
    useMemo(
      () =>
        state === "ready"
          ? docDisplayMetaService.title$(pageId, { title, reference: true })
          : new LiveData(undefined),
      [docDisplayMetaService, pageId, state, title],
    ),
  );
  const visibleTitle =
    state === "ready"
      ? resolvedTitle
      : (title ??
        (state === "checking"
          ? t.Loading()
          : t["com.myoxus.reference.target-unavailable"]()));

  return (
    <InlineDocumentReferenceContent deleted={state === "unavailable"}>
      <InlineDocumentReferenceIcon>
        <Icon />
      </InlineDocumentReferenceIcon>
      <InlineDocumentReferenceTitle>
        {visibleTitle}
      </InlineDocumentReferenceTitle>
    </InlineDocumentReferenceContent>
  );
}

function LocalPageReference({
  pageId,
  params,
  title,
  Icon,
  onClick: userOnClick,
  resolutionState,
}: MyoxusPageReferenceProps) {
  const { state: guardedState, canNavigate } = useReferenceState(
    pageId,
    params,
  );
  const state = resolutionState ?? guardedState;
  const t = useI18n();
  const journalService = useService(JournalService);
  const isJournal = !!useLiveData(
    useMemo(
      () =>
        state === "ready"
          ? journalService.journalDate$(pageId)
          : new LiveData(undefined),
      [journalService, pageId, state],
    ),
  );

  const ref = useRef<HTMLElement>(null);

  const [refreshKey, setRefreshKey] = useState<string>(() => nanoid());

  const peekView = useService(PeekViewService).peekView;
  const isInPeekView = useInsidePeekView();

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (state !== "ready" || !canNavigate()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      userOnClick?.(e);

      if (e.defaultPrevented) {
        return;
      }

      if (isJournal) {
        track.doc.editor.pageRef.navigate({
          to: "journal",
        });
      }

      if (e.shiftKey && ref.current) {
        e.preventDefault();
        e.stopPropagation();
        peekView
          .open({
            element: ref.current,
          })
          .catch(console.error);
      }

      if (isInPeekView) {
        peekView.close();
      }

      // update refresh key
      setRefreshKey(nanoid());

      return;
    },
    [canNavigate, isInPeekView, isJournal, peekView, state, userOnClick],
  );

  const query = useMemo(() => {
    // A block/element reference link
    let str = params?.toString() ?? "";
    if (str.length) str += "&";
    str += `refreshKey=${refreshKey}`;
    return "?" + str;
  }, [params, refreshKey]);

  return (
    <InlineDocumentReferenceLink
      ref={ref}
      component={WorkbenchLink}
      to={`/${pageId}${query}`}
      onClick={onClick}
      onKeyDown={keepReferenceEnterNative}
      deleted={state === "unavailable"}
      aria-disabled={state !== "ready"}
      data-reference-state={state}
      title={
        state === "unavailable"
          ? t["com.myoxus.reference.target-unavailable"]()
          : undefined
      }
    >
      <MyoxusPageReferenceInner
        pageId={pageId}
        params={params}
        title={title}
        Icon={Icon}
        state={state}
      />
    </InlineDocumentReferenceLink>
  );
}

function LocalSharedPageReference({
  pageId,
  docCollection,
  nativeNavigation,
  params,
  title,
  Icon,
  onClick: userOnClick,
  resolutionState,
}: MyoxusPageReferenceProps & {
  docCollection: Workspace;
  nativeNavigation?: boolean;
}) {
  const { state: guardedState, canNavigate } = useReferenceState(
    pageId,
    params,
  );
  const state = resolutionState ?? guardedState;
  const t = useI18n();
  const journalService = useService(JournalService);
  const isJournal = !!useLiveData(
    useMemo(
      () =>
        state === "ready"
          ? journalService.journalDate$(pageId)
          : new LiveData(undefined),
      [journalService, pageId, state],
    ),
  );

  const ref = useRef<HTMLElement>(null);

  const [refreshKey, setRefreshKey] = useState<string>(() => nanoid());

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (state !== "ready" || !canNavigate()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      userOnClick?.(e);

      if (e.defaultPrevented) {
        return;
      }

      if (isJournal) {
        track.doc.editor.pageRef.navigate({
          to: "journal",
        });
      }

      // update refresh key
      setRefreshKey(nanoid());

      // Prevent virgultum link clicked behavior
      e.stopPropagation();

      return;
    },
    [canNavigate, isJournal, state, userOnClick],
  );

  const query = useMemo(() => {
    // A block/element reference link
    let str = params?.toString() ?? "";
    if (str.length) str += "&";
    str += `refreshKey=${refreshKey}`;
    return "?" + str;
  }, [params, refreshKey]);

  return (
    <InlineDocumentReferenceLink
      ref={ref}
      {...(nativeNavigation
        ? {
            component: "a",
            href: `/workspace/${docCollection.id}/${pageId}${query}`,
          }
        : {
            component: Link,
            to: `/workspace/${docCollection.id}/${pageId}${query}`,
          })}
      onClick={onClick}
      onKeyDown={keepReferenceEnterNative}
      deleted={state === "unavailable"}
      aria-disabled={state !== "ready"}
      data-reference-state={state}
      title={
        state === "unavailable"
          ? t["com.myoxus.reference.target-unavailable"]()
          : undefined
      }
    >
      <MyoxusPageReferenceInner
        pageId={pageId}
        params={params}
        title={title}
        Icon={Icon}
        state={state}
      />
    </InlineDocumentReferenceLink>
  );
}

/** Foreign references borrow the normal workspace pool and its guarded readers. */
function QualifiedPageReference({
  workspaceId,
  ...props
}: MyoxusPageReferenceProps & { workspaceId: string }) {
  const workspaces = useService(WorkspacesService);
  const [opened, setOpened] = useState<{
    id: string;
    workspace: CoreWorkspace;
  }>();
  const t = useI18n();
  useEffect(() => {
    const reference = workspaces.openByWorkspaceId(workspaceId);
    setOpened(
      reference
        ? { id: workspaceId, workspace: reference.workspace }
        : undefined,
    );
    return () => reference?.dispose();
  }, [workspaces, workspaceId]);
  // A scope from the previous render must never answer the new reference.
  if (opened?.id !== workspaceId) {
    return (
      <InlineDocumentReferenceContent
        data-reference-state="unavailable"
        aria-disabled="true"
      >
        <InlineDocumentReferenceTitle>
          {t["com.myoxus.reference.target-unavailable"]()}
        </InlineDocumentReferenceTitle>
      </InlineDocumentReferenceContent>
    );
  }
  return (
    <FrameworkScope scope={opened.workspace.scope}>
      <LocalSharedPageReference
        {...props}
        docCollection={opened.workspace.docCollection}
        nativeNavigation
      />
    </FrameworkScope>
  );
}

export function MyoxusPageReference(props: MyoxusPageReferenceProps) {
  const current = useService(WorkspaceService).workspace;
  return props.workspaceId !== undefined && props.workspaceId !== current.id ? (
    <QualifiedPageReference {...props} workspaceId={props.workspaceId} />
  ) : (
    <LocalPageReference {...props} />
  );
}

export function MyoxusSharedPageReference(
  props: MyoxusPageReferenceProps & { docCollection: Workspace },
) {
  return props.workspaceId !== undefined &&
    props.workspaceId !== props.docCollection.id ? (
    <QualifiedPageReference {...props} workspaceId={props.workspaceId} />
  ) : (
    <LocalSharedPageReference {...props} />
  );
}
