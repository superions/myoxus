// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  assistantPackagesQuery,
  assistantPresentationQuery,
  AssistantCellPresence,
  AssistantControlKind,
  AssistantFolderDestinationKind,
  AssistantNativeActionKind,
  AssistantValueType,
  AssistantContext,
  AssistantInputTarget,
  AssistantProjectScaffoldKind,
  ProjectOptionPreset,
  ProjectStructurePreset,
  DatabaseViewKind,
  type PrepareProjectAssistantInput,
  type PrepareProjectAssistantQuery,
  type AssistantPackageFragmentFragment,
  type AssistantValueFragmentFragment,
  type AssistantPresentationQuery,
} from "@myoxus/graphql";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";
import {
  assistantValue,
  visibleAssistantAnswers,
  resolvedAssistantValue,
} from "./values";

const root = join(process.cwd(), "server/templates/assistants");
const authoredPackages = new Map<string, Record<string, unknown>>();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected fixture object");
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected fixture array");
  return value;
}
const pascal = (value: unknown) =>
  typeof value === "string" ? value[0].toUpperCase() + value.slice(1) : value;
function value(source: unknown): AssistantValueFragmentFragment | null {
  if (source == null) return null;
  const raw = object(source);
  const kind = Object.values(AssistantValueType).find(
    (kind) => kind === pascal(raw.kind),
  );
  if (!kind) throw new Error("Unknown native fixture value kind");
  const payload =
    kind === AssistantValueType.Document
      ? "documentId"
      : kind === AssistantValueType.Members
        ? "memberIds"
        : kind === AssistantValueType.DatabaseDestination
          ? "databaseId"
          : kind === AssistantValueType.RowTemplate
            ? "rowTemplateId"
            : kind === AssistantValueType.Row
              ? "rowId"
              : kind === AssistantValueType.Folder
                ? "folder"
                : kind[0].toLowerCase() + kind.slice(1);
  if (kind === AssistantValueType.Folder) {
    const folder = object(raw.value);
    return assistantValue(kind, {
      folder: {
        kind:
          folder.kind === "existing"
            ? AssistantFolderDestinationKind.Existing
            : AssistantFolderDestinationKind.New,
        id: typeof folder.id === "string" ? folder.id : null,
        name: typeof folder.name === "string" ? folder.name : null,
        parent: typeof folder.parent === "string" ? folder.parent : null,
      },
    });
  }
  return assistantValue(kind, { [payload]: raw.value });
}
function bindingValue(source: unknown) {
  const binding = object(source);
  return {
    input: null,
    component: null,
    ...binding,
    kind: pascal(binding.kind),
    context: binding.kind === "context" ? pascal(binding.value) : null,
    result: binding.kind === "result" ? pascal(binding.value) : null,
  };
}
function condition(source: unknown) {
  if (source == null) return null;
  const raw = object(source);
  return { ...raw, kind: pascal(raw.kind), value: value(raw.value) };
}
function control(source: unknown) {
  const raw = object(source);
  return {
    input: null,
    offsetsMinutes: null,
    defaultOffsetMinutes: null,
    allowCustomOffset: null,
    search: null,
    ...raw,
    kind: pascal(raw.kind),
    control: pascal(raw.control) ?? null,
    presence: pascal(raw.presence) ?? null,
    value: pascal(raw.value) ?? null,
    filter: pascal(raw.filter) ?? null,
    binding: raw.binding
      ? {
          roleKey: null,
          fieldKey: null,
          ...object(raw.binding),
          kind: pascal(object(raw.binding).kind),
        }
      : null,
  };
}
function step(source: unknown) {
  const raw = object(source);
  return {
    ...raw,
    groups: list(raw.groups).map((source) => {
      const group = object(source);
      return {
        ...group,
        role: pascal(group.role),
        visibleWhen: condition(group.visibleWhen),
        controls: list(group.controls).map(control),
      };
    }),
    actions: list(raw.actions).map((source) => {
      const action = object(source);
      return {
        label: null,
        ...action,
        action: pascal(action.action),
        visibleWhen: condition(action.visibleWhen),
      };
    }),
  };
}

/** Test-only projection of the shipped immutable source. It deliberately reads
 * authored ordering/defaults/copy rather than maintaining another Task schema.
 * Native admission and resolution are tested by the server's source journeys. */
export function assistantPackagesFixture(
  context: AssistantContext,
  versions: Readonly<Record<string, string>> = {},
): AssistantPackageFragmentFragment[] {
  const catalog = object(
    parse(readFileSync(join(root, "catalog.yaml"), "utf8")),
  );
  return list(catalog.packages).flatMap((entry) => {
    const item = object(entry);
    const definition = list(item.definitions)
      .map(object)
      .find((definition) => definition.version === item.current);
    if (!definition) throw new Error("Missing immutable fixture definition");
    const version = versions[String(item.id)];
    const bytes = readFileSync(
      join(
        root,
        version ? `${item.id}/${version}.yaml` : String(definition.path),
      ),
    );
    const raw = object(parse(bytes.toString("utf8")));
    if (raw.id !== item.id || raw.version !== (version ?? item.current))
      throw new Error("Native fixture source identity mismatch");
    if (!list(raw.contexts).some((value) => pascal(value) === context))
      return [];
    authoredPackages.set(`${raw.id}@${raw.version}`, raw);
    const presentation = object(raw.presentation);
    // YAML values remain unknown at this test-only projection boundary; native
    // server admission, rather than a second TypeScript source decoder, owns validation.
    const descriptor: unknown = {
      artwork: [],
      documentSources: [],
      documentComponents: [],
      identity: {
        id: raw.id,
        version: raw.version,
        digest: createHash("sha256").update(bytes).digest("hex"),
      },
      name: raw.name,
      description: raw.description,
      contexts: list(raw.contexts).map(pascal),
      defaultFor: list(item.defaultFor).map(pascal),
      inputs: list(raw.inputs).map((source) => {
        const input = object(source);
        return {
          ...input,
          target: pascal(input.target),
          valueType: pascal(input.valueType),
          defaultValue: value(input.default),
          choices: list(input.choices).map((source) => {
            const choice = object(source);
            return { ...choice, value: value(choice.value) };
          }),
          visibleWhen: condition(input.visibleWhen),
        };
      }),
      components: list(raw.components).map((source) => {
        const component = object(source);
        const action = object(component.action);
        return {
          ...component,
          action: {
            ...action,
            kind: pascal(action.kind),
            templateId: action.templateId ?? null,
            selected: action.selected ? bindingValue(action.selected) : null,
            folder: action.folder ? bindingValue(action.folder) : null,
            variables: Object.entries(object(action.variables ?? {})).map(
              ([name, binding]) => ({ name, binding: bindingValue(binding) }),
            ),
            inputs: Object.entries(object(action.inputs ?? {})).map(
              ([target, source]) => {
                const binding = object(source);
                return {
                  target: pascal(target),
                  binding: {
                    input: null,
                    component: null,
                    ...binding,
                    kind: pascal(binding.kind),
                    context:
                      binding.kind === "context" ? pascal(binding.value) : null,
                    result:
                      binding.kind === "result" ? pascal(binding.value) : null,
                  },
                };
              },
            ),
          },
        };
      }),
      presentation: {
        steps: list(presentation.steps).map(step),
        dialogs: list(presentation.dialogs).map(step),
      },
    };
    // This source-to-transport bridge is confined to tests. The real server DTO
    // remains the production boundary; no client accepts raw YAML at runtime.
    return [descriptor as AssistantPackageFragmentFragment];
  });
}

type Projection = NonNullable<
  NonNullable<AssistantPresentationQuery["workspace"]>["assistantPresentation"]
>;
export function assistantPresentationFixture(
  context: AssistantContext,
  record: DatabaseRecord,
  row?: DatabaseRowRecord,
): Projection {
  const descriptor = structuredClone(
    assistantPackagesFixture(context).find((item) =>
      item.defaultFor.includes(context),
    ),
  );
  if (!descriptor) throw new Error("Missing native fixture default");
  const fields: Projection["fields"] = [];
  for (const group of [
    ...descriptor.presentation.steps,
    ...descriptor.presentation.dialogs,
  ].flatMap((step) => step.groups)) {
    group.controls = group.controls.filter((control) => {
      if (control.kind !== AssistantControlKind.NativeCell) return true;
      const binding = record.managedSchema?.taskBindings.find(
        (binding) => binding.roleKey === control.binding?.roleKey,
      );
      const field = record.fields.find(
        (field) => field.id === binding?.fieldId,
      );
      if (!field || !control.binding) return false;
      if (!fields.some((candidate) => candidate.fieldId === field.id))
        fields.push({
          binding: control.binding,
          fieldId: field.id,
          name: field.name,
          fieldType: field.fieldType,
          required: field.required,
          config: field.config,
        });
      const present = row?.cells.some((cell) => cell.fieldId === field.id);
      return control.presence === AssistantCellPresence.Present
        ? present
        : control.presence === AssistantCellPresence.Empty
          ? !present
          : true;
    });
  }
  return {
    descriptor,
    databaseId: record.database.id,
    rowId: row?.row.id ?? null,
    unavailableReason: null,
    managedSchema: record.managedSchema,
    fields,
  };
}

export function assistantQueryFixture(
  query: unknown,
  variables: {
    context?: AssistantContext;
    databaseId?: string;
    rowId?: string;
  },
  record: DatabaseRecord,
  row?: DatabaseRowRecord,
) {
  if (query === assistantPackagesQuery && variables.context)
    return {
      workspace: {
        id: record.database.workspaceId,
        assistantPackages: assistantPackagesFixture(variables.context),
      },
    };
  if (query === assistantPresentationQuery && variables.context)
    return {
      workspace: {
        id: record.database.workspaceId,
        assistantPresentation: assistantPresentationFixture(
          variables.context,
          record,
          row,
        ),
      },
    };
  return undefined;
}

/** Readonly API fixture for component state/fence tests. It supplies a canonical
 * plan token; native validation/materialization belongs to server journeys. */
export function preparedProjectFixture(
  input: PrepareProjectAssistantInput,
  defaultCurrency = "EUR",
  packages = assistantPackagesFixture(AssistantContext.ProjectCreation),
): NonNullable<
  PrepareProjectAssistantQuery["workspace"]
>["prepareProjectAssistant"] {
  const descriptor = packages.find(
    (item) => item.identity.id === input.identity.id,
  );
  if (!descriptor) throw new Error("Unknown fixture package");
  const supplied = Object.fromEntries(
    Object.entries(object(input.answers)).map(([key, raw]) => [
      key,
      value(raw)!,
    ]),
  );
  const answers = visibleAssistantAnswers(descriptor, supplied, true);
  const bound = (target: AssistantInputTarget) => {
    const input = descriptor.inputs.find((input) => input.target === target);
    return input ? resolvedAssistantValue(input, answers) : undefined;
  };
  const scalar = (target: AssistantInputTarget) =>
    bound(target)?.choice ?? bound(target)?.text;
  const native = <T extends string>(
    values: readonly T[],
    target: AssistantInputTarget,
  ) => {
    const result = values.find(
      (value) =>
        value.toLowerCase() ===
        scalar(target)?.replaceAll("_", "").toLowerCase(),
    );
    if (!result) throw new Error("Missing native fixture enum");
    return result;
  };
  const nativeAction = descriptor.components[0].action;
  if (
    nativeAction.kind !== AssistantNativeActionKind.CreateProject ||
    nativeAction.templateId === null
  )
    throw new Error("Invalid Project fixture native action");
  const structure = native(
    Object.values(ProjectStructurePreset),
    AssistantInputTarget.StructurePreset,
  );
  const authored = authoredPackages.get(
    `${descriptor.identity.id}@${descriptor.identity.version}`,
  );
  const authoredAction = authored
    ? object(
        list(authored.components)
          .map(object)
          .find(
            (component) => object(component.action).kind === "createProject",
          )?.action,
      )
    : null;
  const scaffold =
    bound(AssistantInputTarget.IncludeScaffold)?.boolean &&
    authoredAction?.scaffold
      ? list(authoredAction.scaffold)
          .map(object)
          .filter((entry) =>
            entry.kind === "phase"
              ? structure === ProjectStructurePreset.Phases ||
                structure === ProjectStructurePreset.PhasesAndMilestones
              : structure === ProjectStructurePreset.Milestones ||
                structure === ProjectStructurePreset.PhasesAndMilestones,
          )
          .map((entry) => ({
            id: String(entry.id),
            kind:
              entry.kind === "phase"
                ? AssistantProjectScaffoldKind.Phase
                : AssistantProjectScaffoldKind.Milestone,
            title: {
              en: String(object(entry.title).en),
              de: String(object(entry.title).de),
              fr: String(object(entry.title).fr),
              es: String(object(entry.title).es),
            },
          }))
      : [];
  const setup = {
    goal: bound(AssistantInputTarget.Goal)?.text?.trim() || null,
    scope: bound(AssistantInputTarget.Scope)?.text?.trim() || null,
    startDate: bound(AssistantInputTarget.StartDate)?.date ?? null,
    endDate: bound(AssistantInputTarget.EndDate)?.date ?? null,
    people: bound(AssistantInputTarget.People)?.memberIds ?? [],
    scaffold,
  };
  let sampleRows = 0;
  if (bound(AssistantInputTarget.IncludeSamples)?.boolean) {
    const databaseRoot = join(root, "../databases");
    const databaseCatalog = object(
      parse(readFileSync(join(databaseRoot, "catalog.yaml"), "utf8")),
    );
    const entry = list(databaseCatalog.templates)
      .map(object)
      .find((entry) => entry.id === nativeAction.templateId);
    if (!entry) throw new Error("Missing native fixture Database source");
    const definition = list(entry.definitions)
      .map(object)
      .find((definition) => definition.version === entry.current);
    if (!definition)
      throw new Error("Missing current fixture Database definition");
    const source = object(
      parse(readFileSync(join(databaseRoot, String(definition.path)), "utf8")),
    );
    const variants = list(source.variants).map(object);
    const normalize = (value: unknown) =>
      String(value).replaceAll("_", "").toLowerCase();
    const variant =
      variants.length === 1
        ? variants[0]
        : variants.find(
            (variant) =>
              normalize(variant.structure) === normalize(structure) &&
              normalize(variant.priority) ===
                normalize(
                  native(
                    Object.values(ProjectOptionPreset),
                    AssistantInputTarget.PriorityPreset,
                  ),
                ) &&
              normalize(variant.complexity) ===
                normalize(
                  native(
                    Object.values(ProjectOptionPreset),
                    AssistantInputTarget.ComplexityPreset,
                  ),
                ),
          );
    if (!variant) throw new Error("Missing native fixture Database variant");
    sampleRows = list(object(variant.spec).sample_rows).length;
  }
  return {
    setup,
    counts: {
      phases: scaffold.filter(
        (entry) => entry.kind === AssistantProjectScaffoldKind.Phase,
      ).length,
      milestones: scaffold.filter(
        (entry) => entry.kind === AssistantProjectScaffoldKind.Milestone,
      ).length,
      sampleRows,
      explicitTasks: 0,
    },
    executionAvailable:
      !setup.goal &&
      !setup.scope &&
      !setup.startDate &&
      !setup.endDate &&
      !setup.people.length &&
      !scaffold.length,
    package: descriptor.identity,
    planDigest: "fixture-canonical-plan",
    templateId: nativeAction.templateId,
    templateVersion: "1.0.0",
    templateDigest: "fixture-native-template",
    answers: Object.entries(answers).map(([input, value]) => ({
      input,
      value,
    })),
    title: bound(AssistantInputTarget.Title)?.text ?? "",
    description: bound(AssistantInputTarget.Description)?.text ?? null,
    priority: native(
      Object.values(ProjectOptionPreset),
      AssistantInputTarget.PriorityPreset,
    ),
    complexity: native(
      Object.values(ProjectOptionPreset),
      AssistantInputTarget.ComplexityPreset,
    ),
    structure,
    defaultCurrency:
      scalar(AssistantInputTarget.DefaultCurrency) || defaultCurrency,
    includeSampleRows:
      bound(AssistantInputTarget.IncludeSamples)?.boolean ?? false,
    initialViewKey: scalar(AssistantInputTarget.InitialView) ?? "table",
    initialViewKind: native(
      Object.values(DatabaseViewKind),
      AssistantInputTarget.InitialView,
    ),
    folder: bound(AssistantInputTarget.Folder)?.folder ?? null,
    documentMetadata: [],
    documents: [],
    locale: input.locale ?? "en",
    clientVersion: input.clientVersion ?? null,
  };
}
