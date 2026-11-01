// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseStarterTemplateCategory,
  type ProjectAssistantConfirmationInput,
  type DatabaseStarterTemplateFragment,
  ProjectOptionPreset,
  ProjectStructurePreset,
} from "@myoxus/graphql";

export const TEMPLATE_SEARCH_THRESHOLD = 8;

export type CreationIntent = "database" | "project";
export type CreationAssistantStep = 0 | 1 | 2 | 3;

export function consumeDatabaseCreationIntent(searchParams: URLSearchParams) {
  const intent = searchParams.get("create");
  if (intent !== "database" && intent !== "project") return null;

  const remainingSearchParams = new URLSearchParams(searchParams);
  remainingSearchParams.delete("create");
  const initialStructurePreset =
    intent === "project" &&
    searchParams.get("structurePreset") === ProjectStructurePreset.TasksOnly
      ? ProjectStructurePreset.TasksOnly
      : undefined;
  if (initialStructurePreset) remainingSearchParams.delete("structurePreset");
  return {
    intent,
    initialStructurePreset,
    remainingSearchParams,
  } satisfies {
    intent: CreationIntent;
    initialStructurePreset?: ProjectStructurePreset;
    remainingSearchParams: URLSearchParams;
  };
}

export type CreationAssistantState = {
  step: CreationAssistantStep;
  search: string;
  templateId: string | null;
  title: string;
  description: string;
  folderId: string | null;
  includeSampleRows: boolean;
};

export type CreationAssistantRequest = {
  templateId: string;
  title: string;
  description: string;
  folderId: string | null;
  includeSampleRows: boolean;
  priorityPreset: ProjectOptionPreset;
  complexityPreset: ProjectOptionPreset;
  structurePreset: ProjectStructurePreset;
  assistantConfirmation?: ProjectAssistantConfirmationInput;
};

export function categoryForIntent(intent: CreationIntent) {
  return intent === "project"
    ? DatabaseStarterTemplateCategory.Project
    : DatabaseStarterTemplateCategory.Database;
}

export function createInitialCreationState(
  defaultTitle: string,
): CreationAssistantState {
  return {
    step: 0,
    search: "",
    templateId: null,
    title: defaultTitle,
    description: "",
    folderId: null,
    includeSampleRows: false,
  };
}

export function templatesForIntent(
  templates: readonly DatabaseStarterTemplateFragment[],
  intent: CreationIntent,
) {
  const category = categoryForIntent(intent);
  return templates.filter((template) => template.category === category);
}

export function resolveTemplateSelection(
  templates: readonly DatabaseStarterTemplateFragment[],
  selectedId: string | null,
) {
  if (selectedId && templates.some((template) => template.id === selectedId)) {
    return selectedId;
  }
  return templates[0]?.id ?? null;
}

export function selectedTemplate(
  templates: readonly DatabaseStarterTemplateFragment[],
  selectedId: string | null,
) {
  return templates.find((template) => template.id === selectedId) ?? null;
}

export function validateCreationDetails(state: CreationAssistantState) {
  return {
    titleRequired: state.title.trim().length === 0,
    descriptionRequired: state.description.trim().length === 0,
  };
}

export function buildCreationRequest(
  state: CreationAssistantState,
  template: DatabaseStarterTemplateFragment,
): CreationAssistantRequest {
  return {
    templateId: template.id,
    title: state.title.trim(),
    description: state.description.trim(),
    folderId: state.folderId,
    includeSampleRows: state.includeSampleRows && template.sampleRowCount > 0,
    priorityPreset: template.defaultVariant.priority,
    complexityPreset: template.defaultVariant.complexity,
    structurePreset: template.defaultVariant.structure,
  };
}
