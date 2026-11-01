/**
 * @vitest-environment happy-dom
 */

import { Framework, FrameworkRoot, LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DocService } from "../../modules/doc";
import { JournalService } from "../../modules/journal";
import { WorkbenchService } from "../../modules/workbench";
import { JournalValue } from "./journal";

vi.mock("@myoxus/i18n", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    i18nTime: (value: string) => `localized:${value}`,
    useI18n: () =>
      new Proxy(
        { language: "en" },
        {
          get(target, prop: string) {
            if (prop in target) return target[prop as keyof typeof target];
            return () => prop;
          },
        },
      ),
  };
});

function renderJournalValue({
  docId = "journal-b",
  journalDate = "2056-01-24",
  journalsForDate = [{ id: "journal-a" }, { id: "journal-b" }],
  readonly = false,
}: {
  docId?: string;
  journalDate?: string | null;
  journalsForDate?: { id: string }[];
  readonly?: boolean;
} = {}) {
  const showTool = vi.fn();
  const removeJournalDate = vi.fn();
  const setJournalDate = vi.fn();
  const framework = new Framework();
  framework
    .service(DocService, {
      doc: { id: docId },
    } as any)
    .service(JournalService, {
      journalDate$: vi.fn(() => new LiveData(journalDate)),
      journalsByDate$: vi.fn(() => new LiveData(journalsForDate)),
      removeJournalDate,
      setJournalDate,
    } as any)
    .service(WorkbenchService, {
      workbench: {
        activeView$: new LiveData({ showTool }),
      },
    } as any);

  render(
    <MyoxusUIProvider>
      <FrameworkRoot framework={framework.provider()}>
        <JournalValue
          readonly={readonly}
          value={undefined}
          onChange={vi.fn()}
        />
      </FrameworkRoot>
    </MyoxusUIProvider>,
  );

  return {
    showTool,
    removeJournalDate,
    setJournalDate,
  };
}

describe("JournalValue", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("opens the journal context when the duplicate badge is activated", () => {
    const { showTool } = renderJournalValue();

    const conflictBadge = screen.getByTestId("conflict-tag");
    expect(conflictBadge.textContent).toContain(
      "com.myoxus.page-properties.property.journal-duplicated",
    );

    fireEvent.click(conflictBadge);

    expect(showTool).toHaveBeenCalledExactlyOnceWith("calendar");
  });

  test("does not render the duplicate badge for a single journal on the date", () => {
    renderJournalValue({ journalsForDate: [{ id: "journal-a" }] });

    expect(screen.queryByTestId("conflict-tag")).toBeNull();
  });

  test("mutates journal metadata only for editable toggle actions", () => {
    const first = renderJournalValue({
      journalDate: null,
      journalsForDate: [],
    });

    fireEvent.click(screen.getByRole("checkbox"));

    expect(first.removeJournalDate).not.toHaveBeenCalled();
    expect(first.setJournalDate).toHaveBeenCalledExactlyOnceWith(
      "journal-b",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );

    document.body.innerHTML = "";
    const second = renderJournalValue({
      journalDate: "2056-01-24",
      journalsForDate: [{ id: "journal-b" }],
    });

    fireEvent.click(screen.getByRole("checkbox"));

    expect(second.setJournalDate).not.toHaveBeenCalled();
    expect(second.removeJournalDate).toHaveBeenCalledExactlyOnceWith(
      "journal-b",
    );

    document.body.innerHTML = "";
    const third = renderJournalValue({
      journalDate: "2056-01-24",
      journalsForDate: [{ id: "journal-b" }],
      readonly: true,
    });

    fireEvent.click(screen.getByRole("checkbox"));

    expect(third.setJournalDate).not.toHaveBeenCalled();
    expect(third.removeJournalDate).not.toHaveBeenCalled();
  });
});
