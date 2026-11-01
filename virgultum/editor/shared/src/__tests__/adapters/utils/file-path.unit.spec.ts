import { describe, expect, it } from "vitest";

import {
  getImageFullPath,
  normalizeMarkdownSourcePath,
  resolveMarkdownRelativePath,
} from "../../../adapters/utils/file-path";

describe("Markdown source paths", () => {
  it("normalizes safe nested, parent and Unicode paths", () => {
    expect(normalizeMarkdownSourcePath("guides/./über/../ziel.md")).toBe(
      "guides/ziel.md",
    );
    expect(
      resolveMarkdownRelativePath("guides/deep/source.md", "../../ziel.md"),
    ).toBe("ziel.md");
    expect(
      resolveMarkdownRelativePath("guides/source.md", "../文档/目标.md"),
    ).toBe("文档/目标.md");
    expect(
      resolveMarkdownRelativePath(
        "quelle/source.md",
        "../ziele/%C3%BCber/target.md",
      ),
    ).toBe("ziele/über/target.md");
  });

  it.each([
    "/root.md",
    "C:\\root.md",
    "\\\\server\\share.md",
    "../outside.md",
    "nested%2Ftarget.md",
    "nested%5Ctarget.md",
    "nested%252Ftarget.md",
  ])("rejects unsafe source path %s", (path) => {
    expect(normalizeMarkdownSourcePath(path)).toBeUndefined();
  });

  it.each(["/root.md", "../../../outside.md"])(
    "rejects unsafe relative target %s",
    (target) => {
      expect(
        resolveMarkdownRelativePath("guides/source.md", target),
      ).toBeUndefined();
    },
  );
});

describe("getImageFullPath", () => {
  it("should resolve relative image paths correctly", () => {
    const filePath = "path/to/markdown/file.md";

    // Test relative path in same directory
    expect(getImageFullPath(filePath, "image.png")).toBe(
      "path/to/markdown/image.png",
    );

    // Test relative path in subdirectory
    expect(getImageFullPath(filePath, "images/photo.jpg")).toBe(
      "path/to/markdown/images/photo.jpg",
    );

    // Test relative path in subdirectory
    expect(getImageFullPath(filePath, "./images/photo.jpg")).toBe(
      "path/to/markdown/images/photo.jpg",
    );

    // Test relative path with parent directory
    expect(getImageFullPath(filePath, "../images/photo.jpg")).toBe(
      "path/to/images/photo.jpg",
    );

    // Test relative path with multiple parent directories
    expect(getImageFullPath(filePath, "../../images/photo.jpg")).toBe(
      "path/images/photo.jpg",
    );

    // Test relative path with multiple parent directories (which is not supported)
    expect(getImageFullPath(filePath, "../../../../images/photo.jpg")).toBe(
      "images/photo.jpg",
    );
  });

  it("should handle absolute image paths correctly", () => {
    const filePath = "path/to/markdown/file.md";

    // Test absolute path
    expect(getImageFullPath(filePath, "/images/photo.jpg")).toBe(
      "images/photo.jpg",
    );
  });

  it("should handle URL-encoded image paths correctly", () => {
    const filePath = "path/to/markdown/file.md";

    // Test URL-encoded spaces
    expect(getImageFullPath(filePath, "my%20photo.jpg")).toBe(
      "path/to/markdown/my photo.jpg",
    );
  });
});
