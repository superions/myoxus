// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { AssistantLibrarySource } from "./catalog-page";

const owner = vi.hoisted(() => ({ identity: "server/actor/workspace" }));
const fixtures = vi.hoisted(() => ({
  resolve: vi.fn(),
  apply: vi.fn(),
  open: vi.fn(),
  suggestions: vi.fn(),
  reconcile: vi.fn(),
}));
const allowed$ = new LiveData(true);
const absentDoc$ = new LiveData(null);
const pending$ = new LiveData<ReadonlySet<string>>(new Set());
vi.mock("@myoxus/i18n", async () =>
  (
    await import("../../database/test-i18n-mock")
  ).createDatabaseTestI18nModule(),
);
vi.mock("../../database/tasks/use-workspace-tasks", () => ({
  useTaskIdentity: () => ({
    identity: owner.identity,
    workspace: { id: "workspace", flavour: "cloud" },
  }),
}));
vi.mock("../../../components/guard/use-guard", () => ({
  useGuard: () => true,
}));
vi.mock("../../../components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalPreferences: () => ({}),
}));
vi.mock("../../../components/hooks/myoxus/use-document-operations", () => ({
  useDocumentOperations: () => ({}),
}));
vi.mock("./template-check-dialog", () => ({ TemplateCheckDialog: () => null }));
vi.mock("../../workbench", async (original) => ({
  ...(await original<typeof import("../../workbench")>()),
  WorkbenchLink: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@myoxus/infra", async (original) => ({
  ...(await original<typeof import("@myoxus/infra")>()),
  useService: (service: { name: string }) => {
    switch (service.name) {
      case "TemplateDocService":
        return templateService;
      case "GuardService":
        return { can$: () => allowed$, revalidateCan: vi.fn() };
      case "DocsService":
        return { list: { doc$: () => absentDoc$ } };
      case "WorkbenchService":
        return { workbench: { openDoc: fixtures.open } };
      case "TemplateApplicationService":
        return { pending$, apply: fixtures.apply };
      default:
        throw new Error(`Unexpected service ${service.name}`);
    }
  },
}));
const templateService = {
  resolveAssistantDocumentSource: fixtures.resolve,
  loadTemplateSuggestions: fixtures.suggestions,
  reconcile: fixtures.reconcile,
};
const input = {
  identity: { id: "example.project", version: "1.0.0", digest: "a".repeat(64) },
  step: "setup",
  group: "guides",
  sourceDigest: "b".repeat(64),
};
const source = {
  templateId: "registry-id",
  templateDocId: "source-doc",
  sourceRevisionId: "revision-one",
  slug: "project-guide",
  title: "Exact linked guide",
  description: null,
  source: "bundle",
  updatedAt: "2026-10-17T00:00:00Z",
  category: "work",
  tags: [],
  score: 1,
  reasons: [],
  instanceState: "ok",
  available: true,
  protectedSource: true,
};
const content = (value: typeof input | null = input) => (
  <MyoxusUIProvider env="test">
    <AssistantLibrarySource input={value} />
  </MyoxusUIProvider>
);
beforeEach(() => {
  vi.clearAllMocks();
  owner.identity = "server/actor/workspace";
  fixtures.resolve.mockResolvedValue(source);
  fixtures.apply.mockResolvedValue({ ok: true, docId: "created-doc" });
});
afterEach(cleanup);

test("manual association reads nothing into the workspace and rejects a changed revision before native Use", async () => {
  render(content());
  const use = await screen.findByRole("button", { name: "Use" });
  expect(fixtures.apply).not.toHaveBeenCalled();
  expect(fixtures.suggestions).not.toHaveBeenCalled();
  expect(fixtures.reconcile).not.toHaveBeenCalled();
  fixtures.resolve.mockResolvedValue({
    ...source,
    sourceRevisionId: "revision-two",
  });
  fireEvent.click(use);
  await waitFor(() => expect(fixtures.resolve).toHaveBeenCalledTimes(3));
  expect(fixtures.apply).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Use" }));
  await waitFor(() => expect(fixtures.apply).toHaveBeenCalledOnce());
  expect(fixtures.apply).toHaveBeenCalledWith(
    "source-doc",
    expect.objectContaining({ creationContext: {} }),
    "library",
  );
  expect(fixtures.open).toHaveBeenCalledWith("created-doc", expect.any(Object));
});

test("invalid links and terminal denial never fall back to latest inventory; Retry re-reads the same qualified source", async () => {
  const view = render(content(null));
  await screen.findByTestId("assistant-library-unavailable");
  expect(fixtures.resolve).not.toHaveBeenCalled();
  fixtures.resolve.mockResolvedValue(null);
  view.rerender(content());
  await screen.findByTestId("assistant-library-unavailable");
  expect(screen.queryByRole("button", { name: "Use" })).toBeNull();
  fixtures.resolve.mockResolvedValue(source);
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.focus();
  fireEvent.click(retry);
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: "Library" }),
  );
  await screen.findByRole("button", { name: "Use" });
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: "Library" }),
  );
  expect(fixtures.resolve).toHaveBeenLastCalledWith(input, "en");
  expect(fixtures.suggestions).not.toHaveBeenCalled();
  expect(fixtures.apply).not.toHaveBeenCalled();
});

test("a late source response cannot enter the next actor's Library", async () => {
  let resolve!: (value: typeof source) => void;
  fixtures.resolve
    .mockReturnValueOnce(
      new Promise<typeof source>((done) => {
        resolve = done;
      }),
    )
    .mockResolvedValue(null);
  const view = render(content());
  owner.identity = "server/other/workspace";
  view.rerender(content());
  await screen.findByTestId("assistant-library-unavailable");
  resolve(source);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Use" })).toBeNull(),
  );
  expect(fixtures.apply).not.toHaveBeenCalled();
});

test("a failed fresh Use read reports unavailability and never enters native application", async () => {
  render(content());
  const use = await screen.findByRole("button", { name: "Use" });
  fixtures.resolve.mockRejectedValue(new Error("Network unavailable"));
  use.focus();
  fireEvent.click(use);
  await screen.findByTestId("assistant-library-unavailable");
  expect(fixtures.apply).not.toHaveBeenCalled();
  expect(fixtures.open).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: "Library" }),
  );
});

test("double activation shares the pending fresh source read and cannot create a second copy", async () => {
  render(content());
  const use = await screen.findByRole("button", { name: "Use" });
  let resolve!: (value: typeof source) => void;
  fixtures.resolve.mockImplementationOnce(
    () =>
      new Promise<typeof source>((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(use);
  fireEvent.click(use);
  expect(fixtures.resolve).toHaveBeenCalledTimes(2); // Initial read plus one explicit Use.
  expect(fixtures.apply).not.toHaveBeenCalled();
  expect((use as HTMLButtonElement).disabled).toBe(true);
  resolve(source);
  await waitFor(() => expect(fixtures.apply).toHaveBeenCalledOnce());
  await waitFor(() => expect((use as HTMLButtonElement).disabled).toBe(false));
  expect(fixtures.resolve).toHaveBeenCalledTimes(2);
  expect(fixtures.open).toHaveBeenCalledOnce();
});
