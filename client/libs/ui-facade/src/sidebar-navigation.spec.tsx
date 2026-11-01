// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  type AnchorHTMLAttributes,
  forwardRef,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  clearBrandIdentityCache,
  HiddenFileInput,
  Menu,
  MenuItem,
  SidebarCalendarPanel,
  SidebarControlStrip,
  SidebarDateStepper,
  SidebarFlexibleSlot,
  SidebarFooterBar,
  SidebarFooterCaption,
  SidebarFooterStack,
  SidebarHeaderControls,
  SidebarHeaderMainSlot,
  SidebarNavFooter,
  SidebarNavItem,
  SidebarNavList,
  SidebarNavPinned,
  SidebarNavRoot,
  SidebarNavSection,
  SidebarNavSectionDivider,
  SidebarPromoAction,
  SidebarPromoCard,
  SidebarPromoProductMark,
  SidebarQuickActionRow,
  SidebarSectionContent,
  SidebarSectionHeader,
} from "./index";
import { MyoxusUIProvider } from "./provider";

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

const TestLink = forwardRef<
  HTMLAnchorElement,
  PropsWithChildren<AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }>
>(function TestLink({ children, to, ...props }, ref) {
  return (
    <a {...props} ref={ref} href={to}>
      {children}
    </a>
  );
});

beforeEach(() => {
  clearBrandIdentityCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearBrandIdentityCache();
});

describe("sidebar navigation facade primitives", () => {
  test("keeps pinned navigation and footer fixed while the middle list owns overflow", () => {
    renderWithProvider(
      <SidebarNavRoot>
        <SidebarNavPinned>
          <span>All content</span>
        </SidebarNavPinned>
        <SidebarNavList>
          <span>Folders</span>
        </SidebarNavList>
        <SidebarNavFooter>
          <span>User</span>
        </SidebarNavFooter>
      </SidebarNavRoot>,
    );

    const root = screen.getByText("Folders").parentElement?.parentElement;
    const pinned = screen.getByText("All content").parentElement;
    const list = screen.getByText("Folders").parentElement;
    const footer = screen.getByText("User").parentElement;

    expect(root?.dataset.myoxusUiRole).toBe("sidebar-nav-root");
    expect(root?.style.minHeight).toBe("0rem");
    expect(root?.style.minWidth).toBe("0rem");
    expect(root?.style.maxWidth).toBe("100%");
    expect(root?.style.width).toBe("100%");
    expect(pinned?.dataset.myoxusUiRole).toBe("sidebar-nav-pinned");
    expect(pinned?.style.flex).toBe("0 0 auto");
    expect(pinned?.style.overflow).toBe("hidden");
    expect(list?.dataset.myoxusUiRole).toBe("sidebar-nav-list");
    expect(list?.style.minHeight).toBe("0rem");
    expect(list?.style.minWidth).toBe("0rem");
    expect(list?.style.maxWidth).toBe("100%");
    expect(list?.style.width).toBe("100%");
    expect(list?.style.overflowY).toBe("auto");
    expect(footer?.dataset.myoxusUiRole).toBe("sidebar-nav-footer");
    expect(footer?.style.flex).toBe("0 0 auto");
  });

  test("renders click rows as semantic buttons through the shared navigation link", () => {
    const handleClick = vi.fn();

    renderWithProvider(
      <SidebarNavItem
        data-testid="quick-search"
        icon={<span aria-hidden>Q</span>}
        onClick={handleClick}
      >
        Quick search
      </SidebarNavItem>,
    );

    const row = screen.getByRole("button", { name: "Quick search" });
    expect(row).toBe(screen.getByTestId("quick-search"));
    expect(row.dataset.myoxusUiRole).toBe("sidebar-row");

    fireEvent.click(row);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  test("keeps sidebar row icon sizing out of SVG length attributes", () => {
    renderWithProvider(
      <SidebarNavItem
        icon={
          <svg
            aria-hidden
            data-testid="sidebar-row-icon"
            height="1em"
            viewBox="0 0 20 20"
            width="1em"
          />
        }
      >
        All docs
      </SidebarNavItem>,
    );

    const icon = screen.getByTestId("sidebar-row-icon");
    expect(icon.getAttribute("width")).toBe("1em");
    expect(icon.getAttribute("height")).toBe("1em");
  });

  test("keeps danger sidebar rows semantic instead of styling individual icons", () => {
    renderWithProvider(
      <SidebarNavItem active icon={<svg aria-hidden />} tone="danger">
        Trash
      </SidebarNavItem>,
    );

    const row = screen.getByRole("button", { name: "Trash" });
    expect(row.dataset.myoxusUiTone).toBe("danger");
    expect(row.dataset.myoxusUiRole).toBe("sidebar-row");
  });

  test("renders routed rows as links without product wrapper markup", () => {
    renderWithProvider(
      <SidebarNavItem component={TestLink} icon={<span />} to="/all">
        All pages
      </SidebarNavItem>,
    );

    const link = screen.getByRole("link", { name: "All pages" });
    expect(link.getAttribute("href")).toBe("/all");
    expect(link.dataset.myoxusUiVariant).toBe("sidebar");
    expect(link.getAttribute("style")).not.toContain(
      "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
    );
    expect(link.className).not.toContain("myoxus-navigation-link");
  });

  test("renders nested routed sidebar children through Mantine NavLink without row inline styles", () => {
    renderWithProvider(
      <SidebarNavItem
        component={TestLink}
        defaultOpened
        icon={<span />}
        nestedChildren={
          <SidebarNavItem component={TestLink} to="/all?filter=favorites">
            Favorites
          </SidebarNavItem>
        }
        to="/all"
      >
        All pages
      </SidebarNavItem>,
    );

    const parent = screen.getByRole("link", { name: "All pages" });
    const child = screen.getByRole("link", { name: "Favorites" });
    expect(parent.getAttribute("style")).not.toContain(
      "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
    );
    expect(child.getAttribute("href")).toBe("/all?filter=favorites");
    expect(child.dataset.myoxusUiVariant).toBe("sidebar");
    expect(child.getAttribute("style")).not.toContain(
      "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
    );
    expect(child.className).not.toContain("myoxus-navigation-link");
  });

  test("keeps non-routed nested sidebar sections collapsed by default and togglable", () => {
    renderWithProvider(
      <SidebarNavItem
        icon={<span />}
        nestedChildren={
          <SidebarNavItem component={TestLink} to="/all?filter=favorites">
            Favorites
          </SidebarNavItem>
        }
      >
        All docs
      </SidebarNavItem>,
    );

    const parent = screen.getByRole("button", { name: "All docs" });
    const disclosure = parent.querySelector(
      "[data-myoxus-ui-role='sidebar-section-disclosure']",
    );
    expect(disclosure).not.toBeNull();
    expect(disclosure?.getAttribute("data-collapsed")).toBe("true");
    expect(parent.dataset.expanded).toBeUndefined();
    expect(screen.queryByRole("link", { name: "Favorites" })).toBeNull();

    fireEvent.click(parent);

    expect(parent.dataset.expanded).toBe("true");
    expect(
      parent
        .querySelector("[data-myoxus-ui-role='sidebar-section-disclosure']")
        ?.getAttribute("data-collapsed"),
    ).toBeNull();
    expect(
      screen.getByRole("link", { hidden: true, name: "Favorites" }),
    ).not.toBeNull();
  });

  test("keeps routed sidebar parents navigable when nested children are shown", () => {
    renderWithProvider(
      <SidebarNavItem
        component={TestLink}
        defaultOpened
        icon={<span />}
        nestedChildren={
          <SidebarNavItem component={TestLink} to="/all?filter=favorites">
            Favorites
          </SidebarNavItem>
        }
        to="/all"
      >
        All pages
      </SidebarNavItem>,
    );

    const parent = screen.getByRole("link", { name: "All pages" });
    expect(parent.getAttribute("href")).toBe("/all");
    expect(screen.getByRole("link", { name: "Favorites" })).not.toBeNull();
    expect(
      fireEvent.click(parent),
      "Mantine NavLink prevents default when children are passed directly; routed sidebar parents must keep their primary link click.",
    ).toBe(true);
  });

  test("toggles collapsible section headers through the facade header role", () => {
    const handleCollapsedChange = vi.fn();
    const handleNewDoc = vi.fn();

    renderWithProvider(
      <SidebarSectionHeader
        actions={<button onClick={handleNewDoc}>New doc</button>}
        collapsed
        label="Favorites"
        onCollapsedChange={handleCollapsedChange}
      />,
    );

    const header = screen.getByRole("button", { name: "Favorites" });
    const action = screen.getByRole("button", { name: "New doc" });
    expect(header.dataset.myoxusUiRole).toBe("button:sidebar-section-header");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(action.closest("button")).toBe(action);

    fireEvent.click(header);
    expect(handleCollapsedChange).toHaveBeenCalledWith(false);

    fireEvent.click(action);
    expect(handleNewDoc).toHaveBeenCalledTimes(1);
    expect(handleCollapsedChange).toHaveBeenCalledTimes(1);
  });

  test("supports non-interactive metadata and leading disclosure in section headers", () => {
    const handleCollapsedChange = vi.fn();

    renderWithProvider(
      <SidebarSectionHeader
        collapsed
        disclosurePlacement="start"
        label="Changes"
        meta={<span data-testid="changes-count">3</span>}
        onCollapsedChange={handleCollapsedChange}
      />,
    );

    const header = screen.getByRole("button", { name: "Changes 3" });
    const disclosure = header.querySelector(
      "[data-myoxus-ui-role='sidebar-section-disclosure']",
    );
    const title = header.querySelector(
      "[data-myoxus-ui-role='sidebar-section-title']",
    );
    const meta = header.querySelector(
      "[data-myoxus-ui-role='sidebar-section-meta']",
    );
    expect(disclosure).not.toBeNull();
    expect(title).not.toBeNull();
    expect(meta).not.toBeNull();
    expect(disclosure?.compareDocumentPosition(title as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByTestId("changes-count")).not.toBeNull();

    fireEvent.click(screen.getByTestId("changes-count"));
    expect(handleCollapsedChange).toHaveBeenCalledWith(false);
  });

  test("supports forced-open section headers and tokenized section content", () => {
    const handleCollapsedChange = vi.fn();

    renderWithProvider(
      <>
        <SidebarSectionHeader
          collapsed={false}
          disclosurePlacement="start"
          disclosureVisible={false}
          disabled
          label="Focused week"
          onCollapsedChange={handleCollapsedChange}
        />
        <SidebarSectionContent data-testid="section-content">
          No events
        </SidebarSectionContent>
      </>,
    );

    const header = screen.getByRole("button", { name: "Focused week" });
    const content = screen.getByTestId("section-content");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(
      header.querySelector(
        "[data-myoxus-ui-role='sidebar-section-disclosure']",
      ),
    ).toBeNull();
    fireEvent.click(header);
    expect(handleCollapsedChange).not.toHaveBeenCalled();
    expect(content.dataset.myoxusUiRole).toBe("sidebar-section-content");
  });

  test("renders sidebar control strips and date steppers through shared facade roles", () => {
    const handlePrevious = vi.fn();
    const handleNext = vi.fn();

    renderWithProvider(
      <>
        <SidebarControlStrip data-testid="control-strip">
          <span>View mode</span>
        </SidebarControlStrip>
        <SidebarCalendarPanel data-testid="calendar-panel">
          <span>Calendar</span>
        </SidebarCalendarPanel>
        <SidebarDateStepper
          data-testid="date-stepper"
          label="Tuesday, June 16, 2026"
          labelTestId="date-stepper-label"
          nextLabel="Next day"
          nextTestId="date-stepper-next"
          onNext={handleNext}
          onPrevious={handlePrevious}
          previousLabel="Previous day"
          previousTestId="date-stepper-previous"
        />
      </>,
    );

    expect(screen.getByTestId("control-strip").dataset.myoxusUiRole).toBe(
      "sidebar-control-strip",
    );
    expect(screen.getByTestId("calendar-panel").dataset.myoxusUiRole).toBe(
      "sidebar-calendar-panel",
    );
    expect(
      screen.getByTestId("calendar-panel").getAttribute("style"),
    ).toContain("justify-content: center");
    expect(screen.getByTestId("date-stepper").dataset.myoxusUiRole).toBe(
      "sidebar-date-stepper",
    );
    expect(screen.getByTestId("date-stepper-label").dataset.myoxusUiRole).toBe(
      "sidebar-date-stepper-label",
    );

    fireEvent.click(screen.getByTestId("date-stepper-previous"));
    fireEvent.click(screen.getByTestId("date-stepper-next"));
    expect(handlePrevious).toHaveBeenCalledTimes(1);
    expect(handleNext).toHaveBeenCalledTimes(1);
  });

  test("keeps interactive trailing actions outside the main row button", () => {
    const handleOpen = vi.fn();
    const handleDismiss = vi.fn();

    renderWithProvider(
      <SidebarNavItem
        actionsInteractive
        actions={<button onClick={handleDismiss}>Dismiss</button>}
        icon={<span />}
        onClick={handleOpen}
      >
        Download app
      </SidebarNavItem>,
    );

    const openButton = screen.getByRole("button", { name: "Download app" });
    const dismissButton = screen.getByRole("button", { name: "Dismiss" });
    expect(dismissButton.closest("button")).toBe(dismissButton);
    expect(dismissButton).not.toBe(openButton);

    fireEvent.click(dismissButton);
    expect(handleDismiss).toHaveBeenCalledTimes(1);
    expect(handleOpen).not.toHaveBeenCalled();
  });

  test("uses sidebar rows as menu targets without nested trigger buttons", async () => {
    renderWithProvider(
      <Menu items={<MenuItem>Use template</MenuItem>}>
        <SidebarNavItem icon={<span aria-hidden>T</span>}>
          Template
        </SidebarNavItem>
      </Menu>,
    );

    expect(screen.getAllByRole("button", { name: "Template" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Template" }));
    expect(
      await screen.findByRole("menuitem", {
        hidden: true,
        name: "Use template",
      }),
    ).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Template" })).toHaveLength(1);
  });

  test("exposes tokenized root sidebar layout slots", () => {
    renderWithProvider(
      <>
        <SidebarHeaderControls data-testid="header-controls">
          <SidebarHeaderMainSlot data-testid="header-main">
            Workspace
          </SidebarHeaderMainSlot>
          User
        </SidebarHeaderControls>
        <SidebarQuickActionRow data-testid="quick-row">
          <SidebarFlexibleSlot data-testid="quick-main">
            Search
          </SidebarFlexibleSlot>
          New
        </SidebarQuickActionRow>
        <SidebarFooterStack data-testid="footer-stack">
          Download
        </SidebarFooterStack>
        <SidebarFooterBar data-testid="footer-bar">
          <SidebarFooterCaption tone="warning" data-testid="footer-caption">
            Stale
          </SidebarFooterCaption>
          <HiddenFileInput
            data-testid="footer-file-input"
            data-myoxus-ui-role="footer-hidden-file-input"
          />
        </SidebarFooterBar>
        <SidebarNavSection
          data-testid="nav-section"
          data-myoxus-ui-role="sidebar-section-content"
        >
          Pages
        </SidebarNavSection>
        <SidebarNavSectionDivider data-testid="nav-divider" />
      </>,
    );

    expect(screen.getByTestId("header-controls").dataset.myoxusUiRole).toBe(
      "sidebar-header-controls",
    );
    expect(screen.getByTestId("header-main").dataset.myoxusUiRole).toBe(
      "sidebar-header-main-slot",
    );
    expect(screen.getByTestId("quick-row").dataset.myoxusUiRole).toBe(
      "sidebar-quick-action-row",
    );
    expect(screen.getByTestId("quick-main").dataset.myoxusUiRole).toBe(
      "sidebar-flexible-slot",
    );
    expect(screen.getByTestId("footer-stack").dataset.myoxusUiRole).toBe(
      "sidebar-footer-stack",
    );
    expect(screen.getByTestId("footer-bar").dataset.myoxusUiRole).toBe(
      "sidebar-footer-bar",
    );
    expect(screen.getByTestId("footer-caption").dataset.myoxusUiRole).toBe(
      "sidebar-footer-caption",
    );
    expect(screen.getByTestId("footer-caption").dataset.tone).toBeUndefined();
    expect(screen.getByTestId("footer-file-input").dataset.myoxusUiRole).toBe(
      "footer-hidden-file-input",
    );
    expect(screen.getByTestId("nav-divider").dataset.myoxusUiRole).toBe(
      "sidebar-nav-section-divider",
    );
    expect(screen.getByTestId("footer-file-input").hasAttribute("hidden")).toBe(
      true,
    );
    expect(screen.getByTestId("footer-file-input").className).not.toContain(
      "myoxus-ui-hidden-file-input",
    );
    expect(
      screen.getByTestId("footer-file-input").getAttribute("aria-hidden"),
    ).toBe("true");
    expect(screen.getByTestId("nav-section").dataset.myoxusUiRole).toBe(
      "sidebar-section-content",
    );

    for (const element of [
      screen.getByTestId("header-controls"),
      screen.getByTestId("quick-row"),
      screen.getByTestId("footer-stack"),
      screen.getByTestId("footer-bar"),
      screen.getByTestId("nav-section"),
    ]) {
      expect(element.getAttribute("style") ?? "").not.toMatch(/\b\d+px\b/);
    }
  });

  test("renders sidebar promo actions without nesting dismiss controls inside the main button", () => {
    const handleOpen = vi.fn();
    const handleDismiss = vi.fn();

    renderWithProvider(
      <SidebarPromoAction
        closeAction={{
          "aria-label": "Dismiss update",
          icon: <span aria-hidden>x</span>,
          onClick: handleDismiss,
        }}
        detail="1.2.3"
        icon={<span aria-hidden>U</span>}
        label="Update available"
        onClick={handleOpen}
      />,
    );

    const openButton = screen.getByRole("button", {
      name: /Update available/,
    });
    const dismissButton = screen.getByRole("button", {
      name: "Dismiss update",
    });

    expect(openButton.dataset.myoxusUiRole).toBe("sidebar-promo-action");
    expect(dismissButton.closest("button")).toBe(dismissButton);
    expect(dismissButton).not.toBe(openButton);

    fireEvent.click(dismissButton);
    expect(handleDismiss).toHaveBeenCalledTimes(1);
    expect(handleOpen).not.toHaveBeenCalled();
  });

  test("renders sidebar promo cards as token-backed fixed surfaces", () => {
    const errorStatus = document.createElement("div");
    errorStatus.setAttribute("data-myoxus-error-status", "404");
    document.body.append(errorStatus);

    try {
      renderWithProvider(
        <SidebarPromoCard
          actions={<button>Open</button>}
          controls={<span>Remember</span>}
          hideOnErrorStatus
          icon={<SidebarPromoProductMark />}
          title="Open in app"
          data-testid="promo-card"
        >
          Download the desktop app.
        </SidebarPromoCard>,
      );

      const card = screen.getByTestId("promo-card");
      expect(card.dataset.myoxusUiRole).toBe("sidebar-promo-card");
      expect(card.dataset.hidden).toBe("true");
      expect(card.getAttribute("style")).toContain("position: fixed");
    } finally {
      errorStatus.remove();
    }
  });
});
