// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT
import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import type { DocumentVersion } from "./types";
import type { HistorySelection } from "./history-selection";
import { historySourceI18nKey, useDocumentHistory } from "./history-data";
import { historyListGroupByDay } from "./history-preview";
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Avatar,
  Badge,
  Button,
  Divider,
  Group,
  Menu,
  MenuItem,
  MenuTrigger,
  MyoxusSegmentedControl,
  MyoxusText,
  Scrollable,
  SettingsNotice,
  Stack,
  SurfaceList,
  SurfaceListAction,
  SurfaceListItem,
  SurfaceListHeaderTitle,
  TimelineList,
  TimelineListItem,
} from "@myoxus/ui-facade";
import { useMemo, useRef, useState } from "react";
type HistoryList = ReturnType<typeof useDocumentHistory>[0];

export const HistoryTimeline = ({
  historyList,
  namedVersions,
  onLoadMore,
  loadingMore,
  selection,
  onSelectionChange,
  canName,
  onName,
  onEdit,
  onTogglePin,
  versionActionBusy,
  namedOnly,
  onNamedOnlyChange,
}: {
  selection?: HistorySelection;
  onSelectionChange: (selection: HistorySelection) => void;
  historyList: HistoryList;
  namedVersions: DocumentVersion[];
  onLoadMore: (() => void) | false;
  loadingMore: boolean;
  canName: boolean;
  onName: (
    snapshotId: string,
    versionIds: string[],
    opener?: HTMLElement | null,
  ) => void;
  onEdit: (version: DocumentVersion, opener?: HTMLElement | null) => void;
  onTogglePin: (version: DocumentVersion) => void;
  versionActionBusy: string | null;
  namedOnly: boolean;
  onNamedOnlyChange: (namedOnly: boolean) => void;
}) => {
  const t = useI18n();
  const { formatDate, formatTime } = useRegionalFormatters();
  // Menu items unmount on selection; their persistent row trigger owns return focus.
  const actionTriggers = useRef(new Map<string, HTMLButtonElement>());
  const historyListByDay = useMemo(
    () => historyListGroupByDay(historyList, formatDate),
    [historyList, formatDate],
  );
  const references = useMemo(() => {
    const entries = new Map<string, DocumentVersion[]>();
    for (const version of namedVersions) {
      const versions = entries.get(version.docHistoryId) ?? [];
      versions.push(version);
      entries.set(version.docHistoryId, versions);
    }
    return entries;
  }, [namedVersions]);
  const [closedDays, setClosedDays] = useState<string[]>([]);
  const openDays = useMemo(
    () =>
      historyListByDay
        .map(([day]) => day)
        .filter((day) => !closedDays.includes(day)),
    [closedDays, historyListByDay],
  );
  const handleAccordionChange = (nextOpen: string | string[] | null) => {
    const nextOpenSet = new Set(
      Array.isArray(nextOpen) ? nextOpen : nextOpen ? [nextOpen] : [],
    );
    setClosedDays(
      historyListByDay
        .map(([day]) => day)
        .filter((day) => !nextOpenSet.has(day)),
    );
  };
  return (
    <Stack
      data-myoxus-ui-role="page-history-list"
      flex="1 1 0"
      gap={0}
      mih={0}
      miw={0}
    >
      <Stack component="header" data-myoxus-ui-role="page-history-list-header">
        <SurfaceListHeaderTitle>
          {t["com.myoxus.history.version-history"]()}
        </SurfaceListHeaderTitle>
        <MyoxusSegmentedControl
          aria-label={t["com.myoxus.history.filter.label"]()}
          data={[
            {
              value: "all",
              label: t["com.myoxus.history.filter.all"](),
              testId: "history-filter-all",
            },
            {
              value: "named",
              label: t["com.myoxus.history.filter.named"](),
              testId: "history-filter-named",
            },
          ]}
          layout="sidebar"
          onChange={(value) => onNamedOnlyChange(value === "named")}
          testId="history-filter"
          value={namedOnly ? "named" : "all"}
        />
      </Stack>
      <Divider space="none" />
      <Scrollable.Root
        data-myoxus-ui-role="page-history-list-scroll-root"
        flex="1 1 auto"
        minHeight={0}
      >
        <Scrollable.Viewport
          fill
          data-myoxus-ui-role="page-history-list-scroll-viewport"
        >
          <SurfaceList>
            {!historyList.length ? (
              <SettingsNotice>
                {t["com.myoxus.history.filter.empty"]()}
              </SettingsNotice>
            ) : null}
            {historyListByDay.length ? (
              <Accordion
                multiple
                transitionDuration={0}
                value={openDays}
                onChange={handleAccordionChange}
              >
                {historyListByDay.map(([day, list]) => {
                  const isOpen = openDays.includes(day);
                  return (
                    <AccordionItem
                      key={day}
                      value={day}
                      data-myoxus-ui-role="page-history-group"
                    >
                      <AccordionControl
                        data-state={isOpen ? "open" : "closed"}
                        data-testid="page-list-group-header-collapsed-button"
                      >
                        {day}
                      </AccordionControl>
                      <AccordionPanel data-myoxus-ui-role="page-history-group-content">
                        <TimelineList>
                          {list.map((history) => (
                            <TimelineListItem key={history.snapshotId}>
                              <SurfaceListItem
                                appearance="row"
                                density="compact"
                                fullWidth
                                layout="row"
                                selected={
                                  selection?.snapshotId === history.snapshotId
                                }
                              >
                                <SurfaceListAction
                                  aria-pressed={
                                    selection?.snapshotId === history.snapshotId
                                  }
                                  data-testid="version-history-item"
                                  data-snapshot-id={history.snapshotId}
                                  onClick={() =>
                                    onSelectionChange({
                                      snapshotId: history.snapshotId,
                                    })
                                  }
                                >
                                  <Stack>
                                    <Group>
                                      <MyoxusText
                                        component="span"
                                        typographySlot="label-compact"
                                      >
                                        {t[
                                          historySourceI18nKey(history.origin)
                                        ]()}
                                      </MyoxusText>
                                      <MyoxusText
                                        component="span"
                                        tone="secondary"
                                        typographySlot="body-small"
                                      >
                                        {formatTime(history.timestamp)}
                                      </MyoxusText>
                                      {history.editor ? (
                                        <>
                                          <Avatar
                                            url={history.editor.avatarUrl ?? ""}
                                            name={history.editor.name}
                                            size="xs"
                                          />
                                          <MyoxusText
                                            component="span"
                                            tone="secondary"
                                            typographySlot="body-small"
                                          >
                                            {history.editor.name}
                                          </MyoxusText>
                                        </>
                                      ) : null}
                                    </Group>
                                    {(
                                      references.get(history.snapshotId) ?? []
                                    ).map((version) => (
                                      <Group
                                        key={version.id}
                                        data-version-id={version.id}
                                      >
                                        <MyoxusText
                                          component="span"
                                          typographySlot="label-compact"
                                        >
                                          {version.label}
                                        </MyoxusText>
                                        {version.versionNo !== null ? (
                                          <Badge
                                            aria-label={t[
                                              "com.myoxus.sidebar.document-versions.meta.number"
                                            ]()}
                                          >
                                            {new Intl.NumberFormat(
                                              t.language,
                                            ).format(version.versionNo)}
                                          </Badge>
                                        ) : null}
                                        {version.isPinned ? (
                                          <Badge>
                                            {t[
                                              "com.myoxus.sidebar.document-versions.badge.pinned"
                                            ]()}
                                          </Badge>
                                        ) : null}
                                        {version.isProtected ? (
                                          <Badge>
                                            {t[
                                              "com.myoxus.sidebar.document-versions.meta.protected"
                                            ]()}
                                          </Badge>
                                        ) : null}
                                      </Group>
                                    ))}
                                  </Stack>
                                </SurfaceListAction>
                                {canName ? (
                                  <Menu
                                    contentOptions={{ align: "end" }}
                                    items={
                                      <>
                                        <MenuItem
                                          data-testid="history-name-state"
                                          onSelect={() =>
                                            onName(
                                              history.snapshotId,
                                              (
                                                references.get(
                                                  history.snapshotId,
                                                ) ?? []
                                              ).map(({ id }) => id),
                                              actionTriggers.current.get(
                                                history.snapshotId,
                                              ),
                                            )
                                          }
                                        >
                                          {t[
                                            "com.myoxus.history.action.name"
                                          ]()}
                                        </MenuItem>
                                        {(
                                          references.get(history.snapshotId) ??
                                          []
                                        ).map((version) => (
                                          <MenuItem
                                            disabled={
                                              versionActionBusy === version.id
                                            }
                                            key={`edit:${version.id}`}
                                            onSelect={() =>
                                              onEdit(
                                                version,
                                                actionTriggers.current.get(
                                                  history.snapshotId,
                                                ),
                                              )
                                            }
                                          >
                                            {t[
                                              "com.myoxus.sidebar.document-versions.action.edit"
                                            ]()}
                                            : {version.label}
                                          </MenuItem>
                                        ))}
                                        {(
                                          references.get(history.snapshotId) ??
                                          []
                                        ).map((version) => (
                                          <MenuItem
                                            disabled={
                                              versionActionBusy === version.id
                                            }
                                            key={`pin:${version.id}`}
                                            onSelect={() =>
                                              onTogglePin(version)
                                            }
                                          >
                                            {version.isPinned
                                              ? t[
                                                  "com.myoxus.sidebar.document-versions.action.unpin"
                                                ]()
                                              : t[
                                                  "com.myoxus.sidebar.document-versions.action.pin"
                                                ]()}
                                            : {version.label}
                                          </MenuItem>
                                        ))}
                                      </>
                                    }
                                  >
                                    <MenuTrigger
                                      ref={(node) => {
                                        if (node)
                                          actionTriggers.current.set(
                                            history.snapshotId,
                                            node,
                                          );
                                        else
                                          actionTriggers.current.delete(
                                            history.snapshotId,
                                          );
                                      }}
                                      data-testid="history-row-actions"
                                      variant="plain"
                                    >
                                      {t["com.myoxus.actions"]()}
                                    </MenuTrigger>
                                  </Menu>
                                ) : null}
                              </SurfaceListItem>
                            </TimelineListItem>
                          ))}
                        </TimelineList>
                      </AccordionPanel>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            ) : null}
            {onLoadMore ? (
              <Button
                block
                data-testid="page-history-load-more"
                variant="plain"
                loading={loadingMore}
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {t["com.myoxus.history.confirm-restore-modal.load-more"]()}
              </Button>
            ) : null}
          </SurfaceList>
        </Scrollable.Viewport>
        <Scrollable.Scrollbar />
      </Scrollable.Root>
    </Stack>
  );
};
