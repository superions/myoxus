// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  AttachmentViewerContainer,
  AttachmentViewerErrorActions,
  AttachmentViewerErrorMessage,
  AttachmentViewerErrorRoot,
  AttachmentViewerErrorTitle,
  AttachmentViewerMeta,
  AttachmentViewerTitle,
  AttachmentViewerTitlebar,
  AttachmentViewerTitlebarGroup,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(cleanup);

describe("Attachment viewer facade structure", () => {
  test("renders the titlebar through native Mantine Stack and Group roles", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <AttachmentViewerContainer>
          <AttachmentViewerTitlebar>
            <AttachmentViewerTitlebarGroup>
              <AttachmentViewerTitle extension="pdf" name="Quarterly report" />
              <AttachmentViewerMeta>23.29 kB</AttachmentViewerMeta>
              <button type="button">Download</button>
            </AttachmentViewerTitlebarGroup>
          </AttachmentViewerTitlebar>
        </AttachmentViewerContainer>
      </MyoxusUIProvider>,
    );

    const viewer = container.querySelector(
      '[data-myoxus-ui-role="attachment-viewer-container"]',
    );
    const titlebar = container.querySelector(
      '[data-myoxus-ui-role="attachment-viewer-titlebar"]',
    );
    const titleGroup = container.querySelector(
      '[data-myoxus-ui-role="attachment-viewer-titlebar-group"]',
    );
    const title = container.querySelector(
      '[data-myoxus-ui-role="attachment-viewer-title"]',
    );

    expect(viewer?.className).toContain("mantine-Stack-root");
    expect(titlebar?.className).toContain("mantine-Group-root");
    expect(titleGroup?.className).toContain("mantine-Group-root");
    expect(title?.className).toContain("mantine-Group-root");
    expect(screen.getByText("Quarterly report").className).toContain(
      "mantine-Text-root",
    );
    expect(screen.getByText(".pdf").className).toContain("mantine-Text-root");
  });

  test("renders unsupported-file feedback through a native centered Stack", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <AttachmentViewerErrorRoot>
          <span aria-hidden>file</span>
          <AttachmentViewerErrorTitle>
            Unable to preview this file
          </AttachmentViewerErrorTitle>
          <AttachmentViewerErrorMessage>
            .zip file type not supported.
          </AttachmentViewerErrorMessage>
          <AttachmentViewerErrorActions>
            <button type="button">Download</button>
          </AttachmentViewerErrorActions>
        </AttachmentViewerErrorRoot>
      </MyoxusUIProvider>,
    );

    const root = container.querySelector(
      '[data-myoxus-ui-role="attachment-viewer-root"]',
    );
    const error = container.querySelector(
      '[data-myoxus-ui-role="attachment-viewer-error-root"]',
    );
    const actions = container.querySelector(
      '[data-myoxus-ui-role="attachment-viewer-error-actions"]',
    );

    expect(root?.getAttribute("data-state")).toBeNull();
    expect(error?.className).toContain("mantine-Stack-root");
    expect(actions?.className).toContain("mantine-Stack-root");
    expect(screen.getByRole("heading", { level: 3 }).textContent).toContain(
      "Unable to preview this file",
    );
    expect(
      screen.getByText(".zip file type not supported.").className,
    ).toContain("mantine-Text-root");
  });
});
