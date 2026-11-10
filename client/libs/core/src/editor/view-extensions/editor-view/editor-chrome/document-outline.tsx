// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  EdgelessIcon,
  InvisibleIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PageIcon,
  SettingsIcon,
  SortIcon,
  TextIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Alert,
  Box,
  Button,
  Divider,
  Group,
  IconButton,
  Menu,
  MenuItem,
  MyoxusText,
  Scrollable,
  Stack,
  StructureTreeLabel,
  StructureTreeContent,
  StructureTreeRoot,
  StructureTreeRow,
} from "@myoxus/ui-facade";
import { NoteDisplayMode } from "@virgultum/editor/model";
import type {
  EditorOutlineControls,
  EditorOutlineEntryControls,
  EditorOutlineState,
} from "@virgultum/editor/shared/services";
import { Fragment, useEffect, useRef, useSyncExternalStore } from "react";
import { editorGlyph } from "./glyphs";

function ReferenceIcon({ docId }: { docId: string }) {
  const display = useService(DocDisplayMetaService);
  const Icon = useLiveData(display.icon$(docId));
  return <Icon />;
}

export function EditorOutlineEntry({
  entry,
  active,
  showIcon,
  disabled,
  activate,
}: EditorOutlineEntryControls) {
  return (
    <StructureTreeContent level={entry.level}>
      <StructureTreeRow
        component="button"
        active={active}
        disabled={disabled}
        title={entry.label}
        data-outline-id={entry.id}
        onClick={(event) => activate(event.shiftKey)}
        leftSection={showIcon ? editorGlyph(entry.icon) : undefined}
        label={
          <StructureTreeLabel>
            {entry.segments?.map((segment, index) => (
              <Fragment key={index}>
                {segment.docId ? (
                  <ReferenceIcon docId={segment.docId} />
                ) : segment.unavailable ? (
                  <LinkIcon />
                ) : null}
                {segment.text}
              </Fragment>
            )) ?? entry.label}
          </StructureTreeLabel>
        }
      />
    </StructureTreeContent>
  );
}

function OutlineNote({
  note,
  state,
  controls,
}: {
  note: EditorOutlineState["notes"][number];
  state: EditorOutlineState;
  controls: EditorOutlineControls;
}) {
  const t = useI18n();
  // Keep the native drag source registered while selection and drop state rerender.
  const root = useRef<HTMLDivElement>(null);
  useEffect(
    () => (root.current ? controls.bindNote(root.current, note.id) : undefined),
    [controls, note.id],
  );
  const modeLabel =
    note.mode === NoteDisplayMode.DocOnly
      ? state.labels.modePage
      : note.mode === NoteDisplayMode.EdgelessOnly
        ? state.labels.modeEdgeless
        : state.labels.modeBoth;
  return (
    <Box
      ref={root}
      data-note-id={note.id}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("[data-outline-id]"))
          controls.select(note.id, event.shiftKey);
      }}
      onDoubleClick={() => controls.fit(note.id)}
    >
      {state.drop?.id === note.id && state.drop.edge === "top" && <Divider />}
      {state.sorting && (
        <Group
          justify="space-between"
          wrap="nowrap"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Button
            variant={note.selected ? "secondary" : "plain"}
            onClick={(event) => controls.select(note.id, event.shiftKey)}
            onDoubleClick={() => controls.fit(note.id)}
          >
            {note.mode === NoteDisplayMode.EdgelessOnly ? (
              <InvisibleIcon />
            ) : (
              new Intl.NumberFormat(t.language).format(note.index + 1)
            )}
          </Button>
          <Menu
            items={
              <>
                {[
                  NoteDisplayMode.DocAndEdgeless,
                  NoteDisplayMode.DocOnly,
                  NoteDisplayMode.EdgelessOnly,
                ].map((mode) => (
                  <MenuItem
                    key={mode}
                    disabled={state.readonly}
                    checked={note.mode === mode}
                    prefixIcon={
                      mode === NoteDisplayMode.DocOnly ? (
                        <PageIcon />
                      ) : mode === NoteDisplayMode.EdgelessOnly ? (
                        <EdgelessIcon />
                      ) : (
                        <LinkIcon />
                      )
                    }
                    onSelect={() => controls.changeMode(note.id, mode)}
                  >
                    {mode === NoteDisplayMode.DocOnly
                      ? state.labels.modePage
                      : mode === NoteDisplayMode.EdgelessOnly
                        ? state.labels.modeEdgeless
                        : state.labels.modeBoth}
                  </MenuItem>
                ))}
              </>
            }
          >
            <IconButton
              aria-label={`${t["com.myoxus.editor.note.display-mode"]()} · ${modeLabel}`}
              tooltip={modeLabel}
            >
              <MoreHorizontalIcon />
            </IconButton>
          </Menu>
        </Group>
      )}
      {note.entries.map((entry) => (
        <EditorOutlineEntry
          key={entry.id}
          entry={entry}
          active={state.activeId === entry.id}
          showIcon={state.showIcons}
          disabled={note.mode === NoteDisplayMode.EdgelessOnly}
          activate={(multiple) => {
            controls.select(note.id, !!multiple);
            if (!state.edgeless) controls.navigate(entry.id);
          }}
        />
      ))}
      {state.drop?.id === note.id && state.drop.edge === "bottom" && (
        <Divider />
      )}
    </Box>
  );
}

export function EditorDocumentOutline({
  controls,
}: {
  controls: EditorOutlineControls;
}) {
  const t = useI18n();
  const state = useSyncExternalStore(controls.subscribe, controls.getSnapshot);
  return (
    <Stack
      data-myoxus-ui-role="document-outline"
      onKeyDown={(event) => {
        const key = event.key.toLowerCase();
        if (
          state.sorting &&
          (event.ctrlKey || event.metaKey) &&
          (key === "z" || (event.ctrlKey && key === "y"))
        ) {
          event.preventDefault();
          event.stopPropagation();
          controls.history(key === "y" || event.shiftKey);
        } else if (event.key === "Enter" || event.key === " ")
          event.stopPropagation();
      }}
    >
      {!state.hideHeader && (
        <Group justify="space-between" wrap="nowrap">
          <MyoxusText>{state.labels.title}</MyoxusText>
          <Group justify="end">
            <Menu
              items={
                <MenuItem
                  checked={state.showIcons}
                  prefixIcon={<TextIcon />}
                  onSelect={controls.toggleIcons}
                >
                  {t["com.myoxus.sidebar.outline.show-type-icon"]()}
                </MenuItem>
              }
            >
              <IconButton
                aria-label={state.labels.previewSettings}
                tooltip={state.labels.previewSettings}
              >
                <SettingsIcon />
              </IconButton>
            </Menu>
            <IconButton
              aria-label={state.labels.visibilityAndSort}
              tooltip={state.labels.visibilityAndSort}
              aria-pressed={state.sorting}
              variant={state.sorting ? "secondary" : "plain"}
              onClick={controls.toggleSorting}
            >
              <SortIcon />
            </IconButton>
          </Group>
        </Group>
      )}
      <Scrollable.Viewport
        autosize
        maxHeight="popover"
        ref={controls.bindScroll}
      >
        <StructureTreeRoot>
          {state.title && (
            <EditorOutlineEntry
              entry={state.title}
              active={state.activeId === state.title.id}
              showIcon={false}
              activate={() => controls.navigate(state.title!.id)}
            />
          )}
          {state.notes.length ? (
            state.notes.map((note) => (
              <Fragment key={note.id}>
                {note.mode === NoteDisplayMode.EdgelessOnly &&
                  state.notes.find(
                    (n) => n.mode === NoteDisplayMode.EdgelessOnly,
                  )?.id === note.id && (
                    <MyoxusText tone="secondary">
                      {state.labels.hiddenContents}
                    </MyoxusText>
                  )}
                <OutlineNote note={note} state={state} controls={controls} />
              </Fragment>
            ))
          ) : (
            <>
              {state.previous !== undefined && (
                <Group justify="center">
                  <IconButton
                    aria-label={state.labels.previous}
                    tooltip={state.labels.previous}
                    data-testid="outline-window-previous"
                    onClick={() => controls.window(state.previous!)}
                  >
                    <ArrowUpSmallIcon />
                  </IconButton>
                </Group>
              )}
              {state.entries.map((entry) => (
                <EditorOutlineEntry
                  key={entry.id}
                  entry={entry}
                  active={state.activeId === entry.id}
                  showIcon={state.showIcons}
                  activate={() => controls.navigate(entry.id)}
                />
              ))}
              {state.next !== undefined && (
                <Group justify="center">
                  <IconButton
                    aria-label={state.labels.next}
                    tooltip={state.labels.next}
                    data-testid="outline-window-next"
                    onClick={() => controls.window(state.next!)}
                  >
                    <ArrowDownSmallIcon />
                  </IconButton>
                </Group>
              )}
            </>
          )}
          {!state.entries.length && !state.notes.length && (
            <MyoxusText tone="secondary" data-testid="empty-panel-placeholder">
              {state.labels.emptyPlaceholder}
            </MyoxusText>
          )}
        </StructureTreeRoot>
      </Scrollable.Viewport>
      {state.notice && (
        <Alert
          title={state.labels.hiddenNoticeTitle}
          withCloseButton
          closeButtonLabel={t["Close"]()}
          onClose={controls.dismissNotice}
        >
          <MyoxusText>{state.labels.hiddenNoticeBody}</MyoxusText>
          <Button variant="secondary" onClick={controls.toggleSorting}>
            {state.labels.visibilityAndSort}
          </Button>
        </Alert>
      )}
    </Stack>
  );
}
