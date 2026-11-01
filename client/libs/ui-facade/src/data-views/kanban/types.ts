// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";

export type KanbanAccentRole =
  | "tag.red"
  | "tag.magenta"
  | "tag.orange"
  | "tag.yellow"
  | "tag.green"
  | "tag.teal"
  | "tag.blue"
  | "tag.purple"
  | "tag.grey";

export type KanbanCardInteraction = {
  readonly setInteractionDisabled: (disabled: boolean) => void;
};

export type KanbanCapability = {
  readonly enabled: boolean;
  readonly reason?: string;
};

export type KanbanSelection = {
  readonly cardId?: string;
  readonly columnId?: string;
};

export type KanbanCardModel = {
  readonly precedingContent?: ReactNode;
  readonly id: string;
  readonly columnId: string;
  readonly label: string;
  readonly accentRoles?: readonly KanbanAccentRole[];
  readonly description?: string;
  readonly title?:
    ReactNode | ((interaction: KanbanCardInteraction) => ReactNode);
  readonly cover?: ReactNode;
  readonly content?:
    ReactNode | ((interaction: KanbanCardInteraction) => ReactNode);
  readonly actions?: ReactNode;
  /** Native actions can replace (rather than extend) the default card menu. */
  readonly defaultActions?: boolean;
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string>>;
  readonly density?: "card" | "compact" | "default";
  readonly testId?: string;
  readonly frame?: (
    card: ReactNode,
    state: { readonly dragging: boolean },
  ) => ReactNode;
  readonly open?: KanbanCapability;
  readonly move?: KanbanCapability;
  readonly rename?: KanbanCapability;
  readonly remove?: KanbanCapability;
};

export type KanbanColumnModel = {
  /** Optional renderer-owned track geometry, independent of UI density. */
  readonly width?: number;
  readonly frame?: (column: ReactNode) => ReactNode;
  readonly precedingContent?: ReactNode;
  readonly id: string;
  readonly label: string;
  readonly cards: ReadonlyArray<KanbanCardModel>;
  readonly actions?: ReactNode;
  readonly testId?: string;
  readonly frameTestId?: string;
  readonly addCardTestId?: string;
  readonly add?: KanbanCapability;
  /** Receiving cards is independent of offering creation in this column. */
  readonly receive?: KanbanCapability;
  readonly rename?: KanbanCapability;
  readonly reorder?: KanbanCapability;
  readonly remove?: KanbanCapability;
};

export type KanbanCardMove = {
  readonly cardId: string;
  readonly fromColumnId: string;
  readonly toColumnId: string;
  readonly targetCardId?: string;
  readonly edge?: "before" | "after";
};

export type KanbanColumnMove = {
  readonly columnId: string;
  readonly targetColumnId: string;
  readonly edge: "before" | "after";
};

export type KanbanBoardLabels = {
  readonly actions: string;
  readonly addCard: (columnLabel: string) => string;
  readonly addCardText?: string;
  readonly addColumn: string;
  readonly cardCount: (count: number) => string;
  readonly dragCard: (cardLabel: string) => string;
  readonly dragColumn: (columnLabel: string) => string;
  readonly deleteCard: (cardLabel: string) => string;
  readonly deleteColumn: (columnLabel: string) => string;
  readonly emptyColumn: string;
  readonly openCard: (cardLabel: string) => string;
  readonly movedCard: (
    cardLabel: string,
    fromColumnLabel: string,
    toColumnLabel: string,
  ) => string;
  readonly movedColumn: (
    columnLabel: string,
    targetColumnLabel: string,
  ) => string;
};

export type KanbanBoardProps = {
  readonly appearance?: "default" | "surface";
  readonly activation?: "select" | "open";
  /** External ordering accepts only column changes, never insertion/rank edits. */
  readonly order?: "manual" | "external";
  readonly keyboardMovement?: "grab" | "adjacent-column";
  readonly renderLabel?: (label: string) => ReactNode;
  readonly "aria-label": string;
  readonly "data-testid"?: string;
  readonly columns: ReadonlyArray<KanbanColumnModel>;
  readonly labels: KanbanBoardLabels;
  readonly selection?: KanbanSelection;
  readonly readonly?: boolean;
  readonly scrollOwner?: "parent" | "self";
  readonly toolbar?: ReactNode;
  readonly empty?: ReactNode;
  readonly error?: ReactNode;
  readonly addColumn?: KanbanCapability;
  readonly editRequest?: {
    readonly id: string;
    readonly kind: "card" | "column";
    readonly requestId: number;
  };
  readonly focusRequest?: {
    readonly requestId: number;
    readonly selection?: KanbanSelection;
    readonly target?: "add-column-empty" | "board" | "card-title";
  };
  readonly onInteractionStart?: (
    kind: "card" | "column",
    id: string,
    intent: "rename" | "move",
  ) => void;
  readonly onEditEnd?: (
    kind: "card" | "column",
    id: string,
    outcome: "commit" | "cancel",
  ) => void;
  readonly onOpenColumn?: (columnId: string, trigger: HTMLElement) => void;
  readonly onAddCard?: (columnId: string) => void | Promise<void>;
  readonly onAddColumn?: (trigger: HTMLElement) => void | Promise<void>;
  readonly onDeleteCard?: (cardId: string) => void | Promise<void>;
  readonly onDeleteColumn?: (
    columnId: string,
    trigger: HTMLElement,
  ) => void | Promise<void>;
  /** Returning false rejects the move and suppresses its success announcement. */
  readonly onMoveCard?: (
    move: KanbanCardMove,
  ) => boolean | void | Promise<boolean | void>;
  readonly onMoveColumn?: (
    move: KanbanColumnMove,
  ) => boolean | void | Promise<boolean | void>;
  readonly onOpenCard: (cardId: string, trigger: HTMLElement) => void;
  readonly onSelectionTargetChange?: (target: HTMLElement) => void;
  readonly onSelectCard?: (cardId: string, trigger: HTMLElement) => void;
  readonly onSelectColumn?: (columnId: string, trigger: HTMLElement) => void;
  readonly onRenameCard?: (
    cardId: string,
    label: string,
  ) => void | Promise<void>;
  readonly onRenameColumn?: (
    columnId: string,
    label: string,
  ) => void | Promise<void>;
};
