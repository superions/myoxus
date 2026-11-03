/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@myoxus/ui-facade", () => ({
  MenuItem: ({
    children,
    disabled,
    onSelect,
    suffix,
    "data-testid": testId,
    "aria-disabled": ariaDisabled,
    "aria-description": description,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
    suffix?: ReactNode;
    "data-testid"?: string;
    "aria-disabled"?: boolean;
    "aria-description"?: string;
  }) => (
    <button
      data-testid={testId}
      aria-disabled={ariaDisabled}
      aria-description={description}
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
      {suffix}
    </button>
  ),
  MenuSeparator: () => <hr />,
  MenuSub: ({ items }: { items: ReactNode }) => <div>{items}</div>,
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@myoxus/track", () => ({
  track: { $: { header: { docOptions: { export: () => {} } } } },
}));
vi.mock("@myoxus/icons/react", () => ({
  ExportIcon: () => null,
  ExportToHtmlIcon: () => null,
  ExportToMarkdownIcon: () => null,
  ExportToPngIcon: () => null,
  PageIcon: () => null,
  PrinterIcon: () => null,
  FileIconDocxIcon: () => null,
  InformationIcon: () => null,
}));
import { ExportMenuItems } from "../components/page-list/operation-menu-items/export";

afterEach(cleanup);
describe("document export menu", () => {
  test.each(["page", "edgeless"] as const)(
    "keeps PDF available in %s and restricts Word to Page",
    (mode) => {
      const exportHandler = vi.fn();
      render(<ExportMenuItems exportHandler={exportHandler} pageMode={mode} />);
      const pdf = screen.getByTestId(
        "export-to-pdf-export",
      ) as HTMLButtonElement;
      expect(pdf.disabled).toBe(false);
      expect(
        screen.queryByTestId("export-to-pdf-export-unavailable-tag"),
      ).toBeNull();
      const word = screen.getByTestId("export-to-docx");
      expect(word.getAttribute("aria-disabled")).toBe(
        mode === "edgeless" ? "true" : null,
      );
      expect(pdf.nextElementSibling).toBe(word);
      fireEvent.click(word);
      expect(exportHandler.mock.calls).toEqual(
        mode === "page" ? [["docx"]] : [],
      );
    },
  );
});
