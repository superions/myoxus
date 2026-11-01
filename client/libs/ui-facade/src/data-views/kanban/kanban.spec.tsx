// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MyoxusUIProvider } from "../../provider";
import { afterEach, describe, expect, test, vi } from "vitest";

import { KanbanBoard } from "./index";

afterEach(cleanup);

const labels = {
  actions: "Actions",
  addCard: (column: string) => `Add card to ${column}`,
  addColumn: "Add column",
  cardCount: (count: number) => `${count} cards`,
  deleteCard: (card: string) => `Delete ${card}`,
  deleteColumn: (column: string) => `Delete ${column}`,
  dragCard: (card: string) => `Move ${card}`,
  dragColumn: (column: string) => `Move ${column}`,
  emptyColumn: "No cards",
  movedCard: (card: string, from: string, to: string) =>
    `${card} moved from ${from} to ${to}`,
  movedColumn: (column: string, target: string) =>
    `${column} moved beside ${target}`,
  openCard: (card: string) => `Open ${card}`,
};

function renderBoard(
  overrides: Partial<Parameters<typeof KanbanBoard>[0]> = {},
) {
  const props = {
    "aria-label": "Project board",
    columns: [
      {
        id: "todo",
        label: "To do",
        add: { enabled: true },
        rename: { enabled: true },
        reorder: { enabled: true },
        remove: { enabled: true },
        cards: [
          {
            id: "draft",
            columnId: "todo",
            label: "Draft specification",
            move: { enabled: true },
            rename: { enabled: true },
            remove: { enabled: true },
            open: { enabled: true },
          },
        ],
      },
      {
        id: "done",
        label: "Done",
        add: { enabled: true },
        rename: { enabled: true },
        reorder: { enabled: true },
        remove: { enabled: true },
        cards: [],
      },
    ],
    labels,
    onAddCard: vi.fn(),
    onAddColumn: vi.fn(),
    onDeleteCard: vi.fn(),
    onDeleteColumn: vi.fn(),
    onMoveCard: vi.fn(),
    onMoveColumn: vi.fn(),
    onOpenCard: vi.fn(),
    onRenameCard: vi.fn(),
    onRenameColumn: vi.fn(),
    ...overrides,
  } as Parameters<typeof KanbanBoard>[0];
  return {
    props,
    ...render(
      <MyoxusUIProvider>
        <KanbanBoard {...props} />
      </MyoxusUIProvider>,
    ),
  };
}

describe("KanbanBoard", () => {
  test("renders accessible columns, cards and an explicit empty column", () => {
    renderBoard();
    expect(
      screen.getByRole("region", { name: "Project board" }),
    ).toBeInstanceOf(HTMLElement);
    expect(screen.getAllByTestId("kanban-column")).toHaveLength(2);
    expect(screen.getByText("No cards")).toBeInstanceOf(HTMLElement);
    expect(screen.getByLabelText("1 cards")).toBeInstanceOf(HTMLElement);
    expect(screen.getByLabelText("0 cards")).toBeInstanceOf(HTMLElement);
  });

  test("separates card open, inline rename and the keyboard move handle", async () => {
    const { props } = renderBoard();
    const card = screen.getByTestId("kanban-card");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(props.onOpenCard).toHaveBeenCalledWith("draft", card);

    const title = within(card).getByRole("button", {
      name: "Draft specification",
    });
    fireEvent.click(title);
    expect(within(card).queryByRole("textbox")).toBeNull();
    fireEvent.doubleClick(title);
    const input = within(card).getByRole("textbox", {
      name: "Draft specification",
    });
    fireEvent.change(input, { target: { value: "Reviewed specification" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRenameCard).toHaveBeenCalledWith(
      "draft",
      "Reviewed specification",
    );

    const handle = within(card).getByRole("button", {
      name: "Move Draft specification",
    });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(props.onMoveCard).not.toHaveBeenCalled();
    fireEvent.keyDown(handle, { key: "Enter" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(props.onMoveCard).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: "draft",
        fromColumnId: "todo",
        toColumnId: "done",
      }),
    );
    expect(await screen.findByText(/moved from To do to Done/)).toBeInstanceOf(
      HTMLElement,
    );
  });

  test("exposes the column label to its inline editor", () => {
    const { props } = renderBoard();
    fireEvent.doubleClick(screen.getByRole("button", { name: "To do" }));
    const input = screen.getByRole("textbox", { name: "To do" });
    fireEvent.change(input, { target: { value: "Backlog" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRenameColumn).toHaveBeenCalledWith("todo", "Backlog");
  });

  test("moves columns by keyboard and announces the labeled target", async () => {
    const { props } = renderBoard({
      labels: {
        ...labels,
        movedColumn: (column, target) => `${column} moved beside ${target}`,
      },
    });
    const handle = screen.getByRole("button", { name: "Move To do" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(props.onMoveColumn).not.toHaveBeenCalled();
    fireEvent.keyDown(handle, { key: "Enter" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(props.onMoveColumn).toHaveBeenCalledWith({
      columnId: "todo",
      targetColumnId: "done",
      edge: "after",
    });
    expect(await screen.findByText("To do moved beside Done")).toBeInstanceOf(
      HTMLElement,
    );
  });

  test("marks restored card and column selection without owning persistence", () => {
    const { container, rerender, props } = renderBoard({
      selection: { cardId: "draft" },
    });
    expect(
      container
        .querySelector('[data-card-id="draft"]')
        ?.getAttribute("data-selected"),
    ).toBe("true");
    rerender(
      <MyoxusUIProvider>
        <KanbanBoard {...props} selection={{ columnId: "done" }} />
      </MyoxusUIProvider>,
    );
    expect(
      container
        .querySelector('[data-column-id="done"]')
        ?.getAttribute("data-selected"),
    ).toBe("true");
  });

  test("passes the real add-column trigger to product adapters", () => {
    const { props } = renderBoard();
    const trigger = screen.getByRole("button", { name: "Add column" });
    fireEvent.click(trigger);
    expect(props.onAddColumn).toHaveBeenCalledWith(trigger);
  });

  test("keeps the horizontal scroll owner on the board surface", () => {
    const { container } = renderBoard();
    expect(
      container.querySelector(
        '[data-myoxus-ui-role="kanban-board-scroll-root"]',
      ),
    ).toBeInstanceOf(HTMLElement);
  });
});
