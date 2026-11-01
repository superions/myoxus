// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { I18n } from "@myoxus/i18n";
import { signal } from "@preact/signals-core";
import { Framework, FrameworkRoot, LiveData } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Store } from "@virgultum/editor/store";
import { type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { StarterBar } from "../../../editor/virgultum/doc-editor/starter-bar";
import { WorkbenchService } from "../../workbench";
import { DocsService } from "../../doc/services/docs";
import { TemplateCheckService } from "../services/template-check";
import { TemplateInputDialog } from "../view/template-input-dialog";

import type { InstantiateTemplateOptions } from "../services/template-instantiation";
import { WorkspaceDialogService } from "../../dialogs";
import { TemplateInputPromptService } from "../services/template-input-prompt";
import {
  templateFailureMessages,
  TemplateApplicationService,
} from "../services/template-application";
import { TemplateDocService } from "../services/template-doc";
import { TemplateInstantiationService } from "../services/template-instantiation";
import {
  TemplateInstantiationError,
  type TemplateInstantiationFailure,
} from "../services/template-instantiation-error";

// The global UI mock returns keys and ignores language changes; that cannot
// prove this controller's localized feedback contract.
vi.unmock("@myoxus/i18n");

const tracking = vi.hoisted(() => ({ success: vi.fn(), menu: vi.fn() }));
vi.mock("@myoxus/track", () => ({
  default: {
    doc: {
      editor: {
        starterBar: {
          quickStart: tracking.success,
          openTemplateListMenu: tracking.menu,
        },
      },
    },
  },
}));
vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalPreferences: () => preferences,
}));
// The picker only supplies an authored source ID. Keep the actual StarterBar,
// feedback service, focus hook, LiveData/DI and Facade button in this boundary test.
vi.mock("@myoxus/core/modules/template-doc/view/template-list-menu", () => ({
  TemplateListMenu: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect: (id: string) => void;
    disabled: boolean;
  }) => (
    <>
      {children}
      <button disabled={disabled} onClick={() => onSelect("source")}>
        Choose fixture template
      </button>
    </>
  ),
  TemplateListMenuAdd: () => null,
}));

const preferences = {
  locale: "en",
  timezone: "UTC",
  dateFormat: "locale",
  timeFormat: "locale",
} as const;
const options = {
  creationContext: {},
  date: "2026-09-05",
  regionalPreferences: preferences,
  targetDocId: "target",
};
beforeEach(async () => {
  vi.spyOn(notify, "error").mockReturnValue("notification");
  await I18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await I18n.changeLanguage("en");
});

function setup() {
  const instantiate = vi.fn(
    async (_source?: string, _options?: InstantiateTemplateOptions) => "target",
  );
  const openDoc = vi.fn();
  const framework = new Framework();
  framework.service(TemplateInstantiationService, {
    instantiate,
  } as unknown as TemplateInstantiationService);
  framework.service(WorkbenchService, {
    workbench: { openDoc },
  } as unknown as WorkbenchService);
  framework.service(WorkspaceDialogService);
  framework.service(TemplateInputPromptService, [WorkspaceDialogService]);
  framework.service(TemplateApplicationService, [
    TemplateInstantiationService,
    WorkbenchService,
    TemplateInputPromptService,
  ]);
  framework.service(TemplateDocService, {
    list: { isTemplate$: () => new LiveData(false) },
  } as unknown as TemplateDocService);
  const provider = framework.provider();
  return {
    instantiate,
    openDoc,
    provider,
    service: provider.get(TemplateApplicationService),
  };
}

test.each<[TemplateInstantiationFailure, string]>([
  ["unresolved-variable", "variables"],
  ["member-fetch", "members"],
  ["local-only-incompatible", "local"],
  ["empty-field", "unavailable"],
  ["parent-unavailable", "parent"],
  ["folder-absent", "folder-absent"],
  ["folder-ambiguous", "folder-ambiguous"],
  ["sync-timeout", "interrupted"],
  ["conflict", "conflict"],
  ["application-failed", "failed"],
])(
  "translates %s once without exposing the cause",
  async (reason, category) => {
    const { service, instantiate, openDoc } = setup();
    await I18n.changeLanguage("de");
    instantiate.mockRejectedValue(
      new TemplateInstantiationError(reason, {
        cause: new Error("private@example.test document-id graphql-payload"),
      }),
    );
    expect(await service.apply("source", options, "sidebar")).toEqual({
      ok: false,
      reason,
    });
    expect(notify.error).toHaveBeenCalledOnce();
    const [notification] = vi.mocked(notify.error).mock.calls[0];
    expect(notification).toMatchObject({
      message: I18n.t(`com.myoxus.template-application.error.${category}`),
    });
    expect(JSON.stringify(notification)).not.toMatch(
      /private|document-id|graphql-payload/,
    );
    expect(openDoc).not.toHaveBeenCalled();
    expect(service.pending$.value.size).toBe(0);
  },
);

test("suppresses duplicate success side effects, releases busy state and permits retry", async () => {
  const { service, instantiate } = setup();
  let resolve!: (id: string) => void;
  instantiate.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = service.apply("source", options, "sidebar");
  expect(service.pending$.value.has("target:target")).toBe(true);
  expect(await service.apply("another-source", options, "sidebar")).toEqual({
    ok: false,
    reason: "busy",
  });
  expect(instantiate).toHaveBeenCalledOnce();
  resolve("target");
  expect(await first).toEqual({ ok: true, docId: "target" });
  expect(service.pending$.value.size).toBe(0);
  expect(await service.apply("source", options, "sidebar")).toEqual({
    ok: true,
    docId: "target",
  });
  expect(instantiate).toHaveBeenLastCalledWith(
    "source",
    expect.objectContaining(options),
  );
  expect(notify.error).not.toHaveBeenCalled();
});

test("keeps Library single-flight scoped to the selected source", async () => {
  const { service, instantiate } = setup();
  let finishFirst!: (id: string) => void;
  instantiate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
  );

  const first = service.apply(
    "source-a",
    { ...options, targetDocId: undefined },
    "library",
  );
  expect(service.pending$.value).toEqual(new Set(["create:library:source-a"]));
  expect(
    await service.apply(
      "source-a",
      { ...options, targetDocId: undefined },
      "library",
    ),
  ).toEqual({ ok: false, reason: "busy" });
  expect(
    await service.apply(
      "source-b",
      { ...options, targetDocId: undefined },
      "library",
    ),
  ).toEqual({ ok: true, docId: "target" });
  expect(instantiate).toHaveBeenCalledTimes(2);

  finishFirst("created-a");
  expect(await first).toEqual({ ok: true, docId: "created-a" });
  expect(service.pending$.value.size).toBe(0);
});

test("keeps failed compensation visible with explicit access to the affected document", async () => {
  const { service, instantiate, openDoc } = setup();
  instantiate.mockRejectedValue(
    new TemplateInstantiationError("rollback-failed", {
      targetDocId: "recover-target",
    }),
  );
  expect(await service.apply("source", options, "sidebar")).toEqual({
    ok: false,
    reason: "rollback-failed",
  });
  expect(notify.error).toHaveBeenCalledOnce();
  const [notification, settings] = vi.mocked(notify.error).mock.calls[0];
  expect(settings).toEqual({ duration: 0 });
  expect(notification).toMatchObject({
    message: I18n["com.myoxus.template-application.error.restoration"](),
  });
  expect(openDoc).not.toHaveBeenCalled();
  if (
    !notification ||
    typeof notification !== "object" ||
    !("actions" in notification)
  )
    throw new Error("Expected actionable notification");
  notification.actions![0].onClick!();
  expect(openDoc).toHaveBeenCalledExactlyOnceWith("recover-target");
});

test("StarterBar survives copy/rollback, disables repeat selection, restores focus and tracks only success", async () => {
  const { instantiate, provider } = setup();
  const isEmpty$ = signal(true);
  const doc = {
    id: "target",
    get isEmpty() {
      return isEmpty$.value;
    },
    isEmpty$,
  } as unknown as Store;
  let reject!: (error: Error) => void;
  instantiate.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  render(
    <MyoxusUIProvider>
      <FrameworkRoot framework={provider}>
        <StarterBar doc={doc} />
      </FrameworkRoot>
    </MyoxusUIProvider>,
  );
  const trigger = screen.getByTestId("template-docs-button");
  fireEvent.click(screen.getByText("Choose fixture template"));
  await waitFor(() => expect(trigger.getAttribute("aria-busy")).toBe("true"));
  act(() => {
    isEmpty$.value = false;
  });
  expect(screen.getByTestId("template-docs-button")).toBe(trigger);
  fireEvent.click(screen.getByText("Choose fixture template"));
  expect(instantiate).toHaveBeenCalledOnce();
  await act(async () => {
    isEmpty$.value = true;
    reject(new TemplateInstantiationError("unresolved-variable"));
  });
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(trigger.getAttribute("aria-busy")).toBe("false");
  expect(notify.error).toHaveBeenCalledOnce();
  expect(tracking.success).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Choose fixture template"));
  await waitFor(() =>
    expect(tracking.success).toHaveBeenCalledExactlyOnceWith({
      with: "template",
    }),
  );
  expect(instantiate).toHaveBeenLastCalledWith(
    "source",
    expect.objectContaining({
      targetDocId: "target",
      creationContext: {},
      regionalPreferences: preferences,
    }),
  );
});

test("check uses catalog admission and releases a result after admission is revoked", async () => {
  const release = vi.fn();
  const denied = new TemplateInstantiationError("source-unavailable");
  const resolveSourceMetadataForDoc = vi
    .fn()
    .mockResolvedValueOnce({ source: "custom" })
    .mockRejectedValueOnce(denied);
  const checkTemplate = vi.fn(async () => ({ release }));
  const framework = new Framework();
  framework
    .service(DocsService, { checkTemplate } as unknown as DocsService)
    .service(TemplateDocService, {
      resolveSourceMetadataForDoc,
    } as unknown as TemplateDocService)
    .service(TemplateCheckService, [DocsService, TemplateDocService]);
  const check = framework.provider().get(TemplateCheckService);
  await expect(
    check.check("readonly-source", new AbortController().signal),
  ).rejects.toMatchObject({ reason: "source-unavailable" });
  expect(resolveSourceMetadataForDoc).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledOnce();
  resolveSourceMetadataForDoc.mockRejectedValue(denied);
  checkTemplate.mockClear();
  await expect(
    check.check("hidden", new AbortController().signal),
  ).rejects.toMatchObject({ reason: "source-unavailable" });
  expect(checkTemplate).not.toHaveBeenCalled();
});

test.each(["application-failed"] as const)(
  "manual input modal retains answers after %s and prevents repeat submission",
  async (reason) => {
    const { service, instantiate, provider } = setup();
    let attempts = 0;
    instantiate.mockImplementation(async (_source, opts) => {
      const values = await opts!.requestInputs!(
        ["input.project_name"],
        opts!.signal!,
      );
      expect(values).toEqual({ "input.project_name": "Atlas" });
      if (++attempts === 1) throw new TemplateInstantiationError(reason);
      return "created";
    });
    const pending = service.apply("source", options, "library");
    const dialogs = provider.get(WorkspaceDialogService);
    await waitFor(() => expect(dialogs.dialogs$.value).toHaveLength(1));
    const dialog = dialogs.dialogs$.value[0];
    if (dialog.type !== "template-inputs")
      throw new Error("Expected input dialog");
    render(
      <MyoxusUIProvider>
        <TemplateInputDialog
          {...dialog.props}
          close={() => dialogs.close(dialog.id)}
        />
      </MyoxusUIProvider>,
    );
    const input = screen.getByRole("textbox", { name: "project name" });
    fireEvent.change(input, { target: { value: "  Atlas  " } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(
        screen.getByText(I18n[templateFailureMessages[reason]]()),
      ).toBeTruthy(),
    );
    expect((input as HTMLInputElement).value).toBe("  Atlas  ");
    expect(instantiate).toHaveBeenCalledOnce();
    expect(await service.apply("source", options, "library")).toEqual({
      ok: false,
      reason: "busy",
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await pending).toEqual({ ok: true, docId: "created" });
    expect(attempts).toBe(2);
    expect(dialogs.dialogs$.value).toHaveLength(0);
  },
);

test("closing a manual input prompt cancels before the application can write", async () => {
  const { service, instantiate, provider } = setup();
  const write = vi.fn();
  instantiate.mockImplementation(async (_source, opts) => {
    await opts!.requestInputs!(["input.project"], opts!.signal!);
    write();
    return "created";
  });
  const pending = service.apply("source", options, "library");
  const dialogs = provider.get(WorkspaceDialogService);
  await waitFor(() => expect(dialogs.dialogs$.value).toHaveLength(1));
  dialogs.close(dialogs.dialogs$.value[0].id);
  expect(await pending).toEqual({ ok: false, reason: "cancelled" });
  expect(write).not.toHaveBeenCalled();
  expect(notify.error).not.toHaveBeenCalled();
  expect(service.pending$.value.size).toBe(0);
});

test("a caller-owned typed rejection closes the input prompt and returns its exact reason", async () => {
  const { provider } = setup();
  const prompts = provider.get(TemplateInputPromptService);
  const failure = {
    extensions: {
      code: "MIX_DATABASE_TASK_RELATION_INVALID",
      reason: "Cycle",
    },
  };
  const write = vi.fn(async (request, signal) => {
    await request(["input.project"], signal);
    throw failure;
  });
  const pending = prompts.run(write, {
    canRetry: () => false,
    propagateError: (error) => error === failure,
    uncertainMessage: "Check the database before retrying",
  });
  const outcome = pending.catch((error) => error);
  const dialogs = provider.get(WorkspaceDialogService);
  await waitFor(() => expect(dialogs.dialogs$.value).toHaveLength(1));
  const dialog = dialogs.dialogs$.value[0];
  if (dialog.type !== "template-inputs")
    throw new Error("Expected input dialog");
  render(
    <MyoxusUIProvider>
      <TemplateInputDialog
        {...dialog.props}
        close={() => dialogs.close(dialog.id)}
      />
    </MyoxusUIProvider>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "project" }), {
    target: { value: "Atlas" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(await outcome).toBe(failure);
  expect(dialogs.dialogs$.value).toHaveLength(0);
  expect(screen.queryByText("Check the database before retrying")).toBeNull();
  expect(write).toHaveBeenCalledOnce();
});

test("an unknown Database write keeps answers visible but cannot replay", async () => {
  const { provider } = setup();
  const prompts = provider.get(TemplateInputPromptService);
  const failure = new Error("lost write receipt");
  const write = vi.fn(async (request, signal) => {
    await request(["input.project"], signal);
    throw failure;
  });
  const pending = prompts.run(write, {
    canRetry: () => false,
    uncertainMessage: "Check the database before retrying",
  });
  // Attach the rejection handler before the deliberate Close aborts the waiter.
  const outcome = pending.catch((error) => error);
  const dialogs = provider.get(WorkspaceDialogService);
  await waitFor(() => expect(dialogs.dialogs$.value).toHaveLength(1));
  const dialog = dialogs.dialogs$.value[0];
  if (dialog.type !== "template-inputs")
    throw new Error("Expected input dialog");
  render(
    <MyoxusUIProvider>
      <TemplateInputDialog
        {...dialog.props}
        close={() => dialogs.close(dialog.id)}
      />
    </MyoxusUIProvider>,
  );
  const input = screen.getByRole("textbox", { name: "project" });
  fireEvent.change(input, { target: { value: "Atlas {{date}}" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText("Check the database before retrying");
  expect((input as HTMLInputElement).value).toBe("Atlas {{date}}");
  expect(
    (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(write).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await outcome).toBe(failure);
  expect(dialogs.dialogs$.value).toHaveLength(0);
});
