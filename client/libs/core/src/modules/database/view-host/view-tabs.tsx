// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AllDocsGridViewIcon,
  CalendarDaysIcon,
  DatabaseKanbanViewIcon,
  DatabaseListViewIcon,
  DatabaseTableViewIcon,
  EditIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ProgressIcon,
  TimelineIcon,
  TrashIcon,
} from "@myoxus/icons/react";
import {
  Button,
  FormRow,
  Group,
  IconButton,
  Input,
  Menu,
  MenuItem,
  Modal,
  OverflowTabsList,
  Stack,
  TabsList,
  TabsTrigger,
} from "@myoxus/ui-facade";
import { type RefObject, useState } from "react";

import type { DatabaseView } from "../types";
import {
  DatabaseViewIcon,
  openDatabaseDialogAfterMenuClose,
} from "../view-controls";

interface DatabaseViewTabsProps {
  canEditStructure?: boolean;
  canDeleteView: boolean;
  createTriggerRef: RefObject<HTMLButtonElement | null>;
  detailFallbackFocusRef?: RefObject<HTMLButtonElement | null>;
  labels: {
    addCalendar: string;
    addGallery: string;
    addGantt: string;
    addKanban: string;
    addList: string;
    addProgress: string;
    addTable: string;
    addTimeline: string;
    cancel: string;
    copyLink: string;
    create: string;
    delete: string;
    more: string;
    rename: string;
    reorderInstruction: string;
    reorderAnnouncement: (
      name: string,
      position: number,
      total: number,
    ) => string;
    viewActions: (name: string) => string;
  };
  onCopyLink: (view: DatabaseView) => Promise<void> | void;
  onCreateCalendar: () => Promise<void> | void;
  onCreateGallery: () => Promise<void> | void;
  onCreateGantt: () => Promise<void> | void;
  onCreateKanban: () => Promise<void> | void;
  onCreateList: () => Promise<void> | void;
  onCreateProgress: () => Promise<void> | void;
  onCreateTable: () => Promise<void> | void;
  onCreateTimeline: () => Promise<void> | void;
  onDelete: (view: DatabaseView) => Promise<void> | void;
  onRename: (view: DatabaseView, name: string) => Promise<boolean>;
  onReorder: (orderedViewIds: string[]) => Promise<void> | void;
  onViewChange: (viewId: string) => void;
  activeViewId: string;
  variant: "page" | "panel";
  views: DatabaseView[];
}

/** Host-owned navigation shared by standalone and embedded Database views. */
export function DatabaseViewTabs({
  activeViewId,
  canDeleteView,
  canEditStructure = true,
  createTriggerRef,
  detailFallbackFocusRef,
  labels,
  onCopyLink,
  onCreateCalendar,
  onCreateGallery,
  onCreateGantt,
  onCreateKanban,
  onCreateList,
  onCreateProgress,
  onCreateTable,
  onCreateTimeline,
  onDelete,
  onRename,
  onReorder,
  onViewChange,
  variant,
  views,
}: DatabaseViewTabsProps) {
  // The controller owns server ordering and temporary optimistic ordering.
  // Re-sorting here would hide the optimistic state until the mutation returns.
  const orderedViews = views;
  const [renameView, setRenameView] = useState<DatabaseView | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);

  if (variant === "panel") {
    return (
      <TabsList variant={variant}>
        {orderedViews.map((view) => (
          <TabsTrigger
            ref={view.id === activeViewId ? detailFallbackFocusRef : undefined}
            key={view.id}
            value={view.id}
            variant={variant}
            leftSection={
              <DatabaseViewIcon icon={view.icon} kind={view.viewKind} />
            }
            title={view.name}
            truncate
            data-testid={`database-view-tab-${view.id}`}
          >
            {view.name}
          </TabsTrigger>
        ))}
      </TabsList>
    );
  }

  const openRename = (view: DatabaseView) => {
    openDatabaseDialogAfterMenuClose(() => {
      setRenameValue(view.name);
      setRenameView(view);
    });
  };
  const submitRename = async () => {
    const name = renameValue.trim();
    if (!renameView || !name) return;
    setRenaming(true);
    try {
      if (await onRename(renameView, name)) setRenameView(null);
    } finally {
      setRenaming(false);
    }
  };
  const activeView =
    orderedViews.find((view) => view.id === activeViewId) ?? orderedViews[0];
  const renderViewActions = (view: DatabaseView) => (
    <>
      {canEditStructure ? (
        <MenuItem prefix={<EditIcon />} onSelect={() => openRename(view)}>
          {labels.rename}
        </MenuItem>
      ) : null}
      <MenuItem prefix={<LinkIcon />} onSelect={() => void onCopyLink(view)}>
        {labels.copyLink}
      </MenuItem>
      {canEditStructure ? (
        <MenuItem
          disabled={!canDeleteView}
          type="danger"
          prefix={<TrashIcon />}
          onSelect={() => void onDelete(view)}
        >
          {labels.delete}
        </MenuItem>
      ) : null}
    </>
  );

  return (
    <>
      <OverflowTabsList
        activeValue={activeViewId}
        appearance="switcher"
        items={orderedViews.map((view) => ({
          value: view.id,
          label: view.name,
          textLabel: view.name,
          leftSection: (
            <DatabaseViewIcon icon={view.icon} kind={view.viewKind} />
          ),
          testId: `database-view-tab-${view.id}`,
        }))}
        moreLabel={labels.more}
        onValueChange={onViewChange}
        onReorder={canEditStructure ? onReorder : undefined}
        reorderInstruction={labels.reorderInstruction}
        reorderAnnouncement={(item, index, total) =>
          labels.reorderAnnouncement(item.textLabel, index + 1, total)
        }
        variant={variant}
        data-testid="database-view-navigation"
        endControl={
          <>
            {activeView ? (
              <Menu
                items={renderViewActions(activeView)}
                contentOptions={{ align: "end", panelWidth: "comfortable" }}
              >
                <IconButton
                  ref={detailFallbackFocusRef}
                  aria-label={labels.viewActions(activeView.name)}
                  tooltip={labels.viewActions(activeView.name)}
                  size="small"
                  variant="plain"
                  data-testid="database-active-view-menu-trigger"
                >
                  <MoreHorizontalIcon />
                </IconButton>
              </Menu>
            ) : null}
            {canEditStructure ? (
              <Menu
                items={
                  <>
                    <MenuItem
                      prefix={<DatabaseTableViewIcon />}
                      onSelect={() => void onCreateTable()}
                    >
                      {labels.addTable}
                    </MenuItem>
                    <MenuItem
                      prefix={<DatabaseKanbanViewIcon />}
                      onSelect={() =>
                        openDatabaseDialogAfterMenuClose(
                          () => void onCreateKanban(),
                        )
                      }
                    >
                      {labels.addKanban}
                    </MenuItem>
                    <MenuItem
                      prefix={<DatabaseListViewIcon />}
                      onSelect={() => void onCreateList()}
                    >
                      {labels.addList}
                    </MenuItem>
                    <MenuItem
                      prefix={<AllDocsGridViewIcon />}
                      onSelect={() => void onCreateGallery()}
                    >
                      {labels.addGallery}
                    </MenuItem>
                    <MenuItem
                      prefix={<CalendarDaysIcon />}
                      onSelect={() => void onCreateCalendar()}
                    >
                      {labels.addCalendar}
                    </MenuItem>
                    <MenuItem
                      prefix={<TimelineIcon />}
                      onSelect={() => void onCreateGantt()}
                    >
                      {labels.addGantt}
                    </MenuItem>
                    <MenuItem
                      prefix={<TimelineIcon />}
                      onSelect={() => void onCreateTimeline()}
                    >
                      {labels.addTimeline}
                    </MenuItem>
                    <MenuItem
                      prefix={<ProgressIcon />}
                      onSelect={() =>
                        openDatabaseDialogAfterMenuClose(
                          () => void onCreateProgress(),
                        )
                      }
                    >
                      {labels.addProgress}
                    </MenuItem>
                  </>
                }
                contentOptions={{ align: "end", panelWidth: "comfortable" }}
              >
                <IconButton
                  ref={createTriggerRef}
                  aria-label={labels.create}
                  tooltip={labels.create}
                  size="small"
                  variant="plain"
                  data-testid="database-view-create-trigger"
                >
                  <PlusIcon />
                </IconButton>
              </Menu>
            ) : null}
          </>
        }
      />
      <Modal
        open={Boolean(renameView)}
        onOpenChange={(open) => {
          if (!open && !renaming) setRenameView(null);
        }}
        title={labels.rename}
        contentOptions={{ "data-testid": "database-view-rename-modal" }}
      >
        <Stack gap="md">
          <FormRow label={labels.rename}>
            <Input
              autoFocus
              aria-label={labels.rename}
              value={renameValue}
              onChange={setRenameValue}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitRename();
                }
              }}
            />
          </FormRow>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRenameView(null)}>
              {labels.cancel}
            </Button>
            <Button
              variant="primary"
              loading={renaming}
              disabled={!renameValue.trim()}
              data-testid="database-view-rename-submit"
              onClick={() => void submitRename()}
            >
              {labels.rename}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
