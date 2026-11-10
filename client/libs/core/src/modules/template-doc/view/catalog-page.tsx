// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useTaskIdentity } from "@myoxus/core/modules/database/tasks/use-workspace-tasks";
import { useGuard } from "@myoxus/core/components/guard/use-guard";
import { useUserPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { ServerPagePreview } from "@myoxus/core/components/page-list/server-page-preview";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import {
  WorkbenchLink,
  WorkbenchService,
  ViewService,
} from "@myoxus/core/modules/workbench";
import { useIsActiveView } from "@myoxus/core/modules/workbench/view/use-is-active-view";
import { inferOpenMode } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  GridIcon,
  BulletedListIcon,
  EditIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TemplateIcon,
} from "@myoxus/icons/react";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import {
  TemplateLibraryKind,
  TemplateLibraryOrigin,
  TemplateLibrarySort,
} from "@myoxus/graphql";
import {
  Alert,
  Card,
  CardTitle,
  CardDescription,
  SimpleGrid,
  ViewSwitcher,
  Button,
  Box,
  EmptyState,
  EmptyStateTitle,
  Select,
  Group,
  Flex,
  IconButton,
  Loading,
  Modal,
  MultiSelect,
  NavLink,
  Menu,
  MenuItem,
  MyoxusText,
  MyoxusTextInput,
  notify,
  PageContentRail,
  Scrollable,
  Stack,
  SurfaceListItemFrame,
  SurfaceListItemIcon,
  SurfaceListText,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
  Text,
  Title,
  useConfirmModal,
  WorkbenchHeaderFrame,
  WorkbenchHeaderTitle,
} from "@myoxus/ui-facade";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDocumentOperations } from "../../../components/hooks/myoxus/use-document-operations";
import { DocsService } from "../../doc";
import { GuardService } from "../../permissions";
import type { TemplateSourceOrigin } from "../services/template-doc";
import {
  type LoadTemplateSuggestionsOptions,
  TemplateDocService,
  mapTemplateSuggestionItem,
  TemplateSuggestionSurface,
} from "../services/template-doc";
import { BuiltinTemplateReconcilerService } from "../services/builtin-reconciler";
import {
  mergeTemplateCatalogRows,
  mapTemplateCatalogRow,
  type TemplateCatalogNativeSource,
  parseAssistantLibraryRoute,
  type AssistantLibraryAssociation,
  parseTemplateCatalogRouteState,
  selectTemplateCatalogRows,
  templateCatalogRouteSearch,
  type TemplateCatalogOrigin,
  type TemplateCatalogReadiness,
  type TemplateCatalogRouteState,
  type TemplateCatalogRow,
  type TemplateCatalogSort,
  type TemplateCatalogType,
} from "./catalog-model";
import { revalidateCatalogTemplateSource } from "./catalog-application";
import { TemplateCheckDialog } from "./template-check-dialog";
import { useTemplateApplicationAction } from "./use-template-application";
import { BuildingBlockPreview } from "./building-block-preview";
import { templateFailureMessages } from "../services/template-application";
import { TemplateInstantiationError } from "../services/template-instantiation-error";

/** Shared catalog reads never reconcile or create workspace sources. */
export function useTemplateCatalogInventory(state: TemplateCatalogRouteState) {
  const templateDocService = useService(TemplateDocService);
  const workspace = useService(WorkspaceService).workspace;
  const reconciler = useService(BuiltinTemplateReconcilerService);
  const t = useI18n();
  const nativeSources$ = useMemo(() => {
    if (workspace.flavour !== "local")
      return new LiveData<TemplateCatalogNativeSource[]>([]);
    const docs$ = templateDocService.templateDocs$({ exclude: ["onboarding"] });
    const metadata$ = templateDocService.templateSourceMetadata$();
    return LiveData.computed((get) =>
      get(docs$).map((doc) => {
        const attribution = get(doc.templateAttribution$);
        const metadata = get(metadata$)[doc.id];
        return {
          docId: doc.id,
          title: get(doc.title$),
          updatedAt: get(doc.updatedAt$) ?? null,
          templateId: attribution?.templateId,
          category: metadata?.category ?? null,
          tags: metadata?.tags ?? [],
          registryBacked:
            metadata?.source === "bundle" ||
            metadata?.source === "builtin" ||
            Boolean(attribution?.templateId),
          origin:
            attribution?.origin ??
            get(templateDocService.list.templateOrigins$).get(doc.id),
        };
      }),
    );
  }, [templateDocService, workspace.flavour]);
  const nativeSources = useLiveData(nativeSources$);
  const bindings = useLiveData(reconciler.bindings$);
  const observedBindings = useRef(bindings);
  const request = useMemo<LoadTemplateSuggestionsOptions>(
    () => ({
      surface:
        workspace.flavour !== "local"
          ? TemplateSuggestionSurface.Library
          : state.type === "building-blocks"
            ? TemplateSuggestionSurface.BuildingBlock
            : TemplateSuggestionSurface.AllPagesNewPage,
      categoryFilter: { exclude: ["onboarding"] },
      locale: t.language,
      ...(workspace.flavour !== "local"
        ? {
            first: 200,
            library: {
              kind:
                state.type === "building-blocks"
                  ? TemplateLibraryKind.BuildingBlock
                  : TemplateLibraryKind.Document,
              search: state.search,
              origin:
                state.origin === "all"
                  ? undefined
                  : {
                      builtin: TemplateLibraryOrigin.Builtin,
                      imported: TemplateLibraryOrigin.Imported,
                      custom: TemplateLibraryOrigin.Custom,
                      unknown: TemplateLibraryOrigin.Unknown,
                    }[state.origin],
              workAreaTag:
                state.type === "building-blocks" ? state.tag : undefined,
              sort: {
                "name-asc": TemplateLibrarySort.NameAsc,
                "name-desc": TemplateLibrarySort.NameDesc,
                "updated-asc": TemplateLibrarySort.UpdatedAsc,
                "updated-desc": TemplateLibrarySort.UpdatedDesc,
              }[state.sort],
            },
          }
        : {}),
    }),
    [
      t.language,
      state.type,
      state.search,
      state.origin,
      state.tag,
      state.sort,
      workspace.flavour,
    ],
  );

  const inventory$ = useMemo(
    () =>
      workspace.flavour === "local"
        ? templateDocService.templateSuggestions$
        : templateDocService.templateLibraryInventory$(request),
    [templateDocService, workspace.flavour, request],
  );
  const suggestions = useLiveData(inventory$);
  const location = useLiveData(useService(ViewService).view.location$);
  const active = useIsActiveView();

  const refresh = useCallback(async () => {
    await templateDocService.loadTemplateSuggestions(request, true);
  }, [request, templateDocService]);

  useEffect(() => {
    void templateDocService.loadTemplateSuggestions(request);
  }, [request, templateDocService]);

  useEffect(() => {
    if (!active || !location.pathname.endsWith("/templates")) return;
    // Returning from source editing must refresh the server inventory even
    // when this Library filter already has a cached result.
    void templateDocService.loadTemplateSuggestions(request, true);
  }, [request, templateDocService, active, location.key, location.pathname]);

  useEffect(() => {
    if (observedBindings.current === bindings) return;
    observedBindings.current = bindings;
    if (workspace.flavour !== "local") return;
    void templateDocService.loadTemplateSuggestions(request);
  }, [bindings, request, templateDocService, workspace.flavour]);

  const loadMore = useCallback(async () => {
    if (!suggestions.hasNextPage || !suggestions.endCursor) return;
    await templateDocService.loadTemplateSuggestions({
      ...request,
      after: suggestions.endCursor,
    });
  }, [
    request,
    suggestions.hasNextPage,
    suggestions.endCursor,
    templateDocService,
  ]);

  const rows = useMemo(
    () =>
      workspace.flavour !== "local" &&
      (suggestions.status === "error" || suggestions.status === "idle")
        ? []
        : workspace.flavour === "local"
          ? mergeTemplateCatalogRows(suggestions.items, nativeSources)
          : suggestions.items
              .filter((item) => item.category !== "onboarding")
              .map(mapTemplateCatalogRow),
    [nativeSources, suggestions.items, suggestions.status, workspace.flavour],
  );
  return { refresh, loadMore, rows, suggestions };
}

function useTemplateWorkAreaLabels() {
  const t = useI18n();
  const workAreaLabels: Record<string, string> = {
    communication: t["com.myoxus.templates.library.work-area.communication"](),
    meetings: t["com.myoxus.settings.meetings"](),
    decisions: t["com.myoxus.journal.template.section.decisions"](),
    projects: t["com.myoxus.templates.library.work-area.projects"](),
    quality: t["com.myoxus.templates.library.work-area.quality"](),
    incidents: t["com.myoxus.templates.library.work-area.incidents"](),
    knowledge: t["com.myoxus.templates.library.work-area.knowledge"](),
    "personal-work":
      t["com.myoxus.templates.library.work-area.personal-work"](),
    "technical-projects":
      t["com.myoxus.templates.library.work-area.technical-projects"](),
  };
  return workAreaLabels;
}

function TemplateCatalogHeader() {
  const t = useI18n();
  const canCreate = useGuard("Workspace_CreateDoc");
  const docsService = useService(DocsService);
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(useService(ViewService).view.location$);
  const state = parseTemplateCatalogRouteState(
    new URLSearchParams(location.search),
  );
  const createLabel =
    t[
      state.type === "building-blocks"
        ? "com.myoxus.templates.blocks.create"
        : "com.myoxus.template-list.create-new"
    ]();
  const [pending, setPending] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const createTemplate = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      const record = await docsService.createTemplateDoc(
        {
          classification: {
            category:
              state.type === "building-blocks" ? "building-blocks" : null,
            tags: state.tag ? [state.tag] : [],
          },
        },
        "custom",
      );
      workbench.openDoc(record.id, { at: "active" });
    } catch {
      notify.error({
        title: t["Template"](),
        message: t["com.myoxus.template-application.error.failed"](),
      });
      triggerRef.current?.focus();
    } finally {
      setPending(false);
    }
  }, [docsService, pending, state.type, state.tag, t, workbench]);

  return (
    <WorkbenchHeaderFrame
      data-myoxus-ui-role="template-catalog-header-frame"
      title={
        <WorkbenchHeaderTitle>
          {t["com.myoxus.templates.library.title"]()}
        </WorkbenchHeaderTitle>
      }
      right={
        canCreate ? (
          <IconButton
            ref={triggerRef}
            data-testid="template-catalog-create"
            icon={<PlusIcon />}
            aria-label={createLabel}
            aria-busy={pending}
            tooltip={createLabel}
            disabled={pending}
            onClick={() => void createTemplate()}
          />
        ) : null
      }
    />
  );
}

function useTemplateSourcePermissions(docId: string) {
  const guardService = useService(GuardService);
  const read$ = useMemo(
    () => guardService.can$("Workspace_Read"),
    [guardService],
  );
  const update$ = useMemo(
    () => guardService.can$("Doc_Update", docId),
    [docId, guardService],
  );
  const trash$ = useMemo(
    () => guardService.can$("Doc_Trash", docId),
    [docId, guardService],
  );
  const canRead = useLiveData(read$);
  const canEdit = useLiveData(update$);
  const canTrash = useLiveData(trash$);
  const loadWritePermissions = useCallback(() => {
    // Merely browsing the catalog never reads source grants. Request the
    // separate write projection only when its action menu is opened.
    guardService.revalidateCan("Doc_Update", docId);
  }, [docId, guardService]);
  return {
    canRead,
    canEdit: !!canEdit,
    canTrash: !!canTrash,
    loadWritePermissions,
  };
}

function TemplateClassificationDialog({
  row,
  onClosed,
  onSaved,
}: {
  row: TemplateCatalogRow & { docId: string };
  onClosed: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useI18n();
  const docs = useService(DocsService);
  const labels = useTemplateWorkAreaLabels();
  const [type, setType] = useState<TemplateCatalogType>(
    row.category === "building-blocks" ? "building-blocks" : "documents",
  );
  const [tags, setTags] = useState([...row.tags]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await docs.setTemplateClassification(
        row.docId,
        type === "building-blocks"
          ? "building-blocks"
          : row.category === "building-blocks"
            ? null
            : row.category,
        tags,
      );
      await onSaved();
      onClosed();
    } catch (cause) {
      setError(
        t[
          cause instanceof TemplateInstantiationError
            ? templateFailureMessages[cause.reason]
            : "com.myoxus.template-application.error.failed"
        ](),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      open
      title={t["com.myoxus.templates.classification.action"]()}
      persistent={pending}
      onOpenChange={(open) => {
        if (!open) onClosed();
      }}
    >
      <Stack
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Select
          label={t["com.myoxus.templates.library.type.label"]()}
          data={[
            {
              value: "documents",
              label: t["com.myoxus.templates.library.type.documents"](),
            },
            {
              value: "building-blocks",
              label: t["com.myoxus.templates.library.type.building-blocks"](),
            },
          ]}
          value={type}
          disabled={pending}
          onChange={(value) => value && setType(value as TemplateCatalogType)}
        />
        <MultiSelect
          label={t["com.myoxus.templates.library.work-area.label"]()}
          data={[...new Set([...Object.keys(labels), ...row.tags])].map(
            (value) => ({ value, label: labels[value] ?? value }),
          )}
          value={tags}
          onChange={setTags}
          disabled={pending}
        />
        {error ? <Alert role="alert" title={error} /> : null}
        <Group justify="flex-end">
          <Button variant="secondary" disabled={pending} onClick={onClosed}>
            {t.Cancel()}
          </Button>
          <Button type="submit" disabled={pending} loading={pending}>
            {t.Save()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function TemplateCatalogSourceActions({
  row,
  refresh,
}: {
  row: TemplateCatalogRow & { docId: string };
  refresh: () => Promise<void>;
}) {
  const t = useI18n();
  const canCreate = useGuard("Workspace_CreateDoc");
  const templateDocService = useService(TemplateDocService);
  const { canRead, canEdit, canTrash, loadWritePermissions } =
    useTemplateSourcePermissions(row.docId);
  const regionalPreferences = useRegionalPreferences();
  const docsService = useService(DocsService);
  const workbench = useService(WorkbenchService).workbench;
  const doc = useLiveData(docsService.list.doc$(row.docId));
  const { moveToTrash, restoreFromTrash } = useDocumentOperations();
  const { openConfirmModal } = useConfirmModal();
  const [usePending, setUsePending] = useState(false);
  const application = useTemplateApplicationAction(
    "library",
    undefined,
    row.docId,
    usePending,
  );
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false);
  const [classificationOpen, setClassificationOpen] = useState(false);
  const applying = useRef(false);
  const applyTemplate = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      // The source read and native copy share one flight; a later validation
      // response must not start another copy after the first one completes.
      if (applying.current) return;
      applying.current = true;
      setUsePending(true);
      try {
        let eligible = false;
        try {
          eligible = await revalidateCatalogTemplateSource(
            templateDocService,
            row,
            t.language,
          );
        } catch {
          // A failed canonical read cannot authorize a cached source.
          eligible = false;
        }
        if (!eligible) {
          // Assistant links refresh only their qualified source association;
          // ordinary Library failures must not restart shared inventory reads.
          if (row.assistantSource) await refresh();
          notify.error({
            title: t["Template"](),
            message: t["com.myoxus.template-application.error.unavailable"](),
          });
          return;
        }
        const result = await application.apply(row.docId, {
          creationContext: {},
          date: new Date(),
          regionalPreferences,
        });
        if (result.ok) {
          workbench.openDoc(result.docId, { at: inferOpenMode(event) });
        }
      } finally {
        applying.current = false;
        setUsePending(false);
      }
    },
    [
      application,
      refresh,
      regionalPreferences,
      row,
      t,
      templateDocService,
      workbench,
    ],
  );
  const openSource = useCallback(() => {
    workbench.openDoc(row.docId, { at: "active" });
  }, [row.docId, workbench]);
  const reportLifecycleFailure = useCallback(() => {
    notify.error({
      title: t["Template"](),
      message: t["com.myoxus.template-application.error.failed"](),
    });
    menuTriggerRef.current?.focus();
  }, [t]);
  const copySource = async () => {
    if (lifecyclePending) return;
    setLifecyclePending(true);
    try {
      const copy = await docsService.copyTemplateSource(row.docId);
      await refresh();
      workbench.openDoc(copy.id, { at: "active" });
    } catch {
      reportLifecycleFailure();
    } finally {
      setLifecyclePending(false);
    }
  };
  const setTemplateState = useCallback(
    async (isTemplate: boolean) => {
      if (!doc || lifecyclePending) return false;
      setLifecyclePending(true);
      try {
        await doc.setTemplateState(isTemplate);
        void refresh();
        return true;
      } catch {
        reportLifecycleFailure();
        return false;
      } finally {
        setLifecyclePending(false);
      }
    },
    [doc, lifecyclePending, refresh, reportLifecycleFailure],
  );
  const confirmUnmark = useCallback(() => {
    if (!doc || lifecyclePending) return;
    openConfirmModal({
      title: t["com.myoxus.templates.library.unmark.confirm-title"](),
      description:
        t["com.myoxus.templates.library.unmark.confirm-description"](),
      cancelText: t.Cancel(),
      confirmText: t["com.myoxus.templates.library.unmark"](),
      onConfirm: async () => {
        if (!(await setTemplateState(false))) return;
        notify.success({
          title: t["com.myoxus.templates.library.unmark.success"](),
          actions: [
            {
              key: `template-library-unmark-undo-${row.docId}`,
              label: t["Undo"](),
              onClick: async () => {
                await setTemplateState(true);
              },
            },
          ],
        });
      },
    });
  }, [doc, lifecyclePending, openConfirmModal, row.docId, setTemplateState, t]);
  const confirmTrash = useCallback(() => {
    if (!doc || lifecyclePending) return;
    openConfirmModal({
      title: t["com.myoxus.templates.library.trash.confirm-title"](),
      description:
        t["com.myoxus.templates.library.trash.confirm-description"](),
      cancelText: t.Cancel(),
      confirmText: t["com.myoxus.moveToTrash.title"](),
      confirmButtonOptions: { variant: "error" },
      onConfirm: async () => {
        setLifecyclePending(true);
        try {
          await moveToTrash(doc);
          void refresh();
          notify.success({
            title: t["com.myoxus.toastMessage.movedTrash"](),
            actions: [
              {
                key: `template-library-trash-undo-${row.docId}`,
                label: t["Undo"](),
                onClick: async () => {
                  try {
                    await restoreFromTrash(row.docId);
                    await refresh();
                  } catch {
                    reportLifecycleFailure();
                  }
                },
              },
            ],
          });
        } catch {
          reportLifecycleFailure();
        } finally {
          setLifecyclePending(false);
        }
      },
    });
  }, [
    doc,
    lifecyclePending,
    moveToTrash,
    openConfirmModal,
    refresh,
    reportLifecycleFailure,
    restoreFromTrash,
    row.docId,
    t,
  ]);

  return (
    <Group gap="xs" justify="flex-end" wrap="nowrap">
      <TemplateCheckDialog
        sourceDocId={row.docId}
        open={checkOpen}
        onOpenChange={setCheckOpen}
        returnFocusRef={menuTriggerRef}
      />
      {classificationOpen ? (
        <TemplateClassificationDialog
          row={row}
          onClosed={() => setClassificationOpen(false)}
          onSaved={refresh}
        />
      ) : null}
      {row.category === "building-blocks" ? (
        <Button
          variant="secondary"
          disabled={!canRead || !canCreate || lifecyclePending}
          loading={lifecyclePending}
          onClick={() => void copySource()}
        >
          {t["com.myoxus.templates.blocks.own-copy"]()}
        </Button>
      ) : null}
      {row.category !== "building-blocks" ? (
        <Button
          ref={(node) => {
            application.triggerRef.current = node;
          }}
          variant="secondary"
          loading={usePending || application.pending}
          disabled={usePending || !canCreate || !canRead || !row.available}
          onClick={(event) => void applyTemplate(event)}
        >
          {t["com.myoxus.templates.library.use"]()}
        </Button>
      ) : null}
      <Menu
        rootOptions={{
          onOpenChange: (opened) => {
            if (opened) loadWritePermissions();
          },
        }}
        items={
          <>
            <MenuItem disabled={!canRead} onClick={openSource}>
              {t["com.myoxus.workspace-pages.action.open"]()}
            </MenuItem>
            <MenuItem
              disabled={!canRead}
              onClick={() => setCheckOpen(true)}
              data-testid="template-check-action"
            >
              {t["com.myoxus.template-check.action"]()}
            </MenuItem>
            <MenuItem
              prefixIcon={<EditIcon />}
              disabled={!canRead || !canEdit}
              onClick={openSource}
            >
              {t["com.myoxus.templates.library.edit"]()}
            </MenuItem>
            <MenuItem
              disabled={
                row.registryBacked ||
                row.origin !== "custom" ||
                !canEdit ||
                lifecyclePending
              }
              title={
                row.registryBacked || row.origin !== "custom"
                  ? t["com.myoxus.templates.classification.managed-source"]()
                  : undefined
              }
              onClick={() => setClassificationOpen(true)}
            >
              {t["com.myoxus.templates.classification.action"]()}
            </MenuItem>
            <MenuItem
              prefixIcon={<TemplateIcon />}
              disabled={row.managed || !canEdit || !doc || lifecyclePending}
              title={
                row.managed
                  ? t["com.myoxus.templates.library.managed-protection"]()
                  : undefined
              }
              onClick={confirmUnmark}
            >
              {t["com.myoxus.templates.library.unmark"]()}
            </MenuItem>
            <MenuItem
              prefixIcon={<DeleteIcon />}
              disabled={row.managed || !canTrash || !doc || lifecyclePending}
              title={
                row.managed
                  ? t["com.myoxus.templates.library.managed-protection"]()
                  : undefined
              }
              onClick={confirmTrash}
            >
              {t["com.myoxus.moveToTrash.title"]()}
            </MenuItem>
          </>
        }
      >
        <IconButton
          ref={menuTriggerRef}
          aria-label={`${row.title}: ${t["com.myoxus.common.open-menu"]()}`}
          icon={<MoreHorizontalIcon />}
          size="small"
        />
      </Menu>
    </Group>
  );
}

function TemplateCatalogActions({
  row,
  refresh,
  recover,
}: {
  row: TemplateCatalogRow;
  refresh: () => Promise<void>;
  recover: () => Promise<void>;
}) {
  const t = useI18n();
  const [pending, setPending] = useState(false);
  if (row.docId) {
    return (
      <TemplateCatalogSourceActions
        row={{ ...row, docId: row.docId }}
        refresh={refresh}
      />
    );
  }
  const canRecover =
    row.readiness === "preparing" ||
    row.readiness === "source-missing" ||
    row.readiness === "retryable-failure";
  const retry = async () => {
    if (pending || !canRecover) return;
    setPending(true);
    try {
      await recover();
    } finally {
      setPending(false);
    }
  };
  return (
    <Group gap="xs" justify="flex-end" wrap="nowrap">
      <Button
        variant="secondary"
        disabled={!canRecover || pending}
        loading={pending}
        onClick={() => void retry()}
      >
        {canRecover || row.category === "building-blocks"
          ? t["Retry"]()
          : t["com.myoxus.templates.library.use"]()}
      </Button>
      <IconButton
        aria-label={`${row.title}: ${t["com.myoxus.common.open-menu"]()}`}
        icon={<MoreHorizontalIcon />}
        size="small"
        disabled
      />
    </Group>
  );
}

function TemplateCatalogReadinessText({
  readiness,
}: {
  readiness: TemplateCatalogReadiness;
}) {
  const t = useI18n();
  if (readiness === "ready") return null;
  const labels: Record<Exclude<TemplateCatalogReadiness, "ready">, string> = {
    preparing: t["com.myoxus.templates.library.readiness.preparing"](),
    "access-denied":
      t["com.myoxus.templates.library.readiness.access-denied"](),
    "source-missing":
      t["com.myoxus.templates.library.readiness.source-missing"](),
    "client-incompatible":
      t["com.myoxus.templates.library.readiness.client-incompatible"](),
    "retryable-failure":
      t["com.myoxus.templates.library.readiness.retryable-failure"](),
  };
  return (
    <SurfaceListText kind="description" truncate={false}>
      {labels[readiness]}
    </SurfaceListText>
  );
}

function TemplateCatalogSourceName({
  row,
}: {
  row: TemplateCatalogRow & { docId: string };
}) {
  const content = (
    <Group gap="sm">
      <SurfaceListItemIcon>
        <TemplateIcon />
      </SurfaceListItemIcon>
      <Stack gap={0}>
        <SurfaceListText kind="title" truncate={false}>
          {row.title}
        </SurfaceListText>
        {row.description ? (
          <SurfaceListText kind="description" truncate={false}>
            {row.description}
          </SurfaceListText>
        ) : null}
        <TemplateCatalogReadinessText readiness={row.readiness} />
      </Stack>
    </Group>
  );
  return (
    <SurfaceListItemFrame component={WorkbenchLink} to={`/${row.docId}`}>
      {content}
    </SurfaceListItemFrame>
  );
}

/** Presentation only: inventory, source permissions and commands keep their existing owners. */
function TemplateCatalogGallery({
  rows,
  refresh,
  recover,
}: {
  rows: readonly TemplateCatalogRow[];
  refresh: () => Promise<void>;
  recover: () => Promise<void>;
}) {
  const t = useI18n();
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(t.language, { dateStyle: "medium" }),
    [t.language],
  );
  const origins: Record<TemplateSourceOrigin, string> = {
    builtin: t["com.myoxus.templates.library.origin.builtin"](),
    imported: t["com.myoxus.templates.library.origin.imported"](),
    custom: t["com.myoxus.templates.library.origin.custom"](),
    unknown: t["com.myoxus.templates.library.origin.unknown"](),
  };
  return (
    <SimpleGrid
      cols={{ base: 1, sm: 2, lg: 3 }}
      data-testid="template-catalog-gallery"
    >
      {rows.map((row) => (
        <Card
          key={row.key}
          withBorder
          fullHeight
          padding="default"
          data-testid={`template-catalog-row-${row.key}`}
        >
          <Stack h="100%" justify="space-between">
            <Stack>
              {row.docId && row.available ? (
                <ServerPagePreview pageId={row.docId} />
              ) : null}
              <Stack gap="xs">
                {row.docId ? (
                  <WorkbenchLink to={`/${row.docId}`}>
                    <CardTitle>{row.title}</CardTitle>
                  </WorkbenchLink>
                ) : (
                  <CardTitle>{row.title}</CardTitle>
                )}
                {row.description ? (
                  <CardDescription>{row.description}</CardDescription>
                ) : null}
                <TemplateCatalogReadinessText readiness={row.readiness} />
                <Group justify="space-between">
                  <MyoxusText tone="secondary">
                    {origins[row.origin]}
                  </MyoxusText>
                  {row.updatedAt ? (
                    <MyoxusText tone="secondary">
                      {dateFormatter.format(row.updatedAt)}
                    </MyoxusText>
                  ) : null}
                </Group>
              </Stack>
            </Stack>
            <TemplateCatalogActions
              row={row}
              refresh={refresh}
              recover={recover}
            />
          </Stack>
        </Card>
      ))}
    </SimpleGrid>
  );
}

function TemplateCatalogTable({
  rows,
  refresh,
  recover,
}: {
  rows: readonly TemplateCatalogRow[];
  refresh: () => Promise<void>;
  recover: () => Promise<void>;
}) {
  const t = useI18n();
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(t.language, { dateStyle: "medium" }),
    [t.language],
  );
  const originLabels: Record<TemplateSourceOrigin, string> = {
    builtin: t["com.myoxus.templates.library.origin.builtin"](),
    imported: t["com.myoxus.templates.library.origin.imported"](),
    custom: t["com.myoxus.templates.library.origin.custom"](),
    unknown: t["com.myoxus.templates.library.origin.unknown"](),
  };

  return (
    <TableScrollContainer containInlineSize>
      <Table highlightOnHover>
        <TableHeader>
          <TableRow>
            <TableHead>
              {t["com.myoxus.templates.library.column.name"]()}
            </TableHead>
            <TableHead>
              {t["com.myoxus.templates.library.column.origin"]()}
            </TableHead>
            <TableHead>{t["Updated"]()}</TableHead>
            <TableHead
              aria-label={t["com.myoxus.templates.library.column.actions"]()}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.key}
              data-testid={`template-catalog-row-${row.key}`}
            >
              <TableCell>
                {row.docId ? (
                  <TemplateCatalogSourceName
                    row={{ ...row, docId: row.docId }}
                  />
                ) : (
                  <Group gap="sm">
                    <SurfaceListItemIcon>
                      <TemplateIcon />
                    </SurfaceListItemIcon>
                    <Stack gap={0}>
                      <SurfaceListText kind="title" truncate={false}>
                        {row.readiness === "access-denied"
                          ? t[
                              "com.myoxus.templates.library.source.restricted"
                            ]()
                          : row.title}
                      </SurfaceListText>
                      {row.description ? (
                        <SurfaceListText kind="description" truncate={false}>
                          {row.description}
                        </SurfaceListText>
                      ) : null}
                      <TemplateCatalogReadinessText readiness={row.readiness} />
                    </Stack>
                  </Group>
                )}
              </TableCell>
              <TableCell>{originLabels[row.origin]}</TableCell>
              <TableCell>
                {row.updatedAt
                  ? dateFormatter.format(new Date(row.updatedAt))
                  : null}
              </TableCell>
              <TableCell>
                <TemplateCatalogActions
                  row={row}
                  refresh={refresh}
                  recover={recover}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScrollContainer>
  );
}

export type BuildingBlockCatalogControl = {
  state: TemplateCatalogRouteState;
  source: string | null;
  onStateChange: (state: TemplateCatalogRouteState) => void;
  onSelect: (docId: string | null) => void;
  onSelected: (row: TemplateCatalogRow | undefined) => void;
  onConfirm: (row: TemplateCatalogRow) => void;
  onPreview: (docId: string, revision: Uint8Array | null) => void;
};

function BuildingBlockSelectedSource({
  row,
  picker,
  refresh,
  recover,
  onReady,
}: {
  row: TemplateCatalogRow & { docId: string };
  picker: boolean;
  refresh: () => Promise<void>;
  recover: () => Promise<void>;
  onReady?: (revision: Uint8Array | null) => void;
}) {
  const t = useI18n();
  const { canRead } = useTemplateSourcePermissions(row.docId);
  useEffect(() => {
    if (!canRead) onReady?.(null);
  }, [canRead, onReady]);
  if (canRead == null) return <Loading />;
  if (!canRead)
    return (
      <Alert
        title={t["com.myoxus.templates.library.readiness.access-denied"]()}
      />
    );
  return (
    <Stack>
      <Title order={2}>{row.title}</Title>
      {row.description ? <Text>{row.description}</Text> : null}
      <BuildingBlockPreview
        sourceDocId={row.docId}
        sourceRevisionId={row.sourceRevisionId}
        onReady={onReady}
      />
      {!picker ? (
        <TemplateCatalogActions row={row} refresh={refresh} recover={recover} />
      ) : null}
    </Stack>
  );
}

export function TemplateCatalogInventoryContent({
  picker,
}: {
  picker?: BuildingBlockCatalogControl;
}) {
  const t = useI18n();
  const canCreate = useGuard("Workspace_CreateDoc");
  const view = useService(ViewService).view;
  const location = useLiveData(view.location$);
  const routeState = useMemo(
    () => parseTemplateCatalogRouteState(new URLSearchParams(location.search)),
    [location.search],
  );
  const state = picker?.state ?? routeState;
  const workspace = useService(WorkspaceService).workspace;
  const { effectivePreferences, updatePreferences } = useUserPreferences();
  const catalogViews = effectivePreferences?.templateCatalogViews;
  const catalogView =
    catalogViews?.find((entry) => entry.workspaceId === workspace.id)?.view ===
    "gallery"
      ? "gallery"
      : "list";
  const changeCatalogView = async (next: "list" | "gallery") => {
    if (next === catalogView) return;
    try {
      await updatePreferences(
        {
          templateCatalogViews: [
            ...(catalogViews ?? []).filter(
              (entry) => entry.workspaceId !== workspace.id,
            ),
            { workspaceId: workspace.id, view: next },
          ],
        },
        { rollbackOnError: true },
      );
    } catch {
      notify.error({
        title: t["com.myoxus.templates.library.title"](),
        message: t["com.myoxus.database.view.update-failed"](),
      });
    }
  };

  const { refresh, loadMore, rows, suggestions } =
    useTemplateCatalogInventory(state);
  const templateDocService = useService(TemplateDocService);
  const reconciler = useService(BuiltinTemplateReconcilerService);
  // Only an explicit Library recovery action may provision a missing source.
  const recover = useCallback(async () => {
    templateDocService.invalidateTemplateSuggestions();
    try {
      await reconciler.reconcile(true);
      await refresh();
    } catch {
      notify.error({
        title: t["com.myoxus.templates.library.title"](),
        message:
          t["com.myoxus.templates.library.readiness.retryable-failure"](),
      });
    }
  }, [reconciler, refresh, templateDocService, t]);
  const selectedRows = useMemo(
    () =>
      workspace.flavour === "local"
        ? selectTemplateCatalogRows(rows, state)
        : rows,
    [rows, state, workspace.flavour],
  );
  const selectedSource = picker
    ? picker.source
    : new URLSearchParams(location.search).get("source");
  const sourceKey = JSON.stringify([workspace.id, selectedSource, t.language]);
  const [deepSource, setDeepSource] = useState<{
    key: string;
    row: TemplateCatalogRow | null;
  } | null>(null);
  // A selected later-page source is known even before its inventory page loads.
  // Filter changes must not discard that matching selection just because page 1
  // does not contain it.
  const selectionRows = useMemo(
    () =>
      deepSource?.key === sourceKey && deepSource.row
        ? [...rows, deepSource.row]
        : rows,
    [deepSource, rows, sourceKey],
  );
  const typeRows = rows.filter(
    (row) =>
      (row.category === "building-blocks") ===
      (state.type === "building-blocks"),
  );
  const workAreaLabels = useTemplateWorkAreaLabels();
  const workAreas = [
    ...new Set([
      ...(workspace.flavour !== "local" ? Object.keys(workAreaLabels) : []),
      ...typeRows
        .flatMap((row) => row.tags)
        .filter((tag) => Object.hasOwn(workAreaLabels, tag)),
      ...(state.tag ? [state.tag] : []),
    ]),
  ]
    .map((tag) => ({ value: tag, label: workAreaLabels[tag] ?? tag }))
    .sort((left, right) => left.label.localeCompare(right.label, t.language));
  const updateState = useCallback(
    (patch: Partial<TemplateCatalogRouteState>, push = true) => {
      const nextState = {
        ...state,
        ...patch,
      };
      if (picker) {
        picker.onStateChange(nextState);
        if (
          !selectTemplateCatalogRows(selectionRows, nextState).some(
            (row) => row.docId === picker.source,
          )
        )
          picker.onSelect(null);
        return;
      }
      const params = templateCatalogRouteSearch(
        nextState,
        new URLSearchParams(location.search),
      );
      const source = params.get("source");
      if (
        nextState.type !== "building-blocks" ||
        !selectTemplateCatalogRows(selectionRows, nextState).some(
          (row) => row.docId === source,
        )
      ) {
        params.delete("source");
      }
      const search = params.toString();
      const target = { ...location, search: search ? `?${search}` : "" };
      if (push) view.push(target);
      else view.replace(target);
    },
    [location, selectionRows, state, view, picker],
  );
  const clearFilters = useCallback(
    () =>
      updateState({ search: "", origin: "all", sort: "name-asc", tag: null }),
    [updateState],
  );
  const isLoading =
    selectedRows.length === 0 &&
    (suggestions.status === "idle" || suggestions.status === "loading");
  const isError = suggestions.status === "error";
  const noResults =
    selectedRows.length === 0 &&
    (typeRows.length > 0 ||
      Boolean(state.search || state.tag || state.origin !== "all"));
  const empty =
    !noResults && suggestions.status === "ready" && typeRows.length === 0;
  const sourceInInventory = selectedRows.some(
    (row) => row.docId === selectedSource,
  );
  useEffect(() => {
    if (
      workspace.flavour === "local" ||
      state.type !== "building-blocks" ||
      !selectedSource ||
      sourceInInventory ||
      suggestions.status !== "ready"
    )
      return;
    let active = true;
    setDeepSource(null);
    void templateDocService
      .lookupTemplateSource(selectedSource, t.language)
      .then((item) => {
        if (active)
          setDeepSource({
            key: sourceKey,
            row: item
              ? mapTemplateCatalogRow(mapTemplateSuggestionItem(item))
              : null,
          });
      })
      .catch(() => {
        if (active) setDeepSource({ key: sourceKey, row: null });
      });
    return () => {
      active = false;
    };
  }, [
    selectedSource,
    sourceInInventory,
    sourceKey,
    state.type,
    suggestions.status,
    t.language,
    templateDocService,
    workspace.flavour,
  ]);
  const deepRow =
    deepSource?.key === sourceKey &&
    deepSource.row &&
    selectTemplateCatalogRows([deepSource.row], state).length
      ? deepSource.row
      : null;
  // An explicit deep link may address a later page without loading intervening
  // pages. Its isolated row disappears naturally when continuation reaches it.
  const blockRows =
    !sourceInInventory && deepRow ? [...selectedRows, deepRow] : selectedRows;
  const block = selectedSource
    ? (selectedRows.find((row) => row.docId === selectedSource) ??
      deepRow ??
      undefined)
    : blockRows[0];
  const deepSourcePending =
    workspace.flavour !== "local" &&
    selectedSource &&
    !sourceInInventory &&
    deepSource?.key !== sourceKey;
  const selectBlock = (docId: string) => {
    if (picker) {
      picker.onSelect(docId);
      return;
    }
    const params = new URLSearchParams(location.search);
    params.set("source", docId);
    view.push({ ...location, search: `?${params}` });
  };
  const onSelected = picker?.onSelected;
  useEffect(() => {
    onSelected?.(block);
  }, [block, onSelected]);
  const onPreview = picker?.onPreview;
  const blockId = block?.docId;
  const previewReady = useCallback(
    (revision: Uint8Array | null) => {
      if (blockId) onPreview?.(blockId, revision);
    },
    [blockId, onPreview],
  );

  const contentRef = useRef<HTMLDivElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreMoreFocus = useRef(false);
  useEffect(() => {
    if (suggestions.status === "loading" || !restoreMoreFocus.current) return;
    restoreMoreFocus.current = false;
    const active = document.activeElement;
    if (
      active !== document.body &&
      active !== moreButtonRef.current &&
      active?.isConnected
    )
      return;
    // The last page removes its trigger. Keep keyboard focus in this catalog,
    // but never reclaim it after the user moves to another control mid-read.
    const target =
      moreButtonRef.current ??
      contentRef.current?.querySelector<HTMLElement>(
        '[role="option"][aria-selected="true"]',
      ) ??
      contentRef.current?.querySelector<HTMLElement>(
        "a[href],button:not([disabled])",
      );
    target?.focus();
  }, [suggestions.hasNextPage, suggestions.status]);
  const loadMoreControl = suggestions.hasNextPage ? (
    <Button
      ref={moreButtonRef}
      loading={suggestions.status === "loading"}
      onClick={() => {
        restoreMoreFocus.current =
          document.activeElement === moreButtonRef.current;
        void loadMore();
      }}
    >
      {t["com.myoxus.history.confirm-restore-modal.load-more"]()}
    </Button>
  ) : null;

  const content = (
    <Stack
      ref={contentRef}
      h={state.type === "building-blocks" ? "100%" : undefined}
      mih={0}
    >
      {!picker ? (
        <MyoxusText tone="secondary">
          {state.type === "building-blocks"
            ? t["com.myoxus.templates.library.blocks.purpose"]()
            : t["com.myoxus.templates.library.purpose"]()}
        </MyoxusText>
      ) : null}
      <Group>
        {!picker ? (
          <Select
            contentSized
            aria-label={t["com.myoxus.templates.library.type.label"]()}
            data={[
              {
                value: "documents",
                label: t["com.myoxus.templates.library.type.documents"](),
              },
              {
                value: "building-blocks",
                label: t["com.myoxus.templates.library.type.building-blocks"](),
              },
            ]}
            value={state.type}
            onChange={(value) =>
              updateState({ type: value as TemplateCatalogType, tag: null })
            }
          />
        ) : null}
        <MyoxusTextInput
          autoFocus
          data-autofocus={picker ? true : undefined}
          aria-label={
            state.type === "building-blocks"
              ? t["com.myoxus.templates.library.blocks.search"]()
              : t["com.myoxus.templates.library.search"]()
          }
          placeholder={
            state.type === "building-blocks"
              ? t["com.myoxus.templates.library.blocks.search"]()
              : t["com.myoxus.templates.library.search"]()
          }
          value={state.search}
          onChange={(value) => updateState({ search: value }, false)}
        />
        {state.type === "building-blocks" ? (
          <Select
            contentSized
            aria-label={t["com.myoxus.templates.library.work-area.label"]()}
            data={[
              {
                value: "",
                label: t["com.myoxus.templates.library.work-area.all"](),
              },
              ...workAreas,
            ]}
            value={state.tag ?? ""}
            onChange={(value) => updateState({ tag: value || null })}
          />
        ) : null}
        <Select
          contentSized
          aria-label={t["com.myoxus.templates.library.origin.filter"]()}
          data={[
            {
              value: "all",
              label: t["com.myoxus.templates.library.origin.all"](),
            },
            {
              value: "builtin",
              label: t["com.myoxus.templates.library.origin.builtin"](),
            },
            {
              value: "imported",
              label: t["com.myoxus.templates.library.origin.imported"](),
            },
            {
              value: "custom",
              label: t["com.myoxus.templates.library.origin.custom"](),
            },
            {
              value: "unknown",
              label: t["com.myoxus.templates.library.origin.unknown"](),
            },
          ]}
          value={state.origin}
          onChange={(value) =>
            value && updateState({ origin: value as TemplateCatalogOrigin })
          }
        />
        <Select
          contentSized
          aria-label={t["com.myoxus.templates.library.sort.label"]()}
          data={[
            {
              value: "name-asc",
              label: t["com.myoxus.templates.library.sort.name-asc"](),
            },
            {
              value: "name-desc",
              label: t["com.myoxus.templates.library.sort.name-desc"](),
            },
            {
              value: "updated-desc",
              label: t["com.myoxus.templates.library.sort.updated-desc"](),
            },
            {
              value: "updated-asc",
              label: t["com.myoxus.templates.library.sort.updated-asc"](),
            },
          ]}
          value={state.sort}
          onChange={(value) =>
            value && updateState({ sort: value as TemplateCatalogSort })
          }
        />
        {!picker && state.type === "documents" ? (
          <ViewSwitcher<"list" | "gallery">
            aria-label={t["com.myoxus.templates.library.title"]()}
            value={catalogView}
            onChange={(value) => void changeCatalogView(value)}
            items={[
              {
                value: "list",
                label: t["com.myoxus.all-docs.view.list"](),
                icon: <BulletedListIcon />,
              },
              {
                value: "gallery",
                label: t["com.myoxus.database.view.gallery"](),
                icon: <GridIcon />,
              },
            ]}
          />
        ) : null}
      </Group>
      {!canCreate ? (
        <Alert title={t["com.myoxus.templates.library.readonly"]()} />
      ) : null}
      {isError ? (
        <Alert
          title={t["com.myoxus.template-list.load-error"]()}
          data-testid="template-catalog-error"
        >
          <Button variant="secondary" onClick={() => void refresh()}>
            {t["Retry"]()}
          </Button>
        </Alert>
      ) : null}
      {suggestions.reconcileRequired && !picker ? (
        <Alert title={t["com.myoxus.template-list.reconcile-required"]()}>
          <Button variant="secondary" onClick={() => void recover()}>
            {t["Retry"]()}
          </Button>
        </Alert>
      ) : null}
      {suggestions.stale ? (
        <Alert title={t["com.myoxus.templates.library.stale"]()}>
          <Button variant="secondary" onClick={() => void refresh()}>
            {t["Retry"]()}
          </Button>
        </Alert>
      ) : null}
      {isLoading ? (
        <Loading data-testid="template-catalog-loading" />
      ) : noResults || empty ? (
        <EmptyState
          data-testid="template-catalog-empty"
          title={
            <EmptyStateTitle icon={<TemplateIcon />}>
              {noResults
                ? t["com.myoxus.templates.library.no-results"]()
                : state.type === "building-blocks"
                  ? t["com.myoxus.templates.library.blocks.empty"]()
                  : t["com.myoxus.templates.library.empty"]()}
            </EmptyStateTitle>
          }
          description={
            noResults
              ? t["com.myoxus.templates.library.no-results-description"]()
              : state.type === "building-blocks"
                ? t["com.myoxus.templates.library.blocks.empty-description"]()
                : t["com.myoxus.templates.library.empty-description"]()
          }
          cta={
            noResults ? (
              <Button variant="secondary" onClick={clearFilters}>
                {t["com.myoxus.templates.library.clear-filters"]()}
              </Button>
            ) : canCreate && state.type === "documents" ? (
              <MyoxusText tone="secondary">
                {t["com.myoxus.template-list.create-new"]()}
              </MyoxusText>
            ) : null
          }
        />
      ) : state.type === "building-blocks" ? (
        <Flex flex={1} mih={0} gap="md">
          <Box flex={1} miw={0}>
            <Scrollable.Viewport scrollbars="y">
              <Stack
                role="listbox"
                aria-label={t[
                  "com.myoxus.templates.library.type.building-blocks"
                ]()}
                gap={0}
              >
                {blockRows.map((row, index) => (
                  <NavLink
                    key={row.key}
                    component="button"
                    role="option"
                    aria-selected={block?.key === row.key}
                    active={block?.key === row.key}
                    tabIndex={block?.key === row.key ? 0 : -1}
                    label={row.title}
                    description={
                      <TemplateCatalogReadinessText readiness={row.readiness} />
                    }
                    onClick={() => row.docId && selectBlock(row.docId)}
                    onKeyDown={(event) => {
                      if (picker && event.key === "Enter") {
                        event.preventDefault();
                        picker.onConfirm(row);
                        return;
                      }
                      if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                        return;
                      event.preventDefault();
                      const next =
                        (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          blockRows.length) %
                        blockRows.length;
                      const target = blockRows[next];
                      if (target.docId) selectBlock(target.docId);
                      const options =
                        event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                          '[role="option"]',
                        );
                      options?.[next]?.focus();
                    }}
                  />
                ))}
              </Stack>
              {loadMoreControl}
            </Scrollable.Viewport>
          </Box>
          <Box flex={3} miw={0}>
            <Scrollable.Viewport>
              {block?.docId && block.available ? (
                <BuildingBlockSelectedSource
                  key={block.docId}
                  row={{ ...block, docId: block.docId }}
                  picker={Boolean(picker)}
                  refresh={refresh}
                  recover={recover}
                  onReady={picker ? previewReady : undefined}
                />
              ) : block ? (
                <TemplateCatalogReadinessText readiness={block.readiness} />
              ) : deepSourcePending ? (
                <Loading />
              ) : selectedSource ? (
                <Alert
                  title={t[
                    "com.myoxus.templates.library.readiness.source-missing"
                  ]()}
                />
              ) : null}
            </Scrollable.Viewport>
          </Box>
        </Flex>
      ) : catalogView === "gallery" ? (
        <TemplateCatalogGallery
          rows={selectedRows}
          refresh={refresh}
          recover={recover}
        />
      ) : (
        <TemplateCatalogTable
          rows={selectedRows}
          refresh={refresh}
          recover={recover}
        />
      )}
      {state.type !== "building-blocks" ? loadMoreControl : null}
    </Stack>
  );
  return picker ? (
    content
  ) : (
    <PageContentRail fill scroll spacious width="wide">
      {content}
    </PageContentRail>
  );
}

/** An explicit association resolves only its pinned existing source, never the
 * ordinary inventory/reconciler or a similarly named latest template. */
export function AssistantLibrarySource({
  input,
}: {
  input: AssistantLibraryAssociation | null;
}) {
  const t = useI18n();
  const service = useService(TemplateDocService);
  const owner = useTaskIdentity();
  const key = JSON.stringify([owner.identity, input, t.language]);
  const [result, setResult] = useState<{
    key: string;
    row: TemplateCatalogRow | null;
  } | null>(null);
  const [reload, setReload] = useState(0);
  const focusTarget = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let current = true;
    if (!input || !owner.identity || owner.workspace.flavour === "local") {
      setResult({ key, row: null });
      return;
    }
    void service.resolveAssistantDocumentSource(input, t.language).then(
      (source) => {
        if (!current) return;
        if (
          !source?.available ||
          !source.templateDocId ||
          !source.sourceRevisionId
        ) {
          setResult({ key, row: null });
          return;
        }
        const item = mapTemplateSuggestionItem(source);
        setResult({
          key,
          row: {
            key: `assistant:${source.templateId}`,
            templateId: item.templateId,
            docId: item.templateDocId,
            title: item.title,
            description: item.description,
            category: item.category,
            tags: item.tags,
            origin: item.origin,
            updatedAt: item.updatedAt,
            available: true,
            managed: item.protectedSource,
            registryBacked: true,
            readiness: "ready",
            readinessReasons: item.reasons,
            assistantSource: {
              input,
              sourceRevisionId: source.sourceRevisionId,
            },
          },
        });
      },
      () => {
        if (current) setResult({ key, row: null });
      },
    );
    return () => {
      current = false;
    };
  }, [
    input,
    key,
    owner.identity,
    owner.workspace.flavour,
    reload,
    service,
    t.language,
  ]);
  const refresh = useCallback(async () => {
    // The native rail survives both the transient Retry button and its result.
    focusTarget.current?.focus();
    setResult(null);
    setReload((value) => value + 1);
  }, []);
  return (
    <PageContentRail
      fill
      scroll
      spacious
      width="wide"
      role="region"
      tabIndex={-1}
      aria-label={t["com.myoxus.rootAppSidebar.library"]()}
      onFocusCapture={(event) => {
        focusTarget.current = event.currentTarget;
      }}
    >
      {!result || result.key !== key ? (
        <Loading data-testid="assistant-library-loading" />
      ) : result.row ? (
        <TemplateCatalogTable
          rows={[result.row]}
          refresh={refresh}
          recover={refresh}
        />
      ) : (
        <Alert
          title={t["com.myoxus.template-application.error.unavailable"]()}
          data-testid="assistant-library-unavailable"
        >
          <Button variant="secondary" onClick={() => void refresh()}>
            {t.Retry()}
          </Button>
        </Alert>
      )}
    </PageContentRail>
  );
}
function TemplateCatalogContent() {
  const location = useLiveData(useService(ViewService).view.location$);
  const route = useMemo(
    () => parseAssistantLibraryRoute(new URLSearchParams(location.search)),
    [location.search],
  );
  return route.kind === "none" ? (
    <TemplateCatalogInventoryContent />
  ) : (
    <AssistantLibrarySource
      input={route.kind === "source" ? route.input : null}
    />
  );
}

export function TemplateCatalogPage({
  children,
}: {
  children: (parts: {
    header: ReactNode;
    content: ReactNode;
    viewportBounded: boolean;
  }) => ReactNode;
}) {
  const location = useLiveData(useService(ViewService).view.location$);
  const params = new URLSearchParams(location.search);
  return children({
    header: <TemplateCatalogHeader />,
    content: <TemplateCatalogContent />,
    viewportBounded:
      parseTemplateCatalogRouteState(params).type === "building-blocks" &&
      parseAssistantLibraryRoute(params).kind === "none",
  });
}
