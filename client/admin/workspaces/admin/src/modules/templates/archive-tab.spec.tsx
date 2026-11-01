import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockEnableTemplate = vi.fn().mockResolvedValue({});
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
const mockEntriesState: { entries: any[]; totalCount: number } = {
  entries: [],
  totalCount: 0,
};

vi.mock("./api", () => ({
  enableTemplate: (...args: any[]) => mockEnableTemplate(...args),
  useTemplateCatalogQuery: () => ({
    entries: mockEntriesState.entries,
    totalCount: mockEntriesState.totalCount,
  }),
  useTemplateRegistryRevalidate: () => ({
    revalidateCatalog: vi.fn(),
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

import { ArchiveTab } from "./archive-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("ArchiveTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntriesState.entries = [
      {
        id: "tpl-arch-1",
        slug: "onboarding",
        title: "Onboarding",
        category: "ops",
        status: "ARCHIVED",
      },
    ];
    mockEntriesState.totalCount = 1;
  });

  afterEach(() => {
    cleanup();
  });

  test("restore calls enableTemplate and shows success toast", async () => {
    renderWithFacade(<ArchiveTab />);
    fireEvent.click(screen.getByText("Restore"));

    await waitFor(() => {
      expect(mockEnableTemplate).toHaveBeenCalledWith("tpl-arch-1");
    });
    await waitFor(() => {
      expect(notifyMock.success).toHaveBeenCalledWith({
        title: 'Template "Onboarding" restored to Active.',
      });
    });
  });
});
