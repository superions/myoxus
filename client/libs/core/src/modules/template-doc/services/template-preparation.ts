// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DocsStore } from "../../doc/stores/docs";
import type { DocRecordList } from "../../doc/entities/record-list";
import type { FolderStore } from "../../organize/stores/folder";
import {
  formatRegionalDate,
  formatRegionalTime,
  formatRegionalDateTime,
  type RegionalFormatPreferences,
} from "../../i18n";
import {
  templateDeltaText,
  templateVariableRanges,
  buildTemplateVariables,
  optionalProjectTemplateVariableNames,
  optionalPreparationTemplateVariableNames,
  optionalProjectTemplateVariables,
  optionalPreparationTemplateVariables,
  type TemplateDateInput,
} from "../../doc/services/template-variables";
import {
  expandAndApplyTemplateUnits,
  MEMBER_REPEAT_SOURCE,
  validateTemplateRepeats,
  type TemplateVariables,
  type TemplateVariable,
  type inspectTemplateSnapshot,
} from "../../doc/services/template-repeat";
import {
  TEMPLATE_INPUT_MAX_BYTES,
  type TemplateInputValues,
} from "./template-inputs";
import {
  TemplateInstantiationError,
  waitForTemplateOperation,
} from "./template-instantiation-error";
import type { TemplateCreationContext } from "./template-instantiation";

export interface TemplatePreparationOptions {
  sourceDocId: string;
  targetDocId?: string;
  requested: ReadonlySet<string>;
  repeats: ReturnType<typeof inspectTemplateSnapshot>["repeats"];
  variables: TemplateVariables;
  inputs?: TemplateInputValues;
  creationContext: TemplateCreationContext;
  applicationDate?: TemplateDateInput;
  regionalPreferences: RegionalFormatPreferences;
  signal: AbortSignal;
  deferCreation?: boolean;
}

export interface TemplatePreparationOwner {
  store: Pick<
    DocsStore,
    "templateWorkspaceContext" | "readTemplateValues" | "waitForDocLoadReady"
  >;
  list: DocRecordList;
  folders: () => FolderStore;
}

/** Shared value preparation does not write content, titles, or source attribution.
 * Sections pass their existing target; whole-document creation defers new facts.
 */
export async function prepareTemplateValues(
  options: TemplatePreparationOptions,
  owner: TemplatePreparationOwner,
): Promise<Record<string, TemplateVariable>> {
  const {
    sourceDocId,
    targetDocId,
    requested,
    repeats,
    variables,
    inputs = {},
    creationContext,
    applicationDate,
    regionalPreferences,
    signal,
    deferCreation = true,
  } = options;
  // Optional context scalars are also valid in ordinary Library/local
  // copies. Explicit setup strings win, including intentionally empty ones.
  for (const name of [
    ...optionalProjectTemplateVariableNames,
    ...optionalPreparationTemplateVariableNames,
  ]) {
    if (!Object.hasOwn(variables, name)) continue;
    const value = variables[name];
    if (
      typeof value !== "string" ||
      new TextEncoder().encode(value).length > TEMPLATE_INPUT_MAX_BYTES
    )
      throw new TemplateInstantiationError("invalid-syntax");
  }
  const resolved = {
    ...optionalProjectTemplateVariables(),
    ...optionalPreparationTemplateVariables(),
    ...variables,
    ...inputs,
  };
  const workspace = owner.store.templateWorkspaceContext;
  const parentId = creationContext.parentDocId;
  const parent =
    requested.has("parent_page_title") && parentId
      ? owner.list.doc$(parentId).value
      : undefined;
  if (
    requested.has("parent_page_title") &&
    (!parentId ||
      parentId === sourceDocId ||
      parentId === targetDocId ||
      !parent ||
      parent.trash$.value)
  )
    throw new TemplateInstantiationError("parent-unavailable");
  if (requested.has(MEMBER_REPEAT_SOURCE)) {
    if (
      !workspace.serverBacked ||
      Object.hasOwn(variables, MEMBER_REPEAT_SOURCE)
    )
      throw new TemplateInstantiationError("repeat-invalid");
  }
  const automaticContextKeys = [
    "organization_name",
    "organization_unit_name",
    "parent_page_title",
    "folder_name",
    "actor.name",
    "actor.email",
    "folder.path",
    "calendar.iso_week_year",
  ] as const;
  // Automatic context facts are reserved even when absent from the
  // source. Internal callers cannot shadow the authoritative projection.
  if (
    automaticContextKeys.some((key) =>
      Object.prototype.hasOwnProperty.call(variables, key),
    )
  ) {
    throw new TemplateInstantiationError("invalid-syntax");
  }
  if (requested.has("calendar.iso_week_year")) {
    if (applicationDate === undefined)
      throw new TemplateInstantiationError("metadata-unavailable");
    const calendar = buildTemplateVariables(
      applicationDate,
      regionalPreferences,
    );
    // Both ISO fields describe the same explicit calendar day, including
    // date-only Journal inputs. Caller-authored date text is not a clock.
    resolved.week = calendar.week;
    resolved["calendar.iso_week_year"] = calendar["calendar.iso_week_year"];
  }
  const creationPaths = new Set([
    "creator.name",
    "creator.email",
    "document.created_at.date",
    "document.created_at.time",
    "document.created_at.datetime",
  ]);
  if (workspace.serverBacked) {
    const serverRequested = [...requested].filter(
      (path) => creationPaths.has(path) || !Object.hasOwn(resolved, path),
    );
    Object.assign(
      resolved,
      serverRequested.length
        ? await owner.store.readTemplateValues(
            serverRequested,
            targetDocId,
            creationContext,
            signal,
            deferCreation,
          )
        : {},
    );
    // Member transport/ACL failures retain their own reason. Only invalid
    // repeat data is a repeat error; both precede native body writes.
    validateTemplateRepeats(repeats, resolved);
  }
  if (
    !workspace.serverBacked &&
    (requested.has("folder_name") || requested.has("folder.path"))
  ) {
    try {
      // Resolving this existing store lazily also avoids its ORM hydration
      // subscription for templates that never request placement context.
      const folders = owner.folders();
      await waitForTemplateOperation(
        owner.store.waitForDocLoadReady("db$folders", signal),
        signal,
      );
      const folder = folders.resolveTemplateFolder(
        targetDocId ?? "",
        creationContext.folderId,
        workspace.id,
      );
      if (folder.status !== "resolved") {
        throw new TemplateInstantiationError(
          folder.status === "ambiguous" ? "folder-ambiguous" : "folder-absent",
        );
      }
      if (requested.has("folder_name")) resolved.folder_name = folder.name;
      if (requested.has("folder.path"))
        resolved["folder.path"] = folder.path.join("/");
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof TemplateInstantiationError) throw cause;
      throw new TemplateInstantiationError("folder-absent", { cause });
    }
  }
  if (requested.has("parent_page_title")) {
    if (!parent || parent.trash$.value) {
      throw new TemplateInstantiationError("parent-unavailable");
    }
    try {
      // The store revalidates server metadata access; membership in the
      // local document list alone is not a grant to read a cloud parent.
      const parentTitle = workspace.serverBacked
        ? resolved.parent_page_title
        : parent.title$.value;
      if (typeof parentTitle !== "string")
        throw new TemplateInstantiationError("parent-unavailable");
      if (parent.trash$.value || !parentTitle?.trim())
        throw new TemplateInstantiationError("parent-unavailable");
      resolved.parent_page_title = parentTitle.trim();
    } catch (cause) {
      signal.throwIfAborted();
      throw new TemplateInstantiationError("parent-unavailable", { cause });
    }
  }
  const organization = requested.has("organization_name");
  const ownerUnit = requested.has("organization_unit_name");
  if (!workspace.serverBacked && (organization || ownerUnit))
    throw new TemplateInstantiationError(
      organization ? "organization-unavailable" : "owner-unit-unavailable",
    );
  for (const path of requested) {
    if (path === "actor.name" || path === "actor.email") {
      if (!workspace.serverBacked)
        throw new TemplateInstantiationError("local-only-incompatible");
      const actor = resolved[path];
      if (typeof actor !== "string")
        throw new TemplateInstantiationError("metadata-unavailable");
      if (!actor.trim()) throw new TemplateInstantiationError("empty-field");
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(resolved, path)) continue;
    if (path === "workspace.name") {
      if (!workspace.name?.trim())
        throw new TemplateInstantiationError("workspace-unavailable");
      resolved[path] = workspace.name.trim();
    } else if (
      [
        "creator.name",
        "creator.email",
        "document.created_at.date",
        "document.created_at.time",
        "document.created_at.datetime",
      ].includes(path)
    ) {
      if (!workspace.serverBacked)
        throw new TemplateInstantiationError("local-only-incompatible");
    } else {
      throw new TemplateInstantiationError("unresolved-variable");
    }
  }

  if (!deferCreation) {
    Object.assign(
      resolved,
      formatTemplateCreationValues(
        requested,
        Object.fromEntries(
          Object.entries(resolved).filter(([path]) => isCreationValue(path)),
        ),
        regionalPreferences,
      ),
    );
  }
  return resolved;
}

const isCreationValue = (path: string) =>
  path === "creator.name" ||
  path === "creator.email" ||
  path.startsWith("document.created_at.");

/** Creation timestamps retain the existing locale formatting for both consumers. */
export function formatTemplateCreationValues(
  requested: ReadonlySet<string>,
  values: TemplateVariables,
  preferences: RegionalFormatPreferences,
): Record<string, string> {
  const needsTime = [...requested].some((path) =>
    path.startsWith("document.created_at."),
  );
  const result: Record<string, string> = {};
  for (const [path, value] of Object.entries(values)) {
    if (typeof value !== "string")
      throw new TemplateInstantiationError("empty-field");
    result[path] = value;
  }
  for (const path of requested) {
    if (
      (path === "creator.name" ||
        path === "creator.email" ||
        path.startsWith("document.created_at.")) &&
      !result[path]
    )
      throw new TemplateInstantiationError(
        path.startsWith("creator.")
          ? "creator-unavailable"
          : "creation-time-unavailable",
      );
  }
  if (needsTime) {
    if (
      Object.entries(result).some(
        ([path, value]) =>
          path.startsWith("document.created_at.") &&
          Number.isNaN(new Date(value).getTime()),
      )
    )
      throw new TemplateInstantiationError("creation-time-unavailable");
    for (const [path, format] of [
      ["document.created_at.date", formatRegionalDate],
      ["document.created_at.time", formatRegionalTime],
      ["document.created_at.datetime", formatRegionalDateTime],
    ] as const)
      if (requested.has(path)) result[path] = format(result[path], preferences);
  }
  return result;
}

/** Apply existing scalar/repeat semantics to a native Store. Section insertion
 * calls this only on its detached preparation Store, never on the target body.
 */
export function applyNativeTemplateValues(
  doc: import("@virgultum/editor/store").Store,
  variables: TemplateVariables,
): string[] {
  const unresolved = new Set<string>();

  const apply = (text: unknown, values: Readonly<Record<string, string>>) => {
    const value = text as
      | {
          toString: () => string;
          replace: (
            index: number,
            length: number,
            value: string,
            attributes?: Record<string, unknown>,
          ) => void;
          toDelta: () => {
            insert?: unknown;
            attributes?: Record<string, unknown>;
          }[];
          length: number;
        }
      | undefined;
    if (
      !value ||
      typeof value.toString !== "function" ||
      typeof value.toDelta !== "function" ||
      typeof value.replace !== "function"
    )
      return;
    const deltas = value.toDelta();
    const before = templateDeltaText(deltas);
    for (const range of templateVariableRanges(before).reverse()) {
      if (!Object.prototype.hasOwnProperty.call(values, range.name)) {
        unresolved.add(range.name);
        continue;
      }
      let offset = 0;
      let attributes: Record<string, unknown> = {};
      for (const delta of deltas) {
        offset += typeof delta.insert === "string" ? delta.insert.length : 1;
        if (offset > range.start) {
          attributes = delta.attributes ?? {};
          break;
        }
      }
      value.replace(range.start, range.length, values[range.name], attributes);
    }
  };

  // Keep the existing guarded write/compensation boundary. Store block models
  // become available only after their native creation transaction finishes;
  // an outer Y.Doc transaction would hide freshly added blocks from expansion.
  expandAndApplyTemplateUnits(doc, variables, apply);

  return [...unresolved].sort();
}
