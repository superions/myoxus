// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { DatabaseFilePreview } from "./file-preview";

afterEach(cleanup);

describe("DatabaseFilePreview", () => {
  test("renders unsupported media truthfully with filename and metadata", () => {
    render(
      <MyoxusUIProvider>
        <DatabaseFilePreview
          file={{
            blobKey: "archive.zip",
            mime: "application/zip",
            name: "release.zip",
            size: 2048,
          }}
          workspaceId="workspace-1"
          locale="en"
          emptyLabel="No cover"
          errorLabel="Preview unavailable"
          retryLabel="Retry"
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("release.zip")).not.toBeNull();
    expect(
      screen.getByText("Preview unavailable · application/zip · 2,048 B"),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("exposes a retry action after an authenticated image request fails", () => {
    render(
      <MyoxusUIProvider>
        <DatabaseFilePreview
          file={{
            blobKey: "missing image.png",
            mime: "image/png",
            name: "missing.png",
            size: 512,
          }}
          workspaceId="workspace-1"
          locale="en"
          emptyLabel="No cover"
          errorLabel="Preview unavailable"
          retryLabel="Retry"
        />
      </MyoxusUIProvider>,
    );

    const image = screen.getByRole("img", { name: "missing.png" });
    expect(image.getAttribute("src")).toContain("missing%20image.png");
    fireEvent.error(image);
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("img", { name: "missing.png" })).not.toBeNull();
  });
});
