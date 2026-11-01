// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  PdfPreviewError,
  PdfPreviewFooter,
  PdfPreviewFooterItem,
  PdfPreviewMeta,
  PdfPreviewPageCounter,
  PdfPreviewSearchField,
  PdfPreviewShell,
  PdfPreviewToolbar,
  PdfPreviewViewport,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(cleanup);

describe("PDF preview facade structure", () => {
  test("renders standard preview status and footer through native Mantine roles", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <PdfPreviewShell data-testid="shell">
          <PdfPreviewViewport data-testid="viewport">
            <PdfPreviewError>
              Could not render the selected page.
            </PdfPreviewError>
          </PdfPreviewViewport>
          <PdfPreviewFooter>
            <PdfPreviewFooterItem truncate>
              <PdfPreviewMeta truncate>Quarterly review.pdf</PdfPreviewMeta>
            </PdfPreviewFooterItem>
            <PdfPreviewPageCounter current={4} total={18} />
          </PdfPreviewFooter>
        </PdfPreviewShell>
      </MyoxusUIProvider>,
    );

    const shell = screen.getByTestId("shell");
    const viewport = screen.getByTestId("viewport");
    const alert = container.querySelector(
      '[data-myoxus-ui-role="pdf-preview-error"]',
    );
    const footer = container.querySelector(
      '[data-myoxus-ui-role="pdf-preview-footer"]',
    );
    const footerItem = container.querySelector(
      '[data-myoxus-ui-role="pdf-preview-footer-item"]',
    );
    const counter = container.querySelector(
      '[data-myoxus-ui-role="pdf-preview-page-counter"]',
    );

    expect(shell.className).toContain("mantine-Card-root");
    expect(viewport.className).toContain("mantine-Flex-root");
    expect(alert?.className).toContain("mantine-Alert-root");
    expect(footer?.className).toContain("mantine-Group-root");
    expect(footerItem?.className).toContain("mantine-Group-root");
    expect(counter?.textContent).toBe("4/18");
  });

  test("uses Mantine Card, Group, Stack and Center for toolbar states", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <PdfPreviewToolbar data-testid="horizontal-toolbar" placement="top-end">
          <PdfPreviewSearchField aria-label="Find in document" />
          <PdfPreviewPageCounter current={2} total={8} />
          <button type="button">Previous</button>
        </PdfPreviewToolbar>
        <PdfPreviewToolbar
          data-testid="vertical-toolbar"
          orientation="vertical"
          placement="side-end"
        >
          <button type="button">Previous</button>
          <button type="button">Next</button>
        </PdfPreviewToolbar>
        <PdfPreviewToolbar data-myoxus-ui-role="pdf-preview-loading">
          Loading preview
        </PdfPreviewToolbar>
        <PdfPreviewToolbar data-myoxus-ui-role="pdf-preview-status-actions">
          <button type="button">Reload</button>
        </PdfPreviewToolbar>
      </MyoxusUIProvider>,
    );

    const horizontal = screen.getByTestId("horizontal-toolbar");
    const vertical = screen.getByTestId("vertical-toolbar");
    const loading = container.querySelector(
      '[data-myoxus-ui-role="pdf-preview-loading"]',
    );
    const actions = container.querySelector(
      '[data-myoxus-ui-role="pdf-preview-status-actions"]',
    );

    expect(horizontal.className).toContain("mantine-Card-root");
    expect(
      horizontal.querySelector(
        '[data-myoxus-ui-role="toolbar-surface-content"]',
      ),
    ).toBeNull();
    expect(horizontal.querySelector(".mantine-Group-root")).not.toBeNull();
    expect(vertical.className).toContain("mantine-Card-root");
    expect(vertical.querySelector(".mantine-Stack-root")).not.toBeNull();
    expect(loading?.className).toContain("mantine-Center-root");
    expect(actions?.className).toContain("mantine-Group-root");
  });
});
