// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import keywords from "@myoxus/icons/keywords/en";
import * as allIcons from "@myoxus/icons/react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dataLoads = vi.hoisted(() => ({ emoji: vi.fn(), keywords: vi.fn() }));
vi.mock("./helpers/icon-picker-data", () => ({
  loadEmojiGroups: dataLoads.emoji,
  loadIconKeywords: dataLoads.keywords,
}));

import {
  DocumentIconTitleSlot,
  IconEditor,
  IconEditorPlaceholder,
  IconEditorTriggerFrame,
  IconPicker,
} from "./icon-picker";
import { IconType } from "./helpers/icon-data";
import { MyoxusUIProvider } from "./provider";

const repoRoot = process.cwd();
const emojiGroupKeys = [
  "com.myoxus.icon-picker.emoji-group.activity",
  "com.myoxus.icon-picker.emoji-group.animals-nature",
  "com.myoxus.icon-picker.emoji-group.flags",
  "com.myoxus.icon-picker.emoji-group.food-drink",
  "com.myoxus.icon-picker.emoji-group.objects",
  "com.myoxus.icon-picker.emoji-group.smileys-people",
  "com.myoxus.icon-picker.emoji-group.symbols",
  "com.myoxus.icon-picker.emoji-group.travel-places",
];
type IconKeyword = {
  name: string;
  keywords: string[];
};

function readResource(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(
      join(repoRoot, `client/libs/i18n/src/resources/${locale}.json`),
      "utf8",
    ),
  ) as Record<string, string>;
}

describe("icon picker visual contract", () => {
  beforeEach(() => {
    dataLoads.emoji.mockReset().mockResolvedValue([
      {
        name: "Animals & Nature",
        emojis: [{ label: "cat face", unicode: "🐱", hexcode: "" }],
      },
    ]);
    dataLoads.keywords
      .mockReset()
      .mockResolvedValue([{ name: "Bold", keywords: ["strong"] }]);
    vi.stubGlobal("localStorage", new window.Storage());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("maps bundled Myoxus icon keywords to shipped React icons", () => {
    const iconGroups = Object.values(
      keywords as Record<string, IconKeyword[] | undefined>,
    ).filter((group): group is IconKeyword[] => Array.isArray(group));
    const iconNames = iconGroups.flatMap((group) =>
      group.map((icon) => icon.name),
    );

    expect(iconGroups.length).toBeGreaterThan(1);
    expect(iconNames).toContain("Bold");
    expect(iconNames).toContain("AllDocs");
    for (const iconName of iconNames) {
      expect(`${iconName}Icon` in allIcons, iconName).toBe(true);
    }
  });

  test("keeps color choices inside the owning picker and commits the selected color", async () => {
    const select = vi.fn();
    const view = render(
      <MyoxusUIProvider>
        <IconPicker onSelect={select} />
      </MyoxusUIProvider>,
    );
    fireEvent.click(
      screen.getByRole("radio", { name: /Icons|icon-picker.icons/ }),
    );
    await screen.findByRole("button", { name: "Bold" });
    fireEvent.click(
      screen.getByRole("button", { name: /Icon color|icon-picker.icon-color/ }),
    );
    const color = "var(--myoxus-text-highlight-foreground-purple)";
    const choice = await screen.findByRole("button", { name: color });
    expect(view.container.contains(choice)).toBe(true);
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(select).toHaveBeenCalledWith({
      type: IconType.MyoxusIcon,
      name: "Bold",
      color,
    });
  });

  test("does not render the removed emoji skin-tone clap control", () => {
    const source = readFileSync(
      join(repoRoot, "client/libs/ui-facade/src/icon-picker.tsx"),
      "utf8",
    );

    expect(source).not.toContain("Emoji skin tone");
    expect(source).not.toContain("skinTone");
  });

  test("emoji group names are translated in primary European locales", () => {
    for (const locale of ["de", "en", "es", "fr", "it"]) {
      const resource = readResource(locale);
      for (const key of emojiGroupKeys) {
        expect(resource[key], `${locale}:${key}`).toEqual(
          expect.stringMatching(/\S/),
        );
      }
    }
  });

  test("projects document title icon chrome through facade trigger roles", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <DocumentIconTitleSlot hasIcon={false} data-testid="title-slot">
          <IconEditor
            triggerVariant="document-title-placeholder"
            iconPlaceholder={
              <IconEditorPlaceholder icon={<span data-testid="doc-icon" />}>
                Add icon
              </IconEditorPlaceholder>
            }
          />
        </DocumentIconTitleSlot>
        <IconEditorTriggerFrame
          data-testid="readonly-trigger"
          iconType="emoji"
          variant="document-title"
        >
          ✓
        </IconEditorTriggerFrame>
      </MyoxusUIProvider>,
    );

    const editableTrigger = container.querySelector(
      "button.myoxus-icon-name-editor__trigger--document-title-placeholder",
    );
    expect(screen.getByTestId("title-slot").dataset.hasIcon).toBe("false");
    expect(editableTrigger).not.toBeNull();
    expect(editableTrigger?.className).toContain(
      "myoxus-icon-name-editor__trigger--document-title",
    );
    expect(screen.getByTestId("readonly-trigger").dataset.iconType).toBe(
      "emoji",
    );
    expect(screen.getByTestId("readonly-trigger").className).toContain(
      "myoxus-icon-name-editor__trigger--document-title",
    );
    expect(screen.getByTestId("doc-icon")).not.toBeNull();
  });

  test("retains search during delayed emoji loading and delivers the selected value", async () => {
    const pending = Promise.withResolvers<unknown>();
    dataLoads.emoji.mockReturnValue(pending.promise);
    const select = vi.fn();
    render(
      <MyoxusUIProvider>
        <IconPicker onSelect={select} />
      </MyoxusUIProvider>,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "cat" } });
    expect(screen.getByRole("status")).not.toBeNull();
    expect(select).not.toHaveBeenCalled();
    await act(async () =>
      pending.resolve([
        {
          name: "Animals & Nature",
          emojis: [
            { label: "cat face", unicode: "🐱", hexcode: "" },
            { label: "dog face", unicode: "🐶", hexcode: "" },
          ],
        },
      ]),
    );
    expect(screen.getByRole("textbox")).toHaveProperty("value", "cat");
    expect(screen.queryByRole("button", { name: "dog face" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "cat face" }));
    expect(select).toHaveBeenCalledWith({
      type: IconType.Emoji,
      unicode: "🐱",
    });
    expect(dataLoads.keywords).not.toHaveBeenCalled();
  });
});

describe("shared catalogue demand and recovery", () => {
  const releases: Array<() => void> = [];
  beforeEach(() => {
    vi.resetModules();
    dataLoads.emoji.mockReset().mockResolvedValue([
      {
        name: "Animals & Nature",
        emojis: [{ label: "cat face", unicode: "🐱", hexcode: "" }],
      },
    ]);
    dataLoads.keywords
      .mockReset()
      .mockResolvedValue([{ name: "Bold", keywords: ["strong"] }]);
    vi.stubGlobal("localStorage", new window.Storage());
  });
  afterEach(async () => {
    await act(async () => {
      for (const release of releases.splice(0)) release();
    });
    cleanup();
    vi.doUnmock("@myoxus/icons/catalog");
    vi.unstubAllGlobals();
  });
  function delay() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.push(release);
    return { promise, release };
  }
  async function consumers() {
    return {
      picker: await import("./icon-picker"),
      renderer: await import("./helpers/icon-renderer"),
      loader: await import("./helpers/icon-catalog"),
    };
  }
  async function openIcons() {
    fireEvent.click(
      await screen.findByRole("radio", { name: /Icons|icon-picker.icons/ }),
    );
  }

  test("an explicit picker retry refreshes previously failed mounted icons and retains search/focus", async () => {
    const rejected = vi.fn(() => {
      throw new Error("Catalogue delivery rejected");
    });
    vi.doMock("@myoxus/icons/catalog", rejected);
    const { picker, renderer, loader } = await consumers();
    render(
      <MyoxusUIProvider>
        <div data-testid="named">
          <renderer.IconRenderer
            data={{
              type: IconType.MyoxusIcon,
              name: "Bold",
              color: "currentColor",
            }}
            size="var(--glyph-size)"
          />
        </div>
        <picker.IconPicker />
      </MyoxusUIProvider>,
    );
    await openIcons();
    await screen.findByRole("alert");
    expect(loader.getIconCatalogSnapshot().status).toBe("error");
    const disposed = render(
      <renderer.IconRenderer
        data={{
          type: IconType.MyoxusIcon,
          name: "Bold",
          color: "currentColor",
        }}
      />,
    );
    const search = screen.getByRole("textbox");
    fireEvent.change(search, { target: { value: "strong" } });
    expect(
      screen.getByTestId("named").querySelector("svg")?.getAttribute("width"),
    ).toBe("1em");
    expect(screen.getByTestId("named").querySelector("svg")?.style.width).toBe(
      "var(--glyph-size)",
    );
    const gate = delay();
    const recovered = vi.fn(async () => {
      await gate.promise;
      return allIcons;
    });
    vi.doMock("@myoxus/icons/catalog", recovered);
    fireEvent.click(screen.getByRole("button", { name: /Retry|Wiederholen/ }));
    expect(document.activeElement).toBe(search);
    disposed.unmount();
    expect((search as HTMLInputElement).value).toBe("strong");
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce());
    await act(async () => gate.release());
    await screen.findByRole("button", { name: "Bold", hidden: true });
    expect(
      screen.getByTestId("named").querySelectorAll("svg path"),
    ).toHaveLength(2);
    expect(loader.getIconCatalogSnapshot().status).toBe("ready");
    expect((search as HTMLInputElement).value).toBe("strong");
  });
});
