/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const uploadTrigger = vi.fn().mockResolvedValue({});
const replaceTrigger = vi.fn().mockResolvedValue({});
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => en[key] ?? key,
    "com.myoxus.peek-view-controls.close": () =>
      en["com.myoxus.peek-view-controls.close"],
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

vi.mock("../api", () => ({
  useUploadPdfTemplateMutation: () => ({ trigger: uploadTrigger }),
  useReplacePdfTemplateBundleMutation: () => ({ trigger: replaceTrigger }),
}));

import { UploadTemplateDialog } from "./upload-template-dialog";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

function file(name: string, content: string, rel = name) {
  const f = new File([content], name, { type: "text/plain" }) as File & {
    webkitRelativePath?: string;
  };
  f.webkitRelativePath = `bundle/${rel}`;
  return f;
}

function dropFiles(files: File[]) {
  fireEvent.drop(screen.getByTestId("pdf-template-upload-target"), {
    dataTransfer: { files },
  });
}

function manifestJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "board-report",
    name: "Board Report",
    version: "1.0.0",
    schema_version: "2.0",
    provenance: {
      license_spdx: "AGPL-3.0-or-later",
      copyright_notice: "Copyright 2026 Example contributors",
      source_url: "https://example.test/board-report",
      source_revision: "1.0.0",
    },
    entry: "preamble.typ",
    assets: ["preamble.typ", "theme.typ"],
    ...overrides,
  };
}

describe("UploadTemplateDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadTrigger.mockResolvedValue({});
    replaceTrigger.mockResolvedValue({});
  });
  afterEach(() => cleanup());

  test("parses manifest.json and uploads aligned file paths", async () => {
    renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );

    const manifest = file("manifest.json", JSON.stringify(manifestJson()));
    const preamble = file("preamble.typ", "#let main = []");
    const theme = file("theme.typ", "#let brand = (:)");

    dropFiles([manifest, preamble, theme]);

    expect(await screen.findByText("Board Report")).toBeTruthy();
    fireEvent.click(
      screen.getByText(en["admin.pdf-export.upload.rights-confirmation"]),
    );
    fireEvent.click(screen.getByText(en["admin.pdf-export.upload.button"]));

    await waitFor(() => {
      expect(uploadTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          filePaths: ["preamble.typ", "theme.typ"],
          rightsConfirmed: true,
        }),
      );
    });
  });

  test("rejects bundles with missing manifest assets before upload", async () => {
    renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );

    const manifest = file(
      "manifest.json",
      JSON.stringify(
        manifestJson({
          id: "bad",
          name: "Bad",
        }),
      ),
    );
    dropFiles([manifest, file("preamble.typ", "#let main = []")]);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "theme.typ",
    );
    expect(uploadTrigger).not.toHaveBeenCalled();
  });

  test("rejects uploads without manifest.json", async () => {
    renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );

    dropFiles([file("preamble.typ", "#let main = []")]);

    expect((await screen.findByRole("alert")).textContent).toContain(
      en["admin.pdf-export.upload.error.no-manifest"],
    );
    expect(uploadTrigger).not.toHaveBeenCalled();
  });

  test("rejects manifests whose entry file is not declared as an asset", async () => {
    renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );

    const manifest = file(
      "manifest.json",
      JSON.stringify(
        manifestJson({
          id: "bad-entry",
          name: "Bad Entry",
          entry: "main.typ",
          assets: ["preamble.typ"],
        }),
      ),
    );

    dropFiles([manifest, file("preamble.typ", "#let main = []")]);

    expect((await screen.findByRole("alert")).textContent).toContain(
      'manifest.entry "main.typ" is not present in assets',
    );
    expect(uploadTrigger).not.toHaveBeenCalled();
  });

  test("requires legal provenance confirmation before upload", async () => {
    renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );
    dropFiles([
      file("manifest.json", JSON.stringify(manifestJson())),
      file("preamble.typ", "#let main = []"),
      file("theme.typ", "#let brand = (:)"),
    ]);

    await screen.findByText("Board Report");
    expect(
      screen.getByText(en["admin.pdf-export.upload.button"]).closest("button")
        ?.disabled,
    ).toBe(true);
  });

  test("replaces an existing bundle through the dedicated mutation", async () => {
    renderWithFacade(
      <UploadTemplateDialog
        onClose={vi.fn()}
        onUploaded={vi.fn()}
        replaceTemplate={{
          id: "template-id",
          slug: "board-report",
          version: "1.0.0",
        }}
      />,
    );
    dropFiles([
      file(
        "manifest.json",
        JSON.stringify(
          manifestJson({
            version: "1.1.0",
            provenance: {
              license_spdx: "AGPL-3.0-or-later",
              copyright_notice: "Copyright 2026 Example contributors",
              source_url: "https://example.test/board-report",
              source_revision: "1.1.0",
            },
          }),
        ),
      ),
      file("preamble.typ", "#let main = []"),
      file("theme.typ", "#let brand = (:)"),
    ]);
    expect(await screen.findByText("Board Report")).toBeTruthy();
    fireEvent.click(
      screen.getByText(en["admin.pdf-export.upload.rights-confirmation"]),
    );
    fireEvent.click(
      screen.getByText(en["admin.pdf-export.upload.replace-button"]),
    );

    await waitFor(() => {
      expect(replaceTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "template-id",
          rightsConfirmed: true,
          filePaths: ["preamble.typ", "theme.typ"],
        }),
      );
      expect(uploadTrigger).not.toHaveBeenCalled();
    });
  });

  test("rejects non-canonical camelCase schemaVersion manifests", async () => {
    renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );

    dropFiles([
      file(
        "manifest.json",
        JSON.stringify({
          ...manifestJson({
            id: "camel",
            name: "Camel",
            assets: ["preamble.typ"],
          }),
          schema_version: undefined,
          schemaVersion: "2.0",
        }),
      ),
      file("preamble.typ", "#let main = []"),
    ]);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "manifest.schema_version is required",
    );
  });

  test("rejects non-string manifest asset entries", async () => {
    renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );

    dropFiles([
      file(
        "manifest.json",
        JSON.stringify(
          manifestJson({
            id: "bad-assets",
            name: "Bad Assets",
            assets: ["preamble.typ", 42],
          }),
        ),
      ),
      file("preamble.typ", "#let main = []"),
    ]);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "manifest.assets entries must be strings",
    );
  });

  test("rejects invalid manifest schema before upload", async () => {
    renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );

    const manifest = file(
      "manifest.json",
      JSON.stringify({
        ...manifestJson({ id: "bad", assets: ["preamble.typ"] }),
        name: undefined,
      }),
    );

    dropFiles([manifest, file("preamble.typ", "#let main = []")]);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "manifest.name is required",
    );
    expect(uploadTrigger).not.toHaveBeenCalled();
  });

  test("surfaces invalid manifest JSON before upload", async () => {
    renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );

    dropFiles([
      file("manifest.json", "{"),
      file("preamble.typ", "#let main = []"),
    ]);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "manifest.json parse error",
    );
    expect(uploadTrigger).not.toHaveBeenCalled();
  });

  test("shows server slug-conflict and font-whitelist validation errors", async () => {
    uploadTrigger
      .mockRejectedValueOnce(new Error("Slug 'default' is reserved"))
      .mockRejectedValueOnce(new Error("required_fonts contains blocked font"));

    const validManifest = () =>
      file(
        "manifest.json",
        JSON.stringify(manifestJson({ assets: ["preamble.typ"] })),
      );

    const { unmount } = renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );
    dropFiles([validManifest(), file("preamble.typ", "#let main")]);
    expect(await screen.findByText("Board Report")).toBeTruthy();
    fireEvent.click(
      screen.getByText(en["admin.pdf-export.upload.rights-confirmation"]),
    );
    fireEvent.click(screen.getByText(en["admin.pdf-export.upload.button"]));
    await waitFor(() =>
      expect(notifyMock.error.mock.calls.at(-1)?.[0]?.title).toContain(
        "Slug 'default' is reserved",
      ),
    );
    unmount();

    renderWithFacade(
      <UploadTemplateDialog onClose={vi.fn()} onUploaded={vi.fn()} />,
    );
    dropFiles([validManifest(), file("preamble.typ", "#let main")]);
    expect(await screen.findByText("Board Report")).toBeTruthy();
    fireEvent.click(
      screen.getByText(en["admin.pdf-export.upload.rights-confirmation"]),
    );
    fireEvent.click(screen.getByText(en["admin.pdf-export.upload.button"]));
    await waitFor(() =>
      expect(notifyMock.error.mock.calls.at(-1)?.[0]?.title).toContain(
        "required_fonts contains blocked font",
      ),
    );
  });
});
