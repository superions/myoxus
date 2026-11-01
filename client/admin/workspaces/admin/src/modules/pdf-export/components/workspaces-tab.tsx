/**
 * @file PDF export module — Workspaces tab.
 *
 * Manages the workspace ↔ template assignment matrix. Lets the operator
 * pick a workspace and toggle each PDF template's "enabled" state, plus
 * mark exactly one assignment as the workspace default for the export
 * picker.
 *
 * Server contract:
 *  - GraphQL query: `pdfWorkspaceAssignments(workspaceId)`
 *  - Mutations: `assignPdfTemplateToWorkspace`,
 *    `unassignPdfTemplateFromWorkspace`,
 *    `setWorkspaceDefaultPdfTemplate`
 *  - Resolver: `crates/api/src/graphql/pdf_workspace.rs`
 *
 * UX contract:
 *  - "Default" is enforced server-side as exactly-one — flipping the
 *    radio away from one assignment automatically clears it on the
 *    previous default (P-PDF-TPL-V2-A-05).
 *  - The list of available workspaces uses the existing
 *    `adminWorkspacesQuery` so this module does not duplicate the
 *    workspaces module's filter/pagination logic.
 */
import { adminWorkspacesQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Checkbox,
  Input,
  MonoText,
  MyoxusText,
  notify,
  Radio,
  FormSelect,
  SettingsEmptyState,
  SettingsCollectionToolbar,
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  SettingsStatusText,
  Skeleton,
  Stack,
  Switch,
} from "@myoxus/ui-facade";
import { Suspense, useCallback, useMemo, useState } from "react";

import { AdminConfirmModal } from "../../../components/shared/admin-confirm-modal";
import { useQuery } from "../../../use-query";
import {
  useAssignPdfTemplateToWorkspaceMutation,
  usePdfTemplatesQuery,
  usePdfWorkspaceAssignmentsQuery,
  useSetWorkspaceDefaultPdfTemplateMutation,
  useUnassignPdfTemplateFromWorkspaceMutation,
} from "../api";
import {
  adaptPdfTemplate,
  type PdfTemplateRaw,
  type PdfTemplateViewModel,
} from "../format-adapters";
import { logPdfExportUiEvent } from "../logging";

import {
  pdfTemplateDisplayName,
  pdfTemplateSearchText,
} from "../template-localization";

// ---------------------------------------------------------------------------
// Workspace picker
// ---------------------------------------------------------------------------

interface WorkspaceOption {
  id: string;
  name: string;
}

function useWorkspaceOptions(): WorkspaceOption[] {
  const { data } = useQuery({
    query: adminWorkspacesQuery,
    variables: {
      filter: {
        first: 100,
        skip: 0,
      },
    },
  });
  const list =
    (data?.admin?.adminWorkspaces as
      Array<{ id: string; name: string }> | undefined) ?? [];
  return list.map((w) => ({ id: w.id, name: w.name ?? w.id }));
}

// ---------------------------------------------------------------------------
// Assignment matrix
// ---------------------------------------------------------------------------

function AssignmentMatrix({ workspaceId }: { workspaceId: string }) {
  const i18n = useI18n();
  const [search, setSearch] = useState("");
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [optimisticAssignments, setOptimisticAssignments] = useState<Map<
    string,
    { isDefault: boolean }
  > | null>(null);
  const [pendingDefault, setPendingDefault] =
    useState<PdfTemplateViewModel | null>(null);
  const tplQuery = usePdfTemplatesQuery(false);
  const asgQuery = usePdfWorkspaceAssignmentsQuery(workspaceId);
  const assign = useAssignPdfTemplateToWorkspaceMutation();
  const unassign = useUnassignPdfTemplateFromWorkspaceMutation();
  const setDefault = useSetWorkspaceDefaultPdfTemplateMutation();

  const templates = useMemo(
    () => (tplQuery.templates as PdfTemplateRaw[]).map(adaptPdfTemplate),
    [tplQuery.templates],
  );
  const assignments = useMemo(
    () =>
      (asgQuery.assignments ?? []) as Array<{
        workspaceId: string;
        templateId: string;
        isDefault: boolean;
      }>,
    [asgQuery.assignments],
  );
  const assignmentMap = useMemo(() => {
    const map = new Map<string, { isDefault: boolean }>();
    for (const a of assignments) {
      map.set(a.templateId, { isDefault: a.isDefault });
    }
    return map;
  }, [assignments]);
  const effectiveAssignmentMap = optimisticAssignments ?? assignmentMap;
  const filteredTemplates = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    if (normalized === "") return templates;
    return templates.filter((tpl) =>
      pdfTemplateSearchText(tpl, i18n.t).includes(normalized),
    );
  }, [i18n.t, search, templates]);

  const defaultId =
    Array.from(effectiveAssignmentMap.entries()).find(
      ([, a]) => a.isDefault,
    )?.[0] ?? "";
  const currentDefault = templates.find((tpl) => tpl.id === defaultId) ?? null;

  const refresh = useCallback(() => {
    void asgQuery.mutate();
  }, [asgQuery]);

  const handleToggle = useCallback(
    async (templateId: string, enabled: boolean) => {
      const next = new Map(effectiveAssignmentMap);
      if (enabled) {
        next.set(templateId, {
          isDefault: next.get(templateId)?.isDefault ?? false,
        });
      } else {
        next.delete(templateId);
      }
      setOptimisticAssignments(next);
      try {
        if (enabled) {
          await assign.trigger({ workspaceId, templateId });
        } else {
          await unassign.trigger({ workspaceId, templateId });
        }
        logPdfExportUiEvent("workspace.assignment.toggled", {
          workspaceId,
          templateId,
          enabled,
        });
        notify.success({
          title: i18n.t(
            enabled
              ? "admin.pdf-export.assignment.enabled"
              : "admin.pdf-export.assignment.disabled",
          ),
        });
        refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setOptimisticAssignments(null);
        logPdfExportUiEvent(
          "workspace.assignment.failed",
          { workspaceId, templateId, enabled, error: msg },
          "error",
        );
        notify.error({
          title: i18n.t("admin.pdf-export.assignment.failed"),
          message: msg,
        });
      } finally {
        setOptimisticAssignments(null);
      }
    },
    [assign, effectiveAssignmentMap, i18n, refresh, unassign, workspaceId],
  );

  const handleSetDefault = useCallback(
    async (templateId: string) => {
      const next = new Map(effectiveAssignmentMap);
      for (const [id, value] of next) {
        next.set(id, { ...value, isDefault: id === templateId });
      }
      setOptimisticAssignments(next);
      try {
        await setDefault.trigger({ workspaceId, templateId });
        logPdfExportUiEvent("workspace.default-template.changed", {
          workspaceId,
          templateId,
          previousTemplateId: defaultId || null,
        });
        notify.success({
          title: i18n.t("admin.pdf-export.assignment.default-set"),
        });
        refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setOptimisticAssignments(null);
        logPdfExportUiEvent(
          "workspace.default-template.failed",
          { workspaceId, templateId, error: msg },
          "error",
        );
        notify.error({
          title: i18n.t("admin.pdf-export.assignment.default-failed"),
          message: msg,
        });
      } finally {
        setOptimisticAssignments(null);
      }
    },
    [defaultId, effectiveAssignmentMap, i18n, refresh, setDefault, workspaceId],
  );

  const handleBulkAssign = useCallback(async () => {
    const ids = Array.from(selectedTemplateIds);
    if (ids.length === 0) return;
    const next = new Map(effectiveAssignmentMap);
    for (const id of ids) {
      next.set(id, { isDefault: next.get(id)?.isDefault ?? false });
    }
    setOptimisticAssignments(next);
    try {
      await Promise.all(
        ids.map((templateId) => assign.trigger({ workspaceId, templateId })),
      );
      logPdfExportUiEvent("workspace.assignment.bulk-assigned", {
        workspaceId,
        count: ids.length,
      });
      notify.success({
        title: i18n
          .t("admin.pdf-export.assignment.bulk-assigned")
          .replace("{{count}}", String(ids.length)),
      });
      setSelectedTemplateIds(new Set());
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOptimisticAssignments(null);
      logPdfExportUiEvent(
        "workspace.assignment.bulk-failed",
        { workspaceId, count: ids.length, error: msg },
        "error",
      );
      notify.error({
        title: i18n.t("admin.pdf-export.assignment.failed"),
        message: msg,
      });
    } finally {
      setOptimisticAssignments(null);
    }
  }, [
    assign,
    effectiveAssignmentMap,
    i18n,
    refresh,
    selectedTemplateIds,
    workspaceId,
  ]);

  const toggleSelected = useCallback((templateId: string, checked: boolean) => {
    setSelectedTemplateIds((current) => {
      const next = new Set(current);
      if (checked) next.add(templateId);
      else next.delete(templateId);
      return next;
    });
  }, []);

  if (templates.length === 0) {
    return (
      <SettingsEmptyState
        title={i18n.t("admin.pdf-export.assignment.no-templates")}
      />
    );
  }

  return (
    <>
      <SettingsCollectionToolbar
        search={
          <Input
            value={search}
            onChange={setSearch}
            placeholder={i18n.t("admin.pdf-export.assignment.search")}
            aria-label={i18n.t("admin.pdf-export.assignment.search")}
          />
        }
        actions={
          <>
            <SettingsStatusText>
              {i18n
                .t("admin.pdf-export.assignment.selected-count")
                .replace("{{count}}", String(selectedTemplateIds.size))}
            </SettingsStatusText>
            <Button
              type="button"
              variant="ghost"
              disabled={selectedTemplateIds.size === 0}
              onClick={handleBulkAssign}
            >
              {i18n.t("admin.pdf-export.assignment.bulk-assign")}
            </Button>
          </>
        }
      />

      <Table aria-label={i18n.t("admin.pdf-export.assignment.matrix-aria")}>
        <TableHeader>
          <TableRow>
            <TableHead>
              {i18n.t("admin.pdf-export.assignment.column.select")}
            </TableHead>
            <TableHead>{i18n.t("admin.pdf-export.column.name")}</TableHead>
            <TableHead>
              {i18n.t("admin.pdf-export.assignment.column.enabled")}
            </TableHead>
            <TableHead>
              {i18n.t("admin.pdf-export.assignment.column.default")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredTemplates.map((tpl) => {
            const assigned = effectiveAssignmentMap.has(tpl.id);
            const isDefault =
              effectiveAssignmentMap.get(tpl.id)?.isDefault ?? false;
            return (
              <TableRow key={tpl.id}>
                <TableCell>
                  <Checkbox
                    checked={selectedTemplateIds.has(tpl.id)}
                    onChange={(_, checked) => toggleSelected(tpl.id, checked)}
                    aria-label={i18n.t(
                      "admin.pdf-export.assignment.select-aria",
                    )}
                  />
                </TableCell>
                <TableCell>
                  <MyoxusText>{pdfTemplateDisplayName(tpl, i18n.t)}</MyoxusText>
                  <MonoText>{tpl.slug}</MonoText>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={assigned}
                    onCheckedChange={(checked) => handleToggle(tpl.id, checked)}
                    aria-label={i18n.t(
                      "admin.pdf-export.assignment.toggle-aria",
                    )}
                    disabled={isDefault && assigned}
                  />
                </TableCell>
                <TableCell>
                  <Radio
                    name={`pdf-default-${workspaceId}`}
                    checked={defaultId === tpl.id}
                    disabled={!assigned}
                    aria-label={i18n.t(
                      "admin.pdf-export.assignment.default-aria",
                    )}
                    onChange={(_, checked) => {
                      if (checked) {
                        const template = templates.find(
                          (candidate) => candidate.id === tpl.id,
                        );
                        if (template) setPendingDefault(template);
                      }
                    }}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {pendingDefault ? (
        <AdminConfirmModal
          open
          onOpenChange={(open) => {
            if (!open) setPendingDefault(null);
          }}
          title={i18n.t("admin.pdf-export.assignment.default-confirm-title")}
          description={
            <Stack>
              <MyoxusText>
                {i18n
                  .t("admin.pdf-export.assignment.default-confirm-description")
                  .replace(
                    "{{old}}",
                    currentDefault
                      ? pdfTemplateDisplayName(currentDefault, i18n.t)
                      : "-",
                  )
                  .replace(
                    "{{new}}",
                    pdfTemplateDisplayName(pendingDefault, i18n.t),
                  )}
              </MyoxusText>
              <MyoxusText>
                {i18n.t("admin.pdf-export.assignment.default-confirm")}
              </MyoxusText>
            </Stack>
          }
          cancelText={i18n.t("admin.common.cancel")}
          confirmText={i18n.t("admin.common.confirm")}
          onConfirm={() => {
            void handleSetDefault(pendingDefault.id);
            setPendingDefault(null);
          }}
          onCancel={() => setPendingDefault(null)}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Inner content
// ---------------------------------------------------------------------------

function WorkspacesTabContent() {
  const i18n = useI18n();
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const workspaces = useWorkspaceOptions();

  return (
    <Stack>
      <Stack>
        <FormSelect
          id="ws-picker"
          label={i18n.t("admin.pdf-export.workspaces.pick-workspace")}
          searchable
          value={workspaceId}
          onChange={setWorkspaceId}
          placeholder={i18n.t("admin.pdf-export.workspaces.placeholder")}
          data={workspaces.map((w) => ({ value: w.id, label: w.name }))}
        />

        {workspaceId ? (
          <Suspense fallback={<Skeleton h={128} />}>
            <AssignmentMatrix key={workspaceId} workspaceId={workspaceId} />
          </Suspense>
        ) : (
          <SettingsStatusText>
            {i18n.t("admin.pdf-export.workspaces.select-prompt")}
          </SettingsStatusText>
        )}
      </Stack>
    </Stack>
  );
}

export function WorkspacesTab() {
  return (
    <Suspense fallback={<Skeleton h={256} />}>
      <WorkspacesTabContent />
    </Suspense>
  );
}
