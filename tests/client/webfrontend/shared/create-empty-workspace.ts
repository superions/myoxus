// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

/** Allocate through the admitted Empty package and register cleanup before checking readiness. */
export async function createEmptyWorkspace(
  gql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>,
  onAllocated: (workspaceId: string) => void,
) {
  type Value = { kind: string; text: string | null; choice: string | null };
  const catalog = await gql<{
    currentUser: {
      assistantPackages: Array<{
        identity: { id: string; version: string; digest: string };
        defaultFor: string[];
        inputs: Array<{
          id: string;
          target: string;
          defaultValue: Value | null;
          choices: Array<{ id: string; value: Value }>;
        }>;
      }>;
    };
  }>(
    `query{currentUser{assistantPackages(context:WorkspaceCreation){identity{id version digest}defaultFor inputs{id target defaultValue{kind text choice}choices{id value{kind text choice}}}}}}`,
  );
  const source = catalog.currentUser.assistantPackages.find((source) =>
    source.defaultFor.includes("WorkspaceCreation"),
  );
  if (!source)
    throw new Error("No admitted default Workspace creation package");
  const answers: Record<string, { kind: string; value: string }> = {};
  for (const input of source.inputs) {
    if (input.target === "WorkspaceName") {
      answers[input.id] = {
        kind: "text",
        value: `Empty first-use ${randomUUID()}`,
      };
    } else if (
      input.target === "InitialContent" ||
      input.target === "AssistanceMode"
    ) {
      const expected = input.target === "InitialContent" ? "empty" : "manual";
      const choice = input.choices.find(
        (choice) => (choice.value.text ?? choice.value.choice) === expected,
      );
      if (!choice) throw new Error(`Package lacks native ${expected} choice`);
      answers[input.id] = { kind: "choice", value: choice.id };
    } else if (input.defaultValue?.kind === "Text") {
      answers[input.id] = { kind: "text", value: input.defaultValue.text! };
    } else if (input.defaultValue?.kind === "Choice") {
      answers[input.id] = { kind: "choice", value: input.defaultValue.choice! };
    }
  }
  const prepared = (
    await gql<{
      currentUser: {
        prepareWorkspaceAssistant: {
          name: string;
          initialContent: string;
          assistanceMode: string;
          planDigest: string;
        };
      };
    }>(
      `query($input:PrepareWorkspaceAssistantInput!){currentUser{prepareWorkspaceAssistant(input:$input){name initialContent assistanceMode planDigest}}}`,
      { input: { identity: source.identity, answers } },
    )
  ).currentUser.prepareWorkspaceAssistant;
  const creationInput = {
    name: prepared.name,
    initialContent: prepared.initialContent,
    assistanceMode: prepared.assistanceMode,
    requestId: randomUUID(),
    assistantConfirmation: {
      identity: source.identity,
      answers,
      planDigest: prepared.planDigest,
    },
  };
  const operation = `mutation($input:CreateWorkspaceInput!){createWorkspace(input:$input){id initialContentPolicy creation{status rootReady tasksReady assistanceSaved}}}`;
  type Result = {
    createWorkspace: {
      id: string;
      initialContentPolicy: string;
      creation: {
        status: string;
        rootReady: boolean;
        tasksReady: boolean;
        assistanceSaved: boolean;
      };
    };
  };
  const created = (await gql<Result>(operation, { input: creationInput }))
    .createWorkspace;
  onAllocated(created.id);
  expect(created.initialContentPolicy).toBe("Empty");
  expect(created.creation).toMatchObject({
    status: "Ready",
    rootReady: true,
    tasksReady: true,
    assistanceSaved: true,
  });
  expect(
    (await gql<Result>(operation, { input: creationInput })).createWorkspace.id,
  ).toBe(created.id);
  return created.id;
}
