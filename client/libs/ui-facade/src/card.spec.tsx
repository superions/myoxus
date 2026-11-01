// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  Badge,
  BadgeList,
  BadgeListItem,
  CanvasOverlayTitleIcon,
  CanvasOverlayTitleSlot,
  CanvasOverlayTitleText,
  CanvasOverlayToolbar,
  Card,
  ColorSwatch,
  commentEditorViewportClassName,
  DisclosureCard,
  DisclosureCardTrigger,
  DocumentEditorBlankGap,
  documentEditorContentClassName,
  DocumentEditorEdgelessViewport,
  DocumentEditorPageViewport,
  DocumentEditorRoot,
  DocumentHeaderImage,
  DocumentTitleRow,
  EditorOutlineFloatingFrame,
  EmptyStateTitle,
  FilterBar,
  FilterBarSpacer,
  FilterChip,
  FilterChipSegment,
  FilterChipTrigger,
  FilterChipValueSlot,
  FloatingActionDock,
  FloatingActionTrigger,
  HorizontalPanelRail,
  HorizontalPanelRailAction,
  HorizontalPanelRailItem,
  JournalDocumentDayTag,
  Menu,
  MenuItem,
  PageContentRail,
  RemovableBadge,
  resolveTagColorAccent,
  SurfaceList,
  SurfaceListAction,
  SurfaceListCardHeader,
  SurfaceListDragHandle,
  SurfaceListItem,
  SurfaceListItemFrame,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListMeta,
  SurfaceListSelectionSlot,
  SurfaceListSpacer,
  SurfaceListText,
  ToolbarSurface,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

describe("Card facade primitive", () => {
  test("uses group semantics unless callers provide true list items", () => {
    render(
      <MyoxusUIProvider>
        <SurfaceList label="Interactive rows">
          <button type="button">Open row</button>
        </SurfaceList>
        <SurfaceList label="Semantic list" role="list">
          <div role="listitem">Metadata row</div>
        </SurfaceList>
      </MyoxusUIProvider>,
    );

    expect(
      screen
        .getByRole("group", { name: "Interactive rows" })
        .getAttribute("role"),
    ).toBe("group");
    expect(
      screen.getByRole("list", { name: "Semantic list" }).getAttribute("role"),
    ).toBe("list");
  });

  test("can render semantic section cards for Admin surface adapters", () => {
    render(
      <MyoxusUIProvider>
        <Card component="section" aria-label="Surface contract">
          Body
        </Card>
      </MyoxusUIProvider>,
    );

    const card = screen.getByRole("region", { name: "Surface contract" });
    expect(card.tagName).toBe("SECTION");
    expect(card.dataset.myoxusUiRole).toBe("card");
  });

  test("passes semantic padding through Mantine instead of overriding it with zero padding", () => {
    render(
      <MyoxusUIProvider>
        <Card data-testid="card" padding="md">
          Body
        </Card>
      </MyoxusUIProvider>,
    );

    const card = screen.getByTestId("card");
    expect(card.getAttribute("style")).not.toContain("padding: 0");
  });
});

describe("Surface list facade primitive", () => {
  test("mixes normalized tag accents deterministically at the Facade boundary", () => {
    expect(resolveTagColorAccent([])).toBeUndefined();
    expect(resolveTagColorAccent(["tag.red"])).toBe(
      "var(--myoxus-palette-line-red)",
    );
    expect(resolveTagColorAccent(["tag.red", "tag.red"])).toBe(
      resolveTagColorAccent(["tag.red"]),
    );
    expect(resolveTagColorAccent(["tag.red", "tag.blue"])).toBe(
      resolveTagColorAccent(["tag.blue", "tag.red"]),
    );
    expect(resolveTagColorAccent(["tag.red", "tag.blue"])).toContain(
      "color-mix",
    );
    expect(resolveTagColorAccent(["unknown" as "tag.red"])).toBeUndefined();
  });

  test("can render surfaced row actions without product CSS tiles", () => {
    render(
      <MyoxusUIProvider>
        <SurfaceListAction surface data-testid="action">
          Attachment
        </SurfaceListAction>
        <SurfaceListAction
          component="div"
          role="button"
          surface
          tabIndex={0}
          data-testid="composite-action"
        >
          Composite attachment
        </SurfaceListAction>
        <SurfaceListAction
          component="div"
          mediaPreview="file"
          overlayAction={<span data-testid="preview-overlay">Remove</span>}
          role="button"
          surface
          tabIndex={0}
          data-testid="preview-action"
        >
          Preview attachment
        </SurfaceListAction>
      </MyoxusUIProvider>,
    );

    const action = screen.getByRole("button", { name: "Attachment" });
    expect(action).toBe(screen.getByTestId("action"));
    expect(action.dataset.myoxusUiRole).toBe("button:surface-list-action");
    expect(action.getAttribute("style")).toContain(
      "--myoxus-background-secondary-color",
    );

    const compositeAction = screen.getByRole("button", {
      name: "Composite attachment",
    });
    expect(compositeAction.tagName).toBe("DIV");
    expect(compositeAction).toBe(screen.getByTestId("composite-action"));
    expect(compositeAction.dataset.myoxusUiRole).toBe(
      "button:surface-list-action",
    );

    const previewAction = screen.getByTestId("preview-action");
    expect(previewAction.getAttribute("style")).toContain("62px");
    expect(previewAction.getAttribute("style")).toContain("194px");
    expect(previewAction.getAttribute("style")).toContain("position: relative");
    expect(
      screen.getByTestId("preview-overlay").parentElement?.dataset,
    ).toMatchObject({
      myoxusUiRole: "surface-list-action-overlay-action",
    });
    expect(
      screen
        .getByTestId("preview-overlay")
        .parentElement?.getAttribute("style"),
    ).toContain("-6px");
  });

  test("exposes shared row composition roles for product list migrations", () => {
    render(
      <MyoxusUIProvider>
        <SurfaceListItemFrame data-testid="frame">
          <SurfaceListItem
            appearance="card"
            density="card"
            fullHeight
            fullWidth
            interactive
            layout="column"
            data-testid="item"
          >
            <SurfaceListDragHandle data-testid="drag">
              Drag
            </SurfaceListDragHandle>
            <SurfaceListCardHeader data-testid="header">
              <SurfaceListItemIcon data-testid="icon">I</SurfaceListItemIcon>
              <SurfaceListText kind="card-title" data-testid="title">
                Title
              </SurfaceListText>
            </SurfaceListCardHeader>
            <SurfaceListItemMain data-testid="main">
              <SurfaceListText kind="description" data-testid="description">
                Description
              </SurfaceListText>
            </SurfaceListItemMain>
            <SurfaceListMeta layout="card" data-testid="meta">
              <Badge
                data-testid="pill"
                prefix={<span data-testid="badge-prefix" />}
              >
                Property
              </Badge>
            </SurfaceListMeta>
            <SurfaceListSpacer data-testid="spacer" />
            <SurfaceListSelectionSlot active data-testid="selection">
              Select
            </SurfaceListSelectionSlot>
          </SurfaceListItem>
        </SurfaceListItemFrame>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("frame").dataset.myoxusUiRole).toBe(
      "surface-list-item-frame",
    );
    expect(screen.getByTestId("item").dataset.surfaceAppearance).toBe("card");
    expect(screen.getByTestId("item").getAttribute("style")).toContain(
      "var(--mantine-spacing-lg)",
    );
    expect(screen.getByTestId("drag").dataset.myoxusUiRole).toBe(
      "surface-list-drag-handle",
    );
    expect(screen.getByTestId("header").dataset.myoxusUiRole).toBe(
      "surface-list-card-header",
    );
    expect(screen.getByTestId("icon").dataset.myoxusUiRole).toBe(
      "surface-list-item-icon",
    );
    expect(screen.getByTestId("title").dataset.myoxusUiRole).toBe(
      "surface-list-text:card-title",
    );
    expect(screen.getByTestId("meta").dataset.myoxusUiRole).toBe(
      "surface-list-meta:card",
    );
    expect(screen.getByTestId("pill").dataset.myoxusUiRole).toBe(
      "badge:neutral",
    );
    expect(screen.getByTestId("selection").dataset.active).toBe("true");
  });

  test("keeps horizontal work panels readable inside a scrolling Mantine rail", () => {
    render(
      <MyoxusUIProvider>
        <HorizontalPanelRail data-testid="rail">
          <HorizontalPanelRailItem data-testid="panel">
            Panel
          </HorizontalPanelRailItem>
          <HorizontalPanelRailAction data-testid="action">
            Action
          </HorizontalPanelRailAction>
        </HorizontalPanelRail>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("rail").dataset.myoxusUiRole).toBe(
      "horizontal-panel-rail",
    );
    expect(screen.getByTestId("panel").style.flex).toBe("0 0 auto");
    expect(screen.getByTestId("action").style.flex).toBe("0 0 auto");
  });
});

describe("Filter chip facade primitive", () => {
  test("keeps filter builder chrome on native Mantine primitives", () => {
    render(
      <MyoxusUIProvider>
        <FilterBar data-testid="bar" wrap={false}>
          <FilterChip draft data-testid="chip">
            <FilterChipSegment icon={<span data-testid="icon" />}>
              Status
            </FilterChipSegment>
            <FilterChipTrigger data-testid="method">is</FilterChipTrigger>
            <FilterChipValueSlot data-testid="value">
              <FilterChipTrigger data-testid="value-trigger">
                Open
              </FilterChipTrigger>
            </FilterChipValueSlot>
          </FilterChip>
          <FilterBarSpacer data-testid="spacer" />
        </FilterBar>
      </MyoxusUIProvider>,
    );

    const bar = screen.getByTestId("bar");
    const chip = screen.getByTestId("chip");
    const spacer = screen.getByTestId("spacer");
    const method = screen.getByRole("button", { name: "is" });
    const value = screen.getByTestId("value");

    expect(bar.dataset.myoxusUiRole).toBe("filter-bar");
    expect(bar.getAttribute("style")).not.toContain(
      "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
    );
    expect(spacer.dataset.myoxusUiRole).toBe("filter-bar-spacer");
    expect(spacer.getAttribute("style")).toContain("flex-grow: 1");
    expect(spacer.getAttribute("style")).toContain("flex-shrink: 1");
    expect(spacer.getAttribute("style")).toContain("flex-basis: auto");
    expect(chip.dataset.myoxusUiRole).toBe("filter-chip");
    expect(chip.dataset.draft).toBe("true");
    expect(chip.getAttribute("style")).not.toContain("--myoxus-border-color");
    expect(screen.getByTestId("icon").parentElement?.dataset.myoxusUiRole).toBe(
      "filter-chip-icon",
    );
    expect(method.dataset.myoxusUiRole).toBe("filter-chip-trigger");
    expect(method.dataset.tone).toBe("secondary");
    expect(method.getAttribute("style") ?? "").not.toContain(
      "var(--mantine-spacing-xl)",
    );
    fireEvent.focus(method);
    expect(method.getAttribute("style") ?? "").not.toContain(
      "--myoxus-hover-color",
    );
    expect(value.dataset.myoxusUiRole).toBe("filter-chip-value-slot");
  });
});

describe("Color swatch facade primitive", () => {
  test("can render circular indicators without product-local radius CSS", () => {
    render(
      <MyoxusUIProvider>
        <ColorSwatch
          aria-label="Tag color"
          color="#148f77"
          shape="circle"
          size="var(--mantine-spacing-xs)"
        />
      </MyoxusUIProvider>,
    );

    const swatch = screen.getByLabelText("Tag color");
    expect(swatch.dataset.myoxusUiRole).toBe("color-swatch");
    expect(swatch.getAttribute("style")).toContain("var(--mantine-radius-xl)");
    expect(swatch.getAttribute("style")).toContain("var(--mantine-spacing-xs)");
  });
});

describe("Badge facade primitives", () => {
  test("compose removable inline chips without product-local chip CSS", () => {
    render(
      <MyoxusUIProvider>
        <BadgeList data-testid="badges">
          <BadgeListItem grow data-testid="slot">
            <RemovableBadge
              data-tag-id="alice"
              prefix={<span aria-hidden="true">A</span>}
              removeLabel="Remove Alice"
              selected
              onRemove={() => {}}
              data-testid="chip"
            >
              Alice
            </RemovableBadge>
          </BadgeListItem>
        </BadgeList>
      </MyoxusUIProvider>,
    );

    const list = screen.getByTestId("badges");
    const slot = screen.getByTestId("slot");
    const chip = screen.getByTestId("chip");
    expect(list.dataset.myoxusUiRole).toBe("badge-list");
    expect(slot.dataset.myoxusUiRole).toBe("badge-list-item");
    expect(slot.getAttribute("style")).toContain("flex-grow: 1");
    expect(slot.getAttribute("style")).toContain("flex-shrink: 1");
    expect(chip.dataset.selected).toBe("true");
    expect(chip.dataset.tagId).toBe("alice");
    expect(chip.getAttribute("style")).toContain("--myoxus-primary-color");
    expect(
      chip.querySelector("[data-myoxus-ui-role='removable-badge-prefix']"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove Alice" })).not.toBeNull();
  });

  test("uses native badge sections for non-removable metadata prefixes", () => {
    render(
      <MyoxusUIProvider>
        <Badge prefix={<span data-testid="prefix" />}>Tagged</Badge>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("prefix")).not.toBeNull();
    expect(
      screen
        .getByText("Tagged")
        .closest("[data-myoxus-ui-role='badge:neutral']"),
    ).not.toBeNull();
  });

  test("projects semantic workspace tag roles without product theme imports", () => {
    render(
      <MyoxusUIProvider>
        <RemovableBadge tagColorRole="tag.purple" data-testid="tag-badge">
          Planning
        </RemovableBadge>
        <ColorSwatch tagColorRole="tag.purple" data-testid="tag-swatch" />
      </MyoxusUIProvider>,
    );

    const badge = screen.getByTestId("tag-badge");
    const swatch = screen.getByTestId("tag-swatch");
    expect(badge.dataset.myoxusUiRole).toBe("badge:tag.purple");
    expect(badge.style.backgroundColor).toContain("--myoxus-tag-purple");
    expect(swatch.style.backgroundColor).toContain(
      "--myoxus-palette-line-purple",
    );
    expect(badge.style.maxWidth).toBe("100%");
    expect(badge.style.overflow).toBe("hidden");
    expect((badge.firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  test("keeps bounded chip-list overflow in the facade instead of product CSS", () => {
    render(
      <MyoxusUIProvider>
        <BadgeList data-testid="chips" grow maxHeight="compact" scrollable>
          <BadgeListItem>
            <Badge>Alice</Badge>
          </BadgeListItem>
        </BadgeList>
      </MyoxusUIProvider>,
    );

    const list = screen.getByTestId("chips");
    expect(list.dataset.scrollable).toBe("true");
    expect(list.getAttribute("style")).toContain(
      "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))",
    );
    expect(list.getAttribute("style")).toContain("overflow-y: auto");
    expect(list.getAttribute("style")).toContain("flex-grow: 1");
    expect(list.getAttribute("style")).toContain("flex-shrink: 1");
    expect(list.firstElementChild?.getAttribute("style")).toContain(
      "max-width: 100%",
    );
  });

  test("keeps custom badge-list roles for product diagnostics", () => {
    render(
      <MyoxusUIProvider>
        <BadgeList
          data-testid="diagnostic-chips"
          data-myoxus-ui-role="diagnostic-chip-list"
        >
          <BadgeListItem>
            <Badge>One</Badge>
          </BadgeListItem>
        </BadgeList>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("diagnostic-chips").dataset.myoxusUiRole).toBe(
      "diagnostic-chip-list",
    );
  });
});

describe("Surface chrome facade primitives", () => {
  test("MenuItem keeps semantic role overrides inside dropdown menus", async () => {
    render(
      <MyoxusUIProvider>
        <Menu
          items={
            <MenuItem
              data-myoxus-ui-role="filter-menu-favorite-option"
              data-testid="favorite-option"
            >
              Favorite
            </MenuItem>
          }
        >
          <button type="button">Open</button>
        </Menu>
      </MyoxusUIProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(
      (await screen.findByTestId("favorite-option")).dataset.myoxusUiRole,
    ).toBe("filter-menu-favorite-option");
  });

  test("PageContentRail exposes native facade layout state without CSS modifier classes", () => {
    render(
      <MyoxusUIProvider>
        <PageContentRail fill centerContent data-testid="rail">
          Body
        </PageContentRail>
        <PageContentRail width="editor" data-testid="editor-rail">
          Editor
        </PageContentRail>
        <PageContentRail subnav data-testid="subnav-rail">
          Subnav
        </PageContentRail>
      </MyoxusUIProvider>,
    );

    const rail = screen.getByTestId("rail");
    expect(rail.dataset.myoxusUiRole).toBe("page-content-rail");
    expect(rail.dataset.fill).toBe("true");
    expect(rail.dataset.centerContent).toBe("true");
    expect(rail.classList.contains("org-stagger")).toBe(false);
    const editorRail = screen.getByTestId("editor-rail");
    expect(editorRail.dataset.width).toBe("editor");
    expect(editorRail.getAttribute("style")).toContain(
      "max-width: var(--myoxus-editor-width)",
    );
    expect(editorRail.getAttribute("style")).toContain(
      "padding-left: var(--myoxus-editor-content-padding-inline)",
    );
    expect(editorRail.getAttribute("style")).toContain(
      "padding-right: var(--myoxus-editor-content-padding-inline)",
    );
    expect(screen.getByTestId("subnav-rail").dataset.subnav).toBe("true");
  });

  test("DocumentTitleRow exposes the facade-owned editor title bridge", () => {
    render(
      <MyoxusUIProvider>
        <DocumentTitleRow data-testid="title-row">
          <span className="doc-icon-container" data-has-icon="false" />
          <span>Title</span>
        </DocumentTitleRow>
      </MyoxusUIProvider>,
    );

    const row = screen.getByTestId("title-row");
    expect(row.dataset.myoxusUiRole).toBe("document-title-row");
    expect(row.classList.contains("myoxus-document-title-row")).toBe(true);
    expect(row.querySelector(".doc-icon-container")).not.toBeNull();
  });

  test("document editor viewport roles keep Virgultum chrome in the facade", () => {
    render(
      <MyoxusUIProvider>
        <DocumentEditorRoot mode="page" readingSize={18} data-testid="root">
          <DocumentEditorPageViewport data-testid="page-viewport">
            <div className={documentEditorContentClassName}>Content</div>
            <DocumentEditorBlankGap data-testid="blank-gap" />
          </DocumentEditorPageViewport>
        </DocumentEditorRoot>
        <DocumentEditorRoot mode="edgeless" data-testid="edgeless-root">
          <DocumentEditorEdgelessViewport data-testid="edgeless-viewport" />
        </DocumentEditorRoot>
        <JournalDocumentDayTag data-testid="journal-day">
          Monday
        </JournalDocumentDayTag>
      </MyoxusUIProvider>,
    );

    const root = screen.getByTestId("root");
    expect(root.dataset.myoxusUiRole).toBe("document-editor-root");
    expect(root.dataset.myoxusEditorContainer).toBe("");
    expect(root.dataset.editorMode).toBe("page");
    expect(root.classList.contains("editor-wrapper")).toBe(true);
    expect(root.classList.contains("page-mode")).toBe(true);
    expect(root.classList.contains("myoxus-document-editor-root")).toBe(true);
    expect(root.style.getPropertyValue("--myoxus-document-reading-size")).toBe(
      "18px",
    );
    expect(root.style.getPropertyValue("--myoxus-font-family")).toBe("");
    expect(screen.getByTestId("page-viewport").dataset.myoxusUiRole).toBe(
      "document-editor-page-viewport",
    );
    expect(screen.getByTestId("blank-gap").dataset.myoxusUiRole).toBe(
      "document-editor-blank-gap",
    );
    expect(
      screen
        .getByTestId("edgeless-viewport")
        .classList.contains("myoxus-document-editor-edgeless-viewport"),
    ).toBe(true);
    expect(screen.getByTestId("journal-day").dataset.myoxusUiRole).toBe(
      "journal-document-day-tag",
    );
  });

  test("editor outline floating frame exposes a facade-owned mount role", () => {
    render(
      <MyoxusUIProvider>
        <EditorOutlineFloatingFrame data-testid="outline-frame" />
      </MyoxusUIProvider>,
    );

    const frame = screen.getByTestId("outline-frame");
    expect(frame.dataset.myoxusUiRole).toBe("editor-outline-floating-frame");
    expect(frame.className).toContain("myoxus-editor-outline-floating-frame");
  });

  test("comment editor viewport class is facade-owned for Virgultum embedding", () => {
    expect(commentEditorViewportClassName).toBe(
      "myoxus-comment-editor-viewport",
    );
  });

  test("DocumentHeaderImage keeps document media sizing in the facade", () => {
    render(
      <MyoxusUIProvider>
        <DocumentHeaderImage
          data-testid="document-header-image"
          src="/header.png"
          alt="Header"
        />
      </MyoxusUIProvider>,
    );

    const image = screen.getByTestId("document-header-image");
    expect(image.dataset.myoxusUiRole).toBe("document-header-image");
    expect(image.getAttribute("src")).toBe("/header.png");
    expect(image.style.objectFit).toBe("cover");
    expect(image.style.width).toBe("100%");
    expect(image.style.maxHeight).toBe(
      "calc(calc(var(--mantine-spacing-2xl) * 2) * 4)",
    );
  });

  test("EmptyStateTitle owns icon/title grouping for empty states", () => {
    render(
      <MyoxusUIProvider>
        <EmptyStateTitle icon={<span data-testid="empty-icon" />}>
          Empty title
        </EmptyStateTitle>
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Empty title")).not.toBeNull();
    expect(screen.getByTestId("empty-icon")).not.toBeNull();
    expect(
      document.querySelector('[data-myoxus-ui-role="empty-state-title:icon"]'),
    ).not.toBeNull();
  });

  test("ToolbarSurface exposes one shared action-group role", () => {
    render(
      <MyoxusUIProvider>
        <ToolbarSurface data-testid="toolbar">
          <button type="button">Action</button>
        </ToolbarSurface>
      </MyoxusUIProvider>,
    );

    const toolbar = screen.getByTestId("toolbar");
    expect(toolbar.dataset.myoxusUiRole).toBe("toolbar-surface");
    expect(toolbar.className).toContain("myoxus-ui-toolbar-surface");
    expect(toolbar.className).toContain("mantine-Card-root");
    expect(
      toolbar.querySelector('[data-myoxus-ui-role="toolbar-surface-content"]')
        ?.className,
    ).toContain("mantine-Group-root");
  });

  test("CanvasOverlayToolbar owns transparent canvas overlay chrome", () => {
    render(
      <MyoxusUIProvider>
        <CanvasOverlayToolbar data-testid="toolbar">
          <CanvasOverlayTitleSlot data-testid="title-slot">
            <CanvasOverlayTitleIcon data-testid="title-icon">
              I
            </CanvasOverlayTitleIcon>
            <CanvasOverlayTitleText emphasis="strong">
              Canvas title
            </CanvasOverlayTitleText>
          </CanvasOverlayTitleSlot>
          <button type="button">Action</button>
        </CanvasOverlayToolbar>
      </MyoxusUIProvider>,
    );

    const toolbar = screen.getByTestId("toolbar");
    expect(toolbar.dataset.myoxusUiRole).toBe("canvas-overlay-toolbar");
    expect(toolbar.classList.contains("myoxus-canvas-overlay-toolbar")).toBe(
      true,
    );
    expect(screen.getByTestId("title-slot").dataset.myoxusUiRole).toBe(
      "canvas-overlay-title-slot",
    );
    expect(screen.getByTestId("title-icon").dataset.myoxusUiRole).toBe(
      "canvas-overlay-title-icon",
    );
    expect(screen.getByText("Canvas title").dataset.emphasis).toBe("strong");
  });

  test("ToolbarSurface owns bottom overlay placement for selection toolbars", () => {
    render(
      <MyoxusUIProvider>
        <ToolbarSurface data-testid="toolbar" placement="bottom-overlay">
          <button type="button">Action</button>
        </ToolbarSurface>
      </MyoxusUIProvider>,
    );

    const toolbar = screen.getByTestId("toolbar");
    expect(toolbar.dataset.placement).toBe("bottom-overlay");
    expect(toolbar.dataset.myoxusUiRole).toBe("toolbar-surface");
  });

  test("FloatingActionDock and FloatingActionTrigger own persistent action chrome", () => {
    render(
      <MyoxusUIProvider>
        <FloatingActionDock elevated concealed data-testid="dock">
          <FloatingActionTrigger concealed aria-label="Ask AI">
            AI
          </FloatingActionTrigger>
        </FloatingActionDock>
      </MyoxusUIProvider>,
    );

    const dock = screen.getByTestId("dock");
    const trigger = screen.getByRole("button", { name: "Ask AI" });
    expect(dock.dataset.myoxusUiRole).toBe("floating-action-dock");
    expect(dock.dataset.elevated).toBe("true");
    expect(dock.dataset.concealed).toBe("true");
    expect(dock.classList.contains("myoxus-floating-action-dock")).toBe(true);
    expect(trigger.dataset.myoxusUiRole).toBe("button:floating-action-trigger");
    expect(trigger.dataset.concealed).toBe("true");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.getAttribute("tabindex")).toBe("-1");
    expect(trigger.classList.contains("myoxus-floating-action-trigger")).toBe(
      true,
    );
  });

  test("FloatingActionTrigger chooses the wide action on desktop", () => {
    const originalMatchMedia = window.matchMedia;
    const narrowAction = vi.fn();
    const wideAction = vi.fn();

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
      writable: true,
    });

    try {
      render(
        <MyoxusUIProvider>
          <FloatingActionTrigger
            aria-label="Ask AI"
            responsiveAction={{
              narrow: narrowAction,
              preferWide: true,
              wide: wideAction,
            }}
          >
            AI
          </FloatingActionTrigger>
        </MyoxusUIProvider>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
      expect(wideAction).toHaveBeenCalledTimes(1);
      expect(narrowAction).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
        writable: true,
      });
    }
  });

  test("DisclosureCard keeps expandable panel chrome in the facade", () => {
    render(
      <MyoxusUIProvider>
        <DisclosureCard component="section" expanded data-testid="disclosure">
          Details
        </DisclosureCard>
      </MyoxusUIProvider>,
    );

    const disclosure = screen.getByTestId("disclosure");
    expect(disclosure.dataset.myoxusUiRole).toBe("disclosure-card");
    expect(disclosure.dataset.expanded).toBe("true");
    expect(disclosure.className).not.toContain("myoxus-ui-disclosure-card");
  });

  test("DisclosureCardTrigger owns expandable header interaction chrome", () => {
    render(
      <MyoxusUIProvider>
        <DisclosureCardTrigger expanded data-testid="trigger">
          Toggle
        </DisclosureCardTrigger>
      </MyoxusUIProvider>,
    );

    const trigger = screen.getByTestId("trigger");
    expect(trigger.dataset.myoxusUiRole).toBe("disclosure-card-trigger");
    expect(trigger.dataset.expanded).toBe("true");
    expect(trigger.className).not.toContain(
      "myoxus-ui-disclosure-card-trigger",
    );
  });
});
