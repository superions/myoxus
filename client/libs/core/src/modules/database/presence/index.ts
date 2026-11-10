// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29B-D: Database collaboration surface entry point.
//
// Re-exports the service, hook, components, and helpers so host code
// (Table, Kanban, List, Gallery, Calendar, Timeline) only needs a
// single import path:
//
//     import {
//       useDatabasePresence,
//       DatabasePresenceIndicator,
//       DatabasePresenceDot,
//       DatabaseConflictModal,
//       DATABASE_CONFLICT_ERROR_CODES,
//       type DatabasePresenceRecord,
//       type DatabaseConflictErrorCode,
//     } from "@myoxus/core/modules/database/presence";

export {
  DatabasePresenceDot,
  DatabasePresenceIndicator,
  type DatabasePresenceIndicatorProps,
} from "./collaborator-header";
export {
  type DatabaseConflictAttempt,
  type DatabaseConflictController,
  type DatabaseConflictDetails,
  databaseConflictDetails,
  DatabaseConflictProvider,
  useDatabaseConflictController,
} from "./conflict-controller";
export {
  DatabaseConflictModal,
  type DatabaseConflictModalProps,
} from "./conflict-modal";
export {
  DatabasePresenceProvider,
  useDatabasePresenceContext,
} from "./context";
export { DatabasePresenceTarget } from "./database-presence-target";
export {
  executeNonForceableRevisionMutation,
  executeRevisionMutation,
} from "./execute-revision-mutation";
export {
  changeEventAffectsLocalTarget,
  type DatabaseChangeEventPayload,
  type DatabaseInteractionMode,
  type DatabasePresenceJoinAck,
  type DatabasePresenceRecord,
  DatabasePresenceService,
  type DatabasePresenceServiceOptions,
  type DatabasePresenceUpdate,
  type DatabasePresenceUpdateInput,
  deriveInteractionMode,
} from "./service";
export {
  DATABASE_CONFLICT_ERROR_CODES,
  type DatabaseConflictErrorCode,
  type DatabaseConflictLatestState,
  type DatabaseConflictLatestStateCell,
  type DatabaseConflictLatestStateField,
  type DatabaseConflictLatestStateRow,
  type DatabaseConflictLatestStateView,
  draggingUserIds,
  focusedFieldIds,
  focusedRowIds,
  parseDatabaseConflictLatestState,
} from "./types";
export {
  useDatabasePresence,
  type UseDatabasePresenceOptions,
  type UseDatabasePresenceResult,
} from "./use-database-presence";
export { useDatabaseSocket } from "./use-database-socket";
