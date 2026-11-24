import type { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { BlockStdScope } from "@virgultum/core/runtime";

export type PeekableClass = HTMLElement & {
  std: BlockStdScope;
  disposables: DisposableGroup;
  connectedCallback(): void;
};

export interface PeekOptions {
  /**
   * Abort signal to abort the peek view
   */
  abortSignal?: AbortSignal;
}

export interface PeekViewService {
  /**
   * Peek a target element page ref info
   * @param pageRef The page ref info to peek.
   * @returns A promise that resolves when the peek view is closed.
   */
  peek(
    pageRef: {
      docId: string;
      workspaceId?: string;
      blockIds?: string[];
      databaseId?: string;
      databaseDocId?: string;
      databaseRowId?: string;
      elementIds?: string[];
      target?: HTMLElement;
    },
    options?: PeekOptions,
  ): Promise<void>;

  /** Resolve a card, block or link using the owning product preview. */
  peek(element: { target: HTMLElement }, options?: PeekOptions): Promise<void>;
}

type PeekableAction = "double-click" | "shift-click";

export type PeekableOptions<T extends PeekableClass> = {
  /**
   * Action to bind to the peekable element. default to ['double-click', 'shift-click']
   * false means do not bind any action.
   */
  action?: PeekableAction | PeekableAction[] | false;
  /**
   * It will check the block is enable to peek or not
   */
  enableOn?: (block: T) => boolean;
  /**
   * Selector inside of the peekable element to bind the action
   */
  selector?: string;
};
