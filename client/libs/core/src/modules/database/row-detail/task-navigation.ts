// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { useServiceOptional } from "@myoxus/infra";
import { ViewService } from "../../workbench/services/view";
import { Button, Group, useConfirmModal } from "@myoxus/ui-facade";
import {
  createContext,
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  TaskCreationRetention,
  TaskCreationRetentionSlot,
} from "../tasks/use-create-task";

const MAX_NAVIGATION_FRAMES = 32;

/** A deliberate detail-editor opening; unrelated owners consume it as close. */
export type TaskDetailEditorIntent = {
  kind: "create" | "parent" | "blockedBy" | "close";
  sequence: number;
};

export type TaskDetailEditSession = {
  dirty: boolean;
  pending: boolean;
  apply: () => Promise<boolean>;
  discard: () => void;
};

export type TaskDetailNavigation = {
  registerEditor?: (editor: TaskDetailEditSession | null) => void;
  requestLeave?: (next: () => void) => void;
  creationAttempt?: TaskCreationRetentionSlot;
  open: (
    rowId: string,
    controlId: string,
    pageCursors?: string[],
    confirmed?: boolean,
  ) => void;
  back?: () => void;
  focus?: {
    rowId: string;
    controlId: string;
    pageCursors?: string[];
    confirmed?: boolean;
    sequence: number;
  };
};

export const TaskDetailNavigationContext =
  createContext<TaskDetailNavigation | null>(null);

/** Navigation frames retain identities/cursors only. One separate private UI
 * attempt survives internal Open/Back; canonical Tasks are always read again.
 * The outer surface retains its original trigger and route filters/View state. */
export function useTaskDetailNavigation(
  owner: string | null,
  rowId: string | null,
  select: (rowId: string) => void,
) {
  const [state, setState] = useState<{
    owner: string | null;
    frames: {
      rowId: string;
      controlId: string;
      pageCursors?: string[];
      confirmed?: boolean;
    }[];
    focus?: TaskDetailNavigation["focus"];
  }>({ owner, frames: [] });
  const t = useI18n();
  const labels = useRef(t);
  labels.current = t;
  const { openConfirmModal, closeConfirmModal } = useConfirmModal();
  const editor = useRef<TaskDetailEditSession | null>(null);
  const [guarded, setGuarded] = useState(false);
  const editorGeneration = useRef(0);
  const leave = useRef<{
    owner: string | null;
    rowId: string | null;
    generation: number;
    busy: boolean;
  } | null>(null);
  const expected = useRef(rowId);
  const current = useRef({ owner, rowId });
  current.current = { owner, rowId };
  const editOwner = useRef({ owner, rowId });
  if (editOwner.current.owner !== owner || editOwner.current.rowId !== rowId) {
    editOwner.current = { owner, rowId };
    editor.current = null;
    ++editorGeneration.current;
  }
  useEffect(() => {
    if (
      leave.current &&
      (leave.current.owner !== owner || leave.current.rowId !== rowId)
    ) {
      leave.current = null;
      closeConfirmModal();
    }
  }, [owner, rowId, closeConfirmModal]);
  useEffect(
    () => () => {
      editor.current = null;
      ++editorGeneration.current;
      if (leave.current) {
        leave.current = null;
        closeConfirmModal();
      }
    },
    [closeConfirmModal],
  );
  const registerEditor = useCallback(
    (next: TaskDetailEditSession | null) => {
      if (next && !editor.current) ++editorGeneration.current;
      editor.current = next;
      setGuarded(Boolean(next?.dirty || next?.pending));
      if (!next && leave.current && !leave.current.busy) {
        leave.current = null;
        closeConfirmModal();
      }
    },
    [closeConfirmModal],
  );
  const requestLeave = useCallback(
    (next: () => void) => {
      const t = labels.current;
      const active = editor.current;
      if (leave.current || active?.pending) return;
      if (!active?.dirty) {
        next();
        return;
      }
      const attempt = {
        ...current.current,
        generation: editorGeneration.current,
        busy: false,
      };
      leave.current = attempt;
      const isCurrent = () =>
        leave.current === attempt &&
        current.current.owner === attempt.owner &&
        current.current.rowId === attempt.rowId &&
        editorGeneration.current === attempt.generation;
      const finish = () => {
        if (!isCurrent()) return;
        // Unregister before retrying pane history: retry re-enters its blockers.
        editor.current = null;
        setGuarded(false);
        leave.current = null;
        closeConfirmModal();
        next();
      };
      const Actions = () => {
        const [pending, setPending] = useState(false);
        return createElement(
          Group,
          null,
          createElement(
            Button,
            {
              variant: "secondary",
              disabled: pending,
              onClick: () => {
                if (!isCurrent() || attempt.busy) return;
                leave.current = null;
                closeConfirmModal();
              },
            },
            t["com.myoxus.database.task-detail.stay"](),
          ),
          createElement(
            Button,
            {
              variant: "secondary",
              disabled: pending,
              onClick: () => {
                if (!isCurrent() || attempt.busy || editor.current?.pending)
                  return;
                attempt.busy = true;
                editor.current?.discard();
                finish();
              },
            },
            t["com.myoxus.database.task-detail.discard-changes"](),
          ),
          createElement(
            Button,
            {
              loading: pending,
              onClick: async () => {
                if (
                  !isCurrent() ||
                  attempt.busy ||
                  !editor.current ||
                  editor.current.pending
                )
                  return;
                attempt.busy = true;
                setPending(true);
                try {
                  if (await editor.current.apply()) finish();
                } catch {
                  // The native editor retains its draft and presents save failure.
                } finally {
                  attempt.busy = false;
                  if (isCurrent()) setPending(false);
                }
              },
            },
            t.Apply(),
          ),
        );
      };
      openConfirmModal({
        title: t["com.myoxus.database.view.unsaved"](),
        // All dismissal is explicit: a pending native save cannot discard its owner.
        persistent: true,
        withoutCloseButton: true,
        onCancel: false,
        customConfirmButton: () => createElement(Actions),
      });
    },
    [closeConfirmModal, openConfirmModal],
  );
  const view = useServiceOptional(ViewService)?.view;
  const historyLifetime = useRef({ owner, view, alive: true });
  if (
    historyLifetime.current.owner !== owner ||
    historyLifetime.current.view !== view
  ) {
    historyLifetime.current.alive = false;
    historyLifetime.current = { owner, view, alive: true };
  }
  const historySession = historyLifetime.current;
  useEffect(() => {
    historySession.alive = true;
    return () => {
      historySession.alive = false;
    };
  }, [historySession]);
  useEffect(() => {
    // Idle embedded Database consumers must not install competing blockers on
    // the same pane history. Only its active native draft owns a transition.
    if (!view || !guarded) return;
    let installed = true;
    const history = view.history;
    const isCurrentHistory = () =>
      historySession.alive &&
      historyLifetime.current === historySession &&
      current.current.owner === owner;
    let unblock: (() => void) | undefined;
    const install = () => {
      unblock = history.block((transition) => {
        const before = history.location;
        const beforeQuery = new URLSearchParams(before.search);
        const nextQuery = new URLSearchParams(transition.location.search);
        const sameTask =
          before.pathname === transition.location.pathname &&
          beforeQuery.get("rowId") === nextQuery.get("rowId") &&
          beforeQuery.get("databaseId") === nextQuery.get("databaseId");
        const retry = () => {
          if (!isCurrentHistory()) return;
          // retry enters the same history again; release only this blocker.
          unblock?.();
          unblock = undefined;
          try {
            transition.retry();
          } finally {
            if (installed && isCurrentHistory()) install();
          }
        };
        if (sameTask) retry();
        else requestLeave(retry);
      });
    };
    install();
    return () => {
      // A successful save can remove this blocker before its retry runs. The
      // separate pane/owner lifetime still authorizes that same continuation.
      installed = false;
      unblock?.();
    };
  }, [owner, requestLeave, view, guarded, historySession]);
  const sequence = useRef(0);
  const creationAttempt = useRef<TaskCreationRetention | undefined>(undefined);
  const creationOwner = useRef(owner);
  if (creationOwner.current !== owner) {
    creationOwner.current = owner;
    creationAttempt.current = undefined;
  }
  const reset = useCallback(() => {
    expected.current = null;
    creationAttempt.current = undefined;
    setState({ owner, frames: [] });
  }, [owner]);
  useEffect(() => {
    if (!rowId) creationAttempt.current = undefined;
    if (state.owner !== owner || rowId !== expected.current) {
      expected.current = rowId;
      setState({ owner, frames: [] });
    }
  }, [owner, rowId, state.owner]);
  const frames = state.owner === owner ? state.frames : [];
  const navigation: TaskDetailNavigation = {
    creationAttempt,
    registerEditor,
    requestLeave,
    open: (next, controlId, pageCursors, confirmed) => {
      if (
        !owner ||
        !rowId ||
        current.current.owner !== owner ||
        current.current.rowId !== rowId ||
        next === rowId
      )
        return;
      requestLeave(() => {
        expected.current = next;
        setState({
          owner,
          frames: [
            ...frames.slice(-(MAX_NAVIGATION_FRAMES - 1)),
            { rowId, controlId, pageCursors, confirmed },
          ],
        });
        select(next);
      });
    },
    back: frames.length
      ? () => {
          if (
            current.current.owner !== owner ||
            current.current.rowId !== rowId
          )
            return;
          requestLeave(() => {
            const frame = frames[frames.length - 1];
            expected.current = frame.rowId;
            setState({
              owner,
              frames: frames.slice(0, -1),
              focus: { ...frame, sequence: ++sequence.current },
            });
            select(frame.rowId);
          });
        }
      : undefined,
    focus: state.owner === owner ? state.focus : undefined,
  };
  return { navigation, reset };
}
