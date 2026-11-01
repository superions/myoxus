// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode, useEffect } from "react";

import { DatabasePresenceIndicator } from "./collaborator-header";
import { useDatabasePresenceContext } from "./context";

export function DatabasePresenceTarget({
  children,
  dragging = false,
  fieldId,
  rowId,
  viewId,
}: {
  children: ReactNode;
  dragging?: boolean;
  fieldId?: string;
  rowId: string;
  viewId: string;
}) {
  const presence = useDatabasePresenceContext();
  const records = presence.collaborators.filter(
    (record) =>
      record.socketId !== presence.localSocketId &&
      record.rowId === rowId &&
      (!fieldId || record.fieldId === fieldId),
  );

  useEffect(() => {
    if (!dragging) return;
    presence.updateFocus({ dragging: true, rowId, viewId });
    return () => presence.updateFocus({ dragging: false, rowId: null, viewId });
  }, [dragging, presence.updateFocus, rowId, viewId]);

  return (
    <DatabasePresenceIndicator
      records={records}
      dragging={records.some((record) => record.dragging)}
      ariaLabel={records.map((record) => record.displayName).join(", ")}
      onFocusCapture={() => presence.updateFocus({ fieldId, rowId, viewId })}
      onBlurCapture={() =>
        presence.updateFocus({ fieldId: null, rowId: null, viewId })
      }
    >
      {children}
    </DatabasePresenceIndicator>
  );
}
