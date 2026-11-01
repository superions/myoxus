// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import "../test-editor-boundary";

import {
  AssistantActionKind,
  AssistantContext,
  AssistantControlKind,
  AssistantInputTarget,
  AssistantValueType,
  AssistantVisibilityKind,
  type AssistantControlFragmentFragment,
} from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { AssistantActions, AssistantGroups } from "./renderer";
import { AssistantNativeDialog, useAssistantNavigation } from "./native-form";
import {
  assistantAnswerPayload,
  assistantValue,
  visibleAssistantAnswers,
  type AssistantAnswers,
} from "./values";
import { assistantPackagesFixture } from "./test-fixtures";
import { useAssistantFormValidation } from "./use-form-validation";

vi.mock("@myoxus/i18n", async () =>
  (await import("../test-i18n-mock")).createDatabaseTestI18nModule(),
);
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
beforeAll(() =>
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  }),
);
afterAll(() => {
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});
afterEach(cleanup);

const project = () =>
  structuredClone(
    assistantPackagesFixture(AssistantContext.ProjectCreation)[0],
  );

test("a hidden placement drops both a supplied value and its authored default; another visible placement admits it", () => {
  const descriptor = project();
  const title = descriptor.inputs.find(
    (input) => input.target === AssistantInputTarget.Title,
  )!;
  const currency = descriptor.inputs.find(
    (input) => input.target === AssistantInputTarget.DefaultCurrency,
  )!;
  const placement = descriptor.presentation.steps
    .flatMap((step) => step.groups)
    .find((group) =>
      group.controls.some((control) => control.input === currency.id),
    )!;
  placement.visibleWhen = {
    kind: AssistantVisibilityKind.Present,
    input: title.id,
    value: null,
  };
  const supplied = {
    [currency.id]: assistantValue(AssistantValueType.Text, { text: "USD" }),
  };
  expect(
    visibleAssistantAnswers(descriptor, supplied, true),
  ).not.toHaveProperty(currency.id);
  expect(
    visibleAssistantAnswers(
      descriptor,
      {
        [title.id]: assistantValue(AssistantValueType.Text, {
          text: "Release",
        }),
        ...supplied,
      },
      true,
    )[currency.id]?.text,
  ).toBe("USD");
  descriptor.presentation.steps[0].groups.push({
    ...placement,
    id: "additional-visible-placement",
    visibleWhen: null,
  });
  expect(
    visibleAssistantAnswers(descriptor, supplied, true)[currency.id]?.text,
  ).toBe("USD");
});

test("native move answer serialization preserves exact row revisions and UUID-to-revision cell maps", () => {
  expect(
    assistantAnswerPayload({
      selection: assistantValue(AssistantValueType.RowSelection, {
        rowSelection: [
          {
            rowId: "row-a",
            expectedEditRevision: 7,
            cellRevisions: [
              { fieldId: "field-a", expectedEditRevision: 9 },
              { fieldId: "cleared-slot", expectedEditRevision: 4 },
            ],
          },
        ],
      }),
    }),
  ).toEqual({
    selection: {
      kind: "rowSelection",
      value: [
        {
          rowId: "row-a",
          expectedEditRevision: 7,
          cellRevisions: { "field-a": 9, "cleared-slot": 4 },
        },
      ],
    },
  });
});

test("a required dialog input retains focus and feedback until admitted, and the native action guard also disables dialog commit", async () => {
  const descriptor = structuredClone(
    assistantPackagesFixture(AssistantContext.TaskCreation)[0],
  );
  const title = descriptor.inputs.find(
    (input) => input.target === AssistantInputTarget.Title,
  )!;
  const original = descriptor.presentation.steps
    .flatMap((step) => step.groups)
    .find((group) =>
      group.controls.some((control) => control.input === title.id),
    )!;
  const sourceAction = descriptor.presentation.steps
    .flatMap((step) => step.actions)
    .find((action) => action.action === AssistantActionKind.CreateTask)!;
  const commit = {
    ...sourceAction,
    action: AssistantActionKind.CreateTask,
    dialog: null,
  };
  descriptor.inputs = [{ ...title, required: true, defaultValue: null }];
  descriptor.presentation.steps = [
    {
      ...descriptor.presentation.steps[0],
      groups: [],
      actions: [{ ...commit, dialog: "required-confirm" }],
    },
  ];
  descriptor.presentation.dialogs = [
    {
      id: "required-confirm",
      title: {
        en: "Required confirmation",
        de: "Bestätigung",
        fr: "Confirmation",
        es: "Confirmación",
      },
      groups: [
        {
          ...original,
          controls: original.controls.filter(
            (control) => control.input === title.id,
          ),
        },
      ],
      actions: [commit],
    },
  ];
  const apply = vi.fn();
  function Form({ eligible }: { eligible: boolean }) {
    const [answers, setAnswers] = useState<AssistantAnswers>({});
    const validation = useAssistantFormValidation(descriptor, answers);
    const navigation = useAssistantNavigation(
      descriptor,
      apply,
      false,
      validation.validate,
    );
    return (
      <>
        <AssistantActions
          actions={navigation.step!.actions}
          answers={answers}
          onAction={navigation.act}
        />
        {navigation.dialog ? (
          <AssistantNativeDialog
            descriptor={descriptor}
            dialog={navigation.dialog}
            answers={answers}
            adapters={{
              input: ({ input, error }) => (
                <label>
                  {input.label.en}
                  <input
                    aria-label={input.label.en}
                    aria-invalid={Boolean(error)}
                    data-assistant-input={input.id}
                    value={answers[input.id]?.text ?? ""}
                    onChange={(event) =>
                      setAnswers({
                        [input.id]: assistantValue(AssistantValueType.Text, {
                          text: event.target.value,
                        }),
                      })
                    }
                  />
                </label>
              ),
            }}
            disabled={false}
            busy={false}
            actionDisabled={() => !eligible}
            invalidInputs={validation.invalidInputs}
            dialogRef={validation.dialogRef}
            onClose={navigation.closeDialog}
            onAction={(action) => navigation.act(action, true)}
          />
        ) : null}
      </>
    );
  }
  const { rerender } = render(
    <MyoxusUIProvider env="test">
      <Form eligible />
    </MyoxusUIProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Create" }));
  const dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  const input = within(dialog).getByLabelText(title.label.en);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(input);
  expect(apply).not.toHaveBeenCalled();
  await user.type(input, "Required native task");
  // The same native eligibility predicate must gate a portal confirmation.
  rerender(
    <MyoxusUIProvider env="test">
      <Form eligible={false} />
    </MyoxusUIProvider>,
  );
  expect(
    (within(dialog).getByRole("button", { name: "Create" }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  rerender(
    <MyoxusUIProvider env="test">
      <Form eligible />
    </MyoxusUIProvider>,
  );
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
  expect(apply).toHaveBeenCalledExactlyOnceWith(commit);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("manual Library associations belong only to their visible qualified group and retain the native draft", () => {
  const descriptor = project();
  const step = descriptor.presentation.steps[1];
  const group = step.groups[0];
  const source = {
    step: step.id,
    group: group.id,
    templateId: "project-guide",
    version: "1.0.0",
    digest: "d".repeat(64),
  };
  descriptor.documentSources = [
    source,
    {
      ...source,
      step: descriptor.presentation.steps[0].id,
      group: descriptor.presentation.steps[0].groups[0].id,
    },
  ];
  const open = vi.fn();
  const content = (stepId: string) => (
    <MyoxusUIProvider>
      <input aria-label="Native draft" defaultValue="Preserved" />
      <AssistantGroups
        descriptor={descriptor}
        groups={[group]}
        stepId={stepId}
        answers={{}}
        adapters={{}}
        onOpenDocumentSource={open}
      />
    </MyoxusUIProvider>
  );
  const view = render(content(step.id));
  fireEvent.click(screen.getByRole("button", { name: "Library" }));
  expect(open).toHaveBeenCalledExactlyOnceWith(source);
  expect(
    (screen.getByRole("textbox", { name: "Native draft" }) as HTMLInputElement)
      .value,
  ).toBe("Preserved");
  view.rerender(content("unrelated-step"));
  expect(screen.queryByRole("button", { name: "Library" })).toBeNull();
});

test("native contextual document form submits its authored Prepare action and projects DocumentReview through the existing adapter", async () => {
  const descriptor = assistantPackagesFixture(
    AssistantContext.TaskContainerAssistance,
  )[0];
  const step = descriptor.presentation.steps[0];
  const dialog = descriptor.presentation.dialogs[0];
  const prepare = step.actions.find(
    (action) => action.action === AssistantActionKind.PrepareDocuments,
  )!;
  const dispatch = vi.fn();
  const review = vi.fn((control: AssistantControlFragmentFragment) =>
    control.kind === AssistantControlKind.DocumentReview ? (
      <span>Canonical document review</span>
    ) : undefined,
  );
  const user = userEvent.setup();
  render(
    <MyoxusUIProvider env="test">
      <form
        id="contextual-native-form"
        onSubmit={(event) => {
          event.preventDefault();
          dispatch(prepare);
        }}
      >
        <AssistantActions
          actions={step.actions}
          answers={{}}
          formId="contextual-native-form"
          submitActionId={prepare.id}
          onAction={dispatch}
        />
        <AssistantGroups
          descriptor={descriptor}
          groups={dialog.groups}
          answers={{}}
          adapters={{ control: review }}
        />
      </form>
    </MyoxusUIProvider>,
  );
  const button = screen.getByRole("button", { name: "Review preparation" });
  expect(button.getAttribute("type")).toBe("submit");
  expect((button as HTMLButtonElement).form?.id).toBe("contextual-native-form");
  button.focus();
  await user.keyboard("{Enter}");
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(prepare);
  expect(screen.getByText("Canonical document review")).toBeTruthy();
  expect(review).toHaveBeenCalledWith(
    expect.objectContaining({ kind: AssistantControlKind.DocumentReview }),
  );
});
