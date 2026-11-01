// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AssistanceMode,
  AssistantContext,
  AssistantInputTarget,
  WorkspaceInitialContent,
} from "@myoxus/graphql";
import { MemoryMemento } from "@myoxus/infra";
import { expect, test } from "vitest";
import { assistantPackagesFixture } from "@myoxus/core/modules/database/presentation/test-fixtures";
import { resolvedAssistantValue } from "@myoxus/core/modules/database/presentation/values";
import {
  readWorkspaceCreationAttempt,
  saveWorkspaceCreationAttempt,
  workspaceCreationAttemptKey,
  workspaceInitialAnswers,
  type WorkspaceCreationAttempt,
} from "./model";

const descriptor = () =>
  structuredClone(
    assistantPackagesFixture(AssistantContext.WorkspaceCreation)[0],
  );
test("native explicit Manual wins over an authored Guided default without assuming choice IDs", () => {
  const source = descriptor();
  const input = source.inputs.find(
    (input) => input.target === AssistantInputTarget.AssistanceMode,
  )!;
  const guided = input.choices.find(
    (choice) => choice.value.choice === "guided",
  )!;
  const manual = input.choices.find(
    (choice) => choice.value.choice === "manual",
  )!;
  manual.id = "author-choice-a";
  input.defaultValue = { ...guided.value, choice: guided.id };
  const answers = workspaceInitialAnswers(
    source,
    "A workspace",
    AssistanceMode.Manual,
  );
  expect(answers[input.id].choice).toBe("author-choice-a");
  expect(resolvedAssistantValue(input, answers)?.choice).toBe("manual");
});

test("one exact accepted request survives a fresh owner-scoped read and cannot leak to another actor/server", async () => {
  const state = new MemoryMemento();
  const key = workspaceCreationAttemptKey("server-a", "actor-a");
  const attempt: WorkspaceCreationAttempt = {
    input: {
      name: "Original name",
      initialContent: WorkspaceInitialContent.Empty,
      assistanceMode: AssistanceMode.Manual,
      requestId: "11111111-1111-4111-8111-111111111111",
      assistantConfirmation: {
        identity: descriptor().identity,
        answers: {},
        planDigest: "canonical-plan",
      },
    },
  };
  await saveWorkspaceCreationAttempt(state, key, attempt);
  expect(await readWorkspaceCreationAttempt(state, key)).toEqual(attempt);
  expect(
    await readWorkspaceCreationAttempt(
      state,
      workspaceCreationAttemptKey("server-b", "actor-a"),
    ),
  ).toBeUndefined();
  expect(
    await readWorkspaceCreationAttempt(
      state,
      workspaceCreationAttemptKey("server-a", "actor-b"),
    ),
  ).toBeUndefined();
});

test("obsolete optional setup drafts are discarded locally and cannot replace a direct Empty request", async () => {
  const state = new MemoryMemento();
  const key = workspaceCreationAttemptKey("server", "actor");
  const input = {
    name: "Workspace",
    initialContent: WorkspaceInitialContent.Empty,
    assistanceMode: AssistanceMode.Manual,
    requestId: "11111111-1111-4111-8111-111111111111",
    assistantConfirmation: {
      identity: descriptor().identity,
      answers: {},
      planDigest: "plan",
    },
  };
  const composition = {
    package: descriptor().identity,
    answers: {},
    locale: "fr",
    clientVersion: 1,
  };
  for (const optional of [{ project: composition }, { setup: composition }]) {
    // Seed only the obsolete local slot; its contents must never be replayed.
    state.set(key, { input: { ...input, ...optional } });
    expect(await readWorkspaceCreationAttempt(state, key)).toBeUndefined();
    expect(state.get(key)).toBeUndefined();
    await saveWorkspaceCreationAttempt(state, key, { input });
    await expect(
      saveWorkspaceCreationAttempt(state, key, {
        input: { ...input, ...optional },
      }),
    ).rejects.toThrow("Invalid pending Workspace creation");
    expect(await readWorkspaceCreationAttempt(state, key)).toEqual({ input });
  }
});
