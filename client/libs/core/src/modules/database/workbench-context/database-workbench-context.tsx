// SPDX-License-Identifier: AGPL-3.0-or-later

import { databaseManagedCapabilities } from "../managed";

import { ViewContextSurface } from "@myoxus/core/modules/workbench/view/view-islands";
import { DatabaseViewKind } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  CopyIcon,
  MoreHorizontalIcon,
  SettingsIcon,
} from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Divider,
  Group,
  IconButton,
  InlineEdit,
  Menu,
  MenuItem,
  MyoxusText,
  NavigationLink,
  Scrollable,
  Stack,
  WorkbenchContextScrollRoot,
} from "@myoxus/ui-facade";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { databaseFieldTypeLabel } from "../field-settings";
import { sortByPosition } from "../model";
import { RowTemplateManagementPanel } from "../row-templates";
import type { DatabaseChangeHandler } from "../shared";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
  DatabaseRowTemplateBinding,
  DatabaseView,
} from "../types";
import {
  type DatabaseEffectiveViewState,
  type DatabaseViewControlSection,
  databaseViewControlTitle,
  type DatabaseViewEditScope,
  ViewSettingsSectionEditor,
} from "../view-controls";
import { DatabaseActivityPanel } from "./database-activity";
import { DatabaseAutomationsPanel } from "./database-automations";

export const DATABASE_WORKBENCH_CONTEXT_SURFACE_ID = "database-settings";
const DATABASE_VIEW_FAMILY = ["database"] as const;

export type DatabaseWorkbenchContextSection =
  | DatabaseViewControlSection
  | "database-fields"
  | "templates"
  | "automations"
  | "activity"
  | "assistance";

type PersonalActionStatus = "idle" | "saving" | "saved" | "failure";

const VIEW_SECTIONS: DatabaseViewControlSection[] = [
  "fields",
  "filter",
  "sort",
  "group",
  "display",
  "advanced",
];

function viewSupportsSection(
  view: DatabaseView,
  section: DatabaseViewControlSection,
) {
  if (section === "display" || section === "advanced") return true;
  if (section !== "group") return true;
  return [
    DatabaseViewKind.Calendar,
    DatabaseViewKind.Gallery,
    DatabaseViewKind.Gantt,
    DatabaseViewKind.Kanban,
    DatabaseViewKind.List,
    DatabaseViewKind.Progress,
    DatabaseViewKind.Table,
  ].includes(view.viewKind);
}

/**
 * The complete Database settings body for the existing Workbench Context Card.
 * It deliberately contributes no Card of its own: the Workbench owns the sole
 * surface, while native Facade accordions provide discoverable sections.
 */
export function DatabaseWorkbenchContext({
  activeView,
  assistance,
  taskAssistanceAvailable = false,
  databaseId,
  effectiveState,
  canManageContent = effectiveState.canEditShared,
  editScope,
  hasPersonalChanges,
  hasPersonalQueryChanges,
  onChanged,
  onConfigureField,
  onCopyViewLink,
  onEditScopeChange,
  onEffectiveStateChanged,
  onRenameView,
  onResetForMe,
  onSaveForView,
  record,
  requestedSection,
  resettingPersonalState,
  rowTemplates,
  rows,
  savingPersonalState,
  workspaceId,
}: {
  activeView: DatabaseView;
  assistance?: ReactNode;
  taskAssistanceAvailable?: boolean;
  databaseId: string;
  effectiveState: DatabaseEffectiveViewState;
  canManageContent?: boolean;
  editScope: DatabaseViewEditScope;
  hasPersonalChanges: boolean;
  hasPersonalQueryChanges: boolean;
  onChanged: DatabaseChangeHandler;
  onConfigureField: (field: DatabaseField, trigger: HTMLElement) => void;
  onCopyViewLink: () => void;
  onEditScopeChange: (scope: DatabaseViewEditScope) => void;
  onEffectiveStateChanged: () => Promise<void>;
  onRenameView: (name: string) => Promise<boolean>;
  onResetForMe: () => Promise<void>;
  onSaveForView: () => Promise<void>;
  record: DatabaseRecord;
  requestedSection: DatabaseWorkbenchContextSection;
  resettingPersonalState: boolean;
  rowTemplates: DatabaseRowTemplateBinding[];
  rows: DatabaseRowRecord[];
  savingPersonalState: boolean;
  workspaceId: string;
}) {
  const t = useI18n();
  const capabilities = databaseManagedCapabilities(record);
  const [openViewSections, setOpenViewSections] = useState<string[]>(
    VIEW_SECTIONS.includes(requestedSection as DatabaseViewControlSection)
      ? [requestedSection]
      : ["fields"],
  );
  const [openDatabaseSections, setOpenDatabaseSections] = useState<string[]>(
    VIEW_SECTIONS.includes(requestedSection as DatabaseViewControlSection)
      ? []
      : [requestedSection],
  );
  const [personalStatus, setPersonalStatus] =
    useState<PersonalActionStatus>("idle");
  const [viewNameDraft, setViewNameDraft] = useState(activeView.name);

  useEffect(() => {
    if (
      VIEW_SECTIONS.includes(requestedSection as DatabaseViewControlSection)
    ) {
      setOpenViewSections((current) =>
        current.includes(requestedSection)
          ? current
          : [...current, requestedSection],
      );
      return;
    }
    setOpenDatabaseSections((current) =>
      current.includes(requestedSection)
        ? current
        : [...current, requestedSection],
    );
  }, [requestedSection]);

  useEffect(() => {
    setPersonalStatus("idle");
    setViewNameDraft(activeView.name);
  }, [activeView.id, activeView.name]);

  const availableViewSections = useMemo(
    () =>
      VIEW_SECTIONS.filter(
        (section) =>
          viewSupportsSection(activeView, section) &&
          (capabilities.canEditStructure ||
            section === "filter" ||
            section === "sort"),
      ),
    [activeView, capabilities.canEditStructure],
  );

  const runPersonalAction = useCallback(async (action: () => Promise<void>) => {
    setPersonalStatus("saving");
    try {
      await action();
      setPersonalStatus("saved");
    } catch {
      setPersonalStatus("failure");
    }
  }, []);

  const personalStatusLabel =
    personalStatus === "saving"
      ? t["common.saving"]()
      : personalStatus === "saved"
        ? t["com.myoxus.database.view.saved"]()
        : personalStatus === "failure"
          ? t["com.myoxus.database.view.update-failed"]()
          : null;

  return (
    <WorkbenchContextScrollRoot data-testid="database-workbench-context">
      <Scrollable.Viewport
        scrollbars="y"
        data-myoxus-ui-role="database-context-viewport"
      >
        <Stack gap="md">
          <Group justify="space-between" align="center" wrap="nowrap">
            <Stack gap="xs" flex={1} miw={0}>
              <MyoxusText typographySlot="body-small" tone="secondary">
                {t["com.myoxus.database.view.settings"]()}
              </MyoxusText>
              <MyoxusText component="div" typographySlot="card-title">
                <InlineEdit
                  editable={effectiveState.canEditShared}
                  displayLineClamp={2}
                  inputAttrs={{
                    "aria-label": `${t["Rename"]()}: ${activeView.name}`,
                  }}
                  onInput={setViewNameDraft}
                  onChange={(name) => {
                    const trimmed = name.trim();
                    if (!trimmed) {
                      setViewNameDraft(activeView.name);
                      return;
                    }
                    void onRenameView(trimmed);
                  }}
                  value={viewNameDraft}
                />
              </MyoxusText>
            </Stack>
            <Menu
              items={
                <MenuItem prefix={<CopyIcon />} onSelect={onCopyViewLink}>
                  {t["com.myoxus.database.view.copy-link"]()}
                </MenuItem>
              }
            >
              <IconButton
                aria-label={t["com.myoxus.database.view.more"]()}
                tooltip={t["com.myoxus.database.view.more"]()}
              >
                <MoreHorizontalIcon />
              </IconButton>
            </Menu>
          </Group>

          {hasPersonalChanges ? (
            <Stack gap="xs" data-testid="database-context-personal-changes">
              <Group gap="xs" wrap="wrap">
                <Badge tone="info">
                  {t["com.myoxus.database.view.personal-changes"]()}
                </Badge>
                {personalStatusLabel ? (
                  <Badge
                    tone={
                      personalStatus === "failure"
                        ? "error"
                        : personalStatus === "saved"
                          ? "success"
                          : "info"
                    }
                    aria-live="polite"
                  >
                    {personalStatusLabel}
                  </Badge>
                ) : null}
              </Group>
              <Group gap="xs" wrap="wrap">
                <Button
                  variant="ghost"
                  loading={resettingPersonalState}
                  onClick={() => void runPersonalAction(onResetForMe)}
                >
                  {t["com.myoxus.database.view.reset-for-me"]()}
                </Button>
                {effectiveState.canEditShared && hasPersonalQueryChanges ? (
                  <Button
                    variant="secondary"
                    loading={savingPersonalState}
                    onClick={() => void runPersonalAction(onSaveForView)}
                  >
                    {t["com.myoxus.database.view.save-to-view"]()}
                  </Button>
                ) : null}
              </Group>
            </Stack>
          ) : null}

          <Accordion
            multiple
            value={openViewSections}
            onChange={(value) =>
              setOpenViewSections(Array.isArray(value) ? value : [])
            }
            data-testid="database-context-view-settings"
          >
            {availableViewSections.map((section) => (
              <AccordionItem key={section} value={section}>
                <AccordionControl>
                  <MyoxusText
                    component="span"
                    tone="secondary"
                    typographySlot="body-small"
                  >
                    {databaseViewControlTitle(t, section)}
                  </MyoxusText>
                </AccordionControl>
                <AccordionPanel>
                  <ViewSettingsSectionEditor
                    active={openViewSections.includes(section)}
                    databaseId={databaseId}
                    effectiveState={effectiveState}
                    editScope={editScope}
                    onChanged={onChanged}
                    onEditScopeChange={onEditScopeChange}
                    onEffectiveStateChanged={onEffectiveStateChanged}
                    record={record}
                    section={section}
                    view={activeView}
                  />
                </AccordionPanel>
              </AccordionItem>
            ))}
          </Accordion>

          <Divider space="none" />

          <MyoxusText typographySlot="body-small" tone="secondary">
            {t["com.myoxus.database.settings"]()}
          </MyoxusText>
          <Accordion
            multiple
            value={openDatabaseSections}
            onChange={(value) =>
              setOpenDatabaseSections(Array.isArray(value) ? value : [])
            }
            data-testid="database-context-database-settings"
          >
            {assistance ? (
              <AccordionItem value="assistance">
                <AccordionControl>
                  {t["com.myoxus.assistance.title"]()}
                </AccordionControl>
                <AccordionPanel>{assistance}</AccordionPanel>
              </AccordionItem>
            ) : null}
            {capabilities.canEditStructure ? (
              <AccordionItem value="database-fields">
                <AccordionControl>
                  <MyoxusText
                    component="span"
                    tone="secondary"
                    typographySlot="body-small"
                  >
                    {t["com.myoxus.database.fields"]()}
                  </MyoxusText>
                </AccordionControl>
                <AccordionPanel>
                  <Stack gap="xs">
                    {sortByPosition(record.fields).map((field) => (
                      <NavigationLink
                        key={field.id}
                        component="button"
                        type="button"
                        label={field.name}
                        description={databaseFieldTypeLabel(t, field.fieldType)}
                        disabled={!effectiveState.canEditShared}
                        aria-label={t["com.myoxus.database.field.settings"]({
                          field: field.name,
                        })}
                        onClick={(event) =>
                          onConfigureField(field, event.currentTarget)
                        }
                        data-myoxus-ui-role="database-field-settings-row"
                      />
                    ))}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
            ) : null}
            <AccordionItem value="templates">
              <AccordionControl>
                <MyoxusText
                  component="span"
                  tone="secondary"
                  typographySlot="body-small"
                >
                  {t["com.myoxus.database.rowTemplate.manage"]()}
                </MyoxusText>
              </AccordionControl>
              <AccordionPanel>
                <RowTemplateManagementPanel
                  canEdit={canManageContent}
                  databaseId={databaseId}
                  onChanged={onChanged}
                  record={record}
                  rowTemplates={rowTemplates}
                  rows={rows}
                />
              </AccordionPanel>
            </AccordionItem>
            <AccordionItem value="automations">
              <AccordionControl>
                <MyoxusText
                  component="span"
                  tone="secondary"
                  typographySlot="body-small"
                >
                  {t["com.myoxus.database.automation.title"]()}
                </MyoxusText>
              </AccordionControl>
              <AccordionPanel>
                <DatabaseAutomationsPanel
                  canUseTaskAssistance={
                    taskAssistanceAvailable &&
                    capabilities.managed &&
                    capabilities.ready
                  }
                  canEdit={canManageContent}
                  databaseId={databaseId}
                  workspaceId={workspaceId}
                />
              </AccordionPanel>
            </AccordionItem>
            <AccordionItem value="activity">
              <AccordionControl>
                <MyoxusText
                  component="span"
                  tone="secondary"
                  typographySlot="body-small"
                >
                  {t["com.myoxus.sidebar.tab.activity"]()}
                </MyoxusText>
              </AccordionControl>
              <AccordionPanel>
                <DatabaseActivityPanel
                  databaseId={databaseId}
                  workspaceId={workspaceId}
                />
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        </Stack>
      </Scrollable.Viewport>
      <Scrollable.Scrollbar />
    </WorkbenchContextScrollRoot>
  );
}

/** Settings and assistance-only Tasks content share the existing Context Card. */
type DatabaseWorkbenchContextSurfaceProps = (
  ComponentProps<typeof DatabaseWorkbenchContext> | { children: ReactNode }
) & { label?: string };

export function DatabaseWorkbenchContextSurface(
  props: DatabaseWorkbenchContextSurfaceProps,
) {
  const t = useI18n();
  const { label, ...body } = props;
  return (
    <ViewContextSurface
      surfaceId={DATABASE_WORKBENCH_CONTEXT_SURFACE_ID}
      order={20}
      label={label ?? t["com.myoxus.database.settings"]()}
      tooltip={label ?? t["com.myoxus.database.settings"]()}
      icon={<SettingsIcon />}
      viewFamilies={DATABASE_VIEW_FAMILY}
    >
      {"activeView" in body ? (
        <DatabaseWorkbenchContext {...body} />
      ) : (
        body.children
      )}
    </ViewContextSurface>
  );
}
