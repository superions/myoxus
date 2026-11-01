// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseProfileKind,
  DatabaseStarterTemplateCategory,
  type DatabaseStarterTemplateFragment,
  DatabaseViewKind,
  ProjectOptionPreset,
  ProjectStructurePreset,
} from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import {
  buildCreationRequest,
  consumeDatabaseCreationIntent,
  createInitialCreationState,
  resolveTemplateSelection,
  templatesForIntent,
  validateCreationDetails,
} from "./model";

const databaseTemplate: DatabaseStarterTemplateFragment = {
  id: "database-template",
  version: "1.0.0",
  digest: "fixture-digest",
  defaultVariant: {
    priority: ProjectOptionPreset.FiveStep,
    complexity: ProjectOptionPreset.ThreeStep,
    structure: ProjectStructurePreset.Milestones,
  },
  selections: [],
  name: "Database",
  nameKey: "database.name",
  description: "Database template",
  descriptionKey: "database.description",
  category: DatabaseStarterTemplateCategory.Database,
  profileKind: DatabaseProfileKind.Generic,
  defaultViewKinds: [DatabaseViewKind.Table],
  sampleRowCount: 0,
  importMappings: [],
};

const projectTemplate: DatabaseStarterTemplateFragment = {
  ...databaseTemplate,
  id: "project-template",
  category: DatabaseStarterTemplateCategory.Project,
  profileKind: DatabaseProfileKind.Project,
  sampleRowCount: 3,
};

describe("Database creation assistant model", () => {
  test("consumes valid command-center intents once without dropping other query state", () => {
    const consumed = consumeDatabaseCreationIntent(
      new URLSearchParams("scope=favorites&create=project"),
    );

    expect(consumed?.intent).toBe("project");
    expect(consumed?.remainingSearchParams.toString()).toBe("scope=favorites");
    expect(
      consumeDatabaseCreationIntent(consumed!.remainingSearchParams),
    ).toBeNull();
    expect(
      consumeDatabaseCreationIntent(new URLSearchParams("create=unknown")),
    ).toBeNull();
  });

  test("filters the injected server catalog by immutable entry intent", () => {
    const catalog = [databaseTemplate, projectTemplate];
    expect(templatesForIntent(catalog, "database")).toEqual([databaseTemplate]);
    expect(templatesForIntent(catalog, "project")).toEqual([projectTemplate]);
    expect(resolveTemplateSelection([databaseTemplate], "missing")).toBe(
      databaseTemplate.id,
    );
    expect(resolveTemplateSelection([], "database-template")).toBeNull();
  });

  test("does not select an offering or synthesize variant defaults before catalog admission", () => {
    expect(createInitialCreationState("Database")).toEqual({
      step: 0,
      search: "",
      templateId: null,
      title: "Database",
      description: "",
      folderId: null,
      includeSampleRows: false,
    });
  });

  test("validates trimmed details and normalizes the mutation payload", () => {
    const state = {
      ...createInitialCreationState("  Release  "),
      templateId: projectTemplate.id,
      description: "  Coordinate launch  ",
      folderId: "folder-1",
      includeSampleRows: true,
    };
    expect(validateCreationDetails(state)).toEqual({
      titleRequired: false,
      descriptionRequired: false,
    });
    expect(buildCreationRequest(state, projectTemplate)).toEqual({
      templateId: projectTemplate.id,
      title: "Release",
      description: "Coordinate launch",
      folderId: "folder-1",
      includeSampleRows: true,
      priorityPreset: ProjectOptionPreset.FiveStep,
      complexityPreset: ProjectOptionPreset.ThreeStep,
      structurePreset: ProjectStructurePreset.Milestones,
    });

    expect(
      buildCreationRequest(
        { ...state, title: " ", description: " ", includeSampleRows: true },
        databaseTemplate,
      ).includeSampleRows,
    ).toBe(false);
    expect(
      validateCreationDetails({ ...state, title: " ", description: " " }),
    ).toEqual({ titleRequired: true, descriptionRequired: true });
  });
});
