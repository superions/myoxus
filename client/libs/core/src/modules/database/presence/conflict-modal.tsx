// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29B-D: stale-write conflict modal.
//
// Triggered by the GraphQL `latestState` extension returned with
// `MIX_DATABASE_{CELL,ROW,FIELD,VIEW,BULK}_CONFLICT` errors
// (see `server/crates/application/src/database/mod.rs`).
//
// The modal renders a focused diff between the local user's last
// known value and the server-side "latest" snapshot, then offers two
// recovery paths:
//   * "Reload latest" — discards the local edit and renders the
//     server's value (preferred when the user trusts the latest
//     committed change);
//   * "Overwrite with my value" — for force-capable mutations, retries with
//     `force = true` so the server overwrites the latest
//     (preferred when the local edit is the intended one).
//
// The component is pure presentational; the host owns the
// `onReloadLatest` / `onOverwriteLocal` handlers and is responsible
// for re-running the failed mutation once the user picks a path.

import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Group,
  Modal,
  MyoxusText,
  Stack,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";

import {
  type DatabaseConflictLatestState,
  parseDatabaseConflictLatestState,
} from "./types";

export interface DatabaseConflictModalProps {
  opened: boolean;
  recovering?: boolean;
  onClose: () => void;
  /**
   * The `latestState` extension string from the conflict GraphQL
   * error. Pass `null` to render the generic "stale write detected"
   * fallback (used when the server hands back a malformed payload).
   */
  latestStateJson: string | null;
  /** Canonical consuming-action readback for revision-only bulk conflicts. */
  serverValue?: string | null;
  /**
   * Stable error code for the failing mutation
   * (e.g. `MIX_DATABASE_CELL_CONFLICT`). Rendered in the modal title.
   */
  errorCode: string;
  /** Short human-readable hint describing what the user tried to do. */
  attemptedAction: string;
  /**
   * The local value the user was about to commit (shown in the
   * "Overwrite with my value" column).
   */
  localValue: unknown;
  onReloadLatest: () => void;
  /** Omit for atomic mutations whose server contract forbids forced retries. */
  onOverwriteLocal?: (() => void) | null;
}

function formatConflictValue(value: unknown, emptyLabel: string): string {
  if (value === null || value === undefined || value === "") return emptyLabel;
  if (typeof value === "string") return value;
  const rendered =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!rendered) return emptyLabel;
  return rendered.length > 64 ? `${rendered.slice(0, 64)}…` : rendered;
}

function formatLatestValue(
  state: DatabaseConflictLatestState,
  emptyLabel: string,
  unknownLabel: string,
): string {
  if (state.kind === "cell") {
    return formatConflictValue(state.displayValue ?? state.value, emptyLabel);
  }
  if (state.kind === "rowTemplate") {
    // Native field UUIDs otherwise consume the entire bounded preview before
    // the changed content is visible. The conflict payload remains untouched.
    const values = state.initialCellValues;
    return formatConflictValue(
      values && typeof values === "object" && !Array.isArray(values)
        ? Object.values(values)
        : (values ?? state.name),
      emptyLabel,
    );
  }
  if (state.kind === "row") {
    return state.title ?? emptyLabel;
  }
  if (state.kind === "field") {
    return state.name ?? emptyLabel;
  }
  if (state.kind === "view") {
    return state.name ?? emptyLabel;
  }
  if (state.kind === "database") {
    return state.title ?? emptyLabel;
  }
  if (state.kind === "bulk") {
    const titles = state.conflicts?.flatMap((conflict) =>
      conflict &&
      typeof conflict === "object" &&
      "title" in conflict &&
      typeof conflict.title === "string"
        ? [conflict.title]
        : [],
    );
    // Cell-bulk errors contain target identities/revisions, not current values.
    // Never present that transport metadata as the latest server value.
    return titles?.length ? titles.join("\n") : unknownLabel;
  }
  return formatConflictValue(
    state.kind === "field_order" ? state.fields : state.views,
    emptyLabel,
  );
}

/**
 * Conflict modal. Mounted once per active database view; the host
 * toggles `opened` whenever a `MIX_DATABASE_*_CONFLICT` error is
 * caught from the GraphQL layer.
 */
export function DatabaseConflictModal({
  opened,
  recovering = false,
  onClose,
  latestStateJson,
  serverValue,
  errorCode,
  attemptedAction,
  localValue,
  onReloadLatest,
  onOverwriteLocal,
}: DatabaseConflictModalProps) {
  const t = useI18n();
  const parsed = parseDatabaseConflictLatestState(latestStateJson);
  const emptyLabel = t["com.myoxus.database.conflict.empty"]();
  return (
    <Modal
      stackId="database-conflict"
      open={opened}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title={t["com.myoxus.database.conflict.title"]()}
      contentOptions={{ "data-testid": "database-conflict-modal" }}
    >
      <Stack gap="md">
        <MyoxusText tone="secondary">
          {t["com.myoxus.database.conflict.description"]()}
        </MyoxusText>
        <Stack gap="xs">
          <MyoxusText typographySlot="body-small" tone="secondary">
            {t["com.myoxus.database.conflict.attempted"]()}
          </MyoxusText>
          <MyoxusText>{attemptedAction}</MyoxusText>
        </Stack>
        <SurfaceList
          label={t["com.myoxus.database.conflict.title"]()}
          data-conflict-code={errorCode}
        >
          <SurfaceListItem
            appearance="card"
            layout="column"
            data-myoxus-database-conflict-modal-side="latest"
          >
            <SurfaceListItemMain>
              <SurfaceListText kind="description">
                {t["com.myoxus.database.conflict.server-value"]()}
              </SurfaceListText>
              <SurfaceListText
                kind="title"
                truncate={false}
                preserveWhitespace
                data-testid="database-conflict-latest"
              >
                {serverValue !== undefined
                  ? (serverValue ?? t["com.myoxus.database.conflict.unknown"]())
                  : parsed
                    ? formatLatestValue(
                        parsed,
                        emptyLabel,
                        t["com.myoxus.database.conflict.unknown"](),
                      )
                    : t["com.myoxus.database.conflict.unknown"]()}
              </SurfaceListText>
            </SurfaceListItemMain>
          </SurfaceListItem>
          <SurfaceListItem
            appearance="card"
            layout="column"
            data-myoxus-database-conflict-modal-side="local"
          >
            <SurfaceListItemMain>
              <SurfaceListText kind="description">
                {t["com.myoxus.database.conflict.local-value"]()}
              </SurfaceListText>
              <SurfaceListText
                kind="title"
                truncate={false}
                preserveWhitespace
                data-testid="database-conflict-local"
              >
                {formatConflictValue(localValue, emptyLabel)}
              </SurfaceListText>
            </SurfaceListItemMain>
          </SurfaceListItem>
        </SurfaceList>
        <Group gap="sm" justify="end">
          <Button
            variant="secondary"
            disabled={recovering}
            onClick={onReloadLatest}
            data-myoxus-database-conflict-modal-action="reload"
          >
            {t["com.myoxus.database.conflict.reload"]()}
          </Button>
          {onOverwriteLocal ? (
            <Button
              variant="primary"
              loading={recovering}
              onClick={onOverwriteLocal}
              data-myoxus-database-conflict-modal-action="overwrite"
            >
              {t["com.myoxus.database.conflict.overwrite"]()}
            </Button>
          ) : null}
        </Group>
      </Stack>
    </Modal>
  );
}
