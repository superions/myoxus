import { MoreHorizontalIcon } from "@myoxus/icons/lit";
import { effect } from "@preact/signals-core";
import type { IconButton } from "@virgultum/components/icon-button";
import { LoadingIcon } from "@virgultum/components/icons";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import {
  cleanSpecifiedTail,
  getTextContentFromInlineRange,
} from "@virgultum/rich-text";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import {
  createKeydownObserver,
  getPopperPosition,
  getViewportElement,
} from "@virgultum/shared/utils";
import { PropTypes, requiredProperties } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { css, html, LitElement, nothing } from "lit";
import { property, query, queryAll, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import throttle from "lodash-es/throttle";

import type { LinkedDocContext, LinkedMenuGroup } from "./config.js";
import { linkedDocPopoverStyles } from "./styles.js";
import { resolveSignal } from "./utils.js";

@requiredProperties({
  context: PropTypes.object,
})
export class LinkedDocPopover extends SignalWatcher(
  WithDisposable(LitElement),
) {
  static override styles = linkedDocPopoverStyles;

  private readonly _abort = () => {
    // remove popover dom
    this.context.close();
    // clear input query
    cleanSpecifiedTail(
      this.context.std,
      this.context.inlineEditor,
      this.context.triggerKey + (this._query || ""),
    );
  };

  private readonly _expanded = new Map<string, boolean>();

  private _menusItemsEffectCleanup: () => void = () => {};

  private readonly _updateLinkedDocGroup = async () => {
    const query = this._query;
    if (this._updateLinkedDocGroupAbortController) {
      this._updateLinkedDocGroupAbortController.abort();
    }
    const controller = new AbortController();
    this._updateLinkedDocGroupAbortController = controller;

    if (query === null || query.startsWith(" ")) {
      this.context.close();
      return;
    }
    const groups = await this.context.config.getMenus(
      query,
      this._abort,
      this.context.std.host,
      this.context.inlineEditor,
      controller.signal,
      this.context.triggerKey,
    );

    if (controller.signal.aborted || !this.isConnected) return;
    this._linkedDocGroup = groups;
    this._menusItemsEffectCleanup();

    // need to rebind the effect because this._linkedDocGroup has changed.
    this._menusItemsEffectCleanup = effect(() => {
      this._updateAutoFocusedItem();

      // wait for the next tick to ensure the items are rendered to DOM
      setTimeout(() => {
        this.scrollToFocusedItem();
      });
    });
  };

  private readonly _updateAutoFocusedItem = () => {
    // Get the auto-focused item key from the config
    const autoFocusedItemKey = this.context.config.autoFocusedItemKey?.(
      this._linkedDocGroup,
      this._query || "",
      this._activatedItemKey,
      this.context.std.host,
      this.context.inlineEditor,
    );

    if (autoFocusedItemKey) {
      this._activatedItemKey = autoFocusedItemKey;
      return;
    }

    // If no auto-focused item key is returned from the config and no item is currently focused,
    // focus the first item in the flattened action list
    if (!this._activatedItemKey && this._flattenActionList.length > 0) {
      this._activatedItemKey = this._flattenActionList[0].key;
    }
  };

  private _updateLinkedDocGroupAbortController: AbortController | null = null;

  private get _actionGroup() {
    return this._linkedDocGroup.map((group) => {
      return {
        ...group,
        items: this._getActionItems(group),
      };
    });
  }

  private get _flattenActionList() {
    return this._actionGroup.flatMap((group) =>
      group.items.map((item) => ({ ...item, groupName: group.name })),
    );
  }

  private get _query() {
    return getTextContentFromInlineRange(
      this.context.inlineEditor,
      this.context.startRange,
    );
  }

  private _getActionItems(group: LinkedMenuGroup) {
    const isExpanded = !!this._expanded.get(group.name);
    let items = resolveSignal(group.items);

    const isOverflow = !!group.maxDisplay && items.length > group.maxDisplay;

    items = isExpanded ? items : items.slice(0, group.maxDisplay);

    if (isOverflow && !isExpanded && group.maxDisplay) {
      items = items.concat({
        key: `${group.name} More`,
        name: resolveSignal(group.overflowText) || "more",
        icon: MoreHorizontalIcon({ width: "24px", height: "24px" }),
        action: () => {
          this._expanded.set(group.name, true);
          this.requestUpdate();
        },
      });
    }

    return items;
  }

  private _isTextOverflowing(element: HTMLElement) {
    return element.scrollWidth > element.clientWidth;
  }

  override connectedCallback() {
    super.connectedCallback();

    // init
    this._updateLinkedDocGroup().catch(console.error);
    // Text may arrive through typing, IME or native paste. renderComplete is
    // emitted before native selection sync, so read the query in a microtask.
    const rendered = this.context.inlineEditor.slots.renderComplete.subscribe(
      () => {
        queueMicrotask(() => {
          if (this.isConnected)
            this._updateLinkedDocGroup().catch(console.error);
        });
      },
    );
    this._disposables.add(() => rendered.unsubscribe());
    this._disposables.addFromEvent(this, "pointerdown", (e) => {
      // Prevent input from losing focus
      e.preventDefault();
    });
    this._disposables.addFromEvent(this, "mousedown", (e) => {
      // Prevent input from losing focus in electron
      e.preventDefault();
    });
    this._disposables.addFromEvent(window, "pointerdown", (e) => {
      if (e.target === this) return;
      // We don't clear the query when clicking outside the popover
      this.context.close();
    });

    const keydownObserverAbortController = new AbortController();
    this._disposables.add(() => keydownObserverAbortController.abort());

    const { eventSource } = this.context.inlineEditor;
    if (!eventSource) return;

    createKeydownObserver({
      target: eventSource,
      signal: keydownObserverAbortController.signal,
      interceptor: (event, next) => {
        if (event.key === "GroupNext" || event.key === "GroupPrevious") {
          event.stopPropagation();
          return;
        }
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.key === "Escape") {
          this.context.close();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        next();
      },
      onDelete: () => {
        const curRange = this.context.inlineEditor.getInlineRange();
        if (!this.context.startRange || !curRange) {
          return;
        }
        if (curRange.index < this.context.startRange.index) {
          this.context.close();
        }
      },
      onMove: (step) => {
        const itemLen = this._flattenActionList.length;
        const nextIndex = (itemLen + this._activatedItemIndex + step) % itemLen;
        const item = this._flattenActionList[nextIndex];
        if (item) {
          this._activatedItemKey = item.key;
        }
        this.scrollToFocusedItem();
      },
      onConfirm: () => {
        this._flattenActionList[this._activatedItemIndex]
          ?.action()
          ?.catch(console.error);
      },
      onAbort: () => {
        this.context.close();
      },
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._menusItemsEffectCleanup();
    this._updateLinkedDocGroupAbortController?.abort();
  }

  override render() {
    const MAX_HEIGHT = 390;
    const style = this._position
      ? styleMap({
          transform: `translate(${this._position.x}, ${this._position.y})`,
          maxHeight: `${Math.min(this._position.height, MAX_HEIGHT)}px`,
        })
      : styleMap({
          visibility: "hidden",
        });

    const actionGroups = this._actionGroup.map((group) => {
      // Check if the group is loading or hidden
      const isLoading = resolveSignal(group.loading);
      const isHidden = resolveSignal(group.hidden);
      return {
        ...group,
        isLoading,
        isHidden,
      };
    });

    return html`<div class="linked-doc-popover" style="${style}">
      ${actionGroups
        .filter(
          (group) =>
            (group.items.length > 0 || group.isLoading || group.emptyMessage) &&
            !group.isHidden,
        )
        .map((group, idx) => {
          return html`
            <div class="divider" ?hidden=${idx === 0}></div>
            <div class="group-title">
              <div class="group-title-text">${group.name}</div>
              ${
                group.isLoading
                  ? html`<span class="loading-icon">${LoadingIcon()}</span>`
                  : nothing
              }
            </div>
            <div class="group" style=${group.styles ?? ""}>
              ${
                !group.isLoading && group.items.length === 0
                  ? html`<div role="status">${group.emptyMessage}</div>`
                  : nothing
              }
              ${group.items.map(({ key, name, icon, action }) => {
                const tooltip = this._showTooltip
                  ? html`<myoxus-tooltip
                      tip-position=${"right"}
                      .tooltipStyle=${css`
                        * {
                          color: ${unsafeCSSVar("white")} !important;
                        }
                      `}
                      >${name}</myoxus-tooltip
                    >`
                  : nothing;
                return html`<icon-button
                  width="260px"
                  height="30px"
                  data-id=${key}
                  .text=${name}
                  hover=${this._activatedItemKey === key}
                  @pointerdown=${(e: PointerEvent) => {
                    // Prevent event listeners being registered on the root document
                    // eg., radix-ui dialogs usePointerDownOutside hooks
                    e.stopPropagation();
                  }}
                  @click=${() => {
                    action()?.catch(console.error);
                  }}
                  @mousemove=${() => {
                    // Use `mousemove` instead of `mouseover` to avoid navigate conflict with keyboard
                    this._activatedItemKey = key;
                    // show tooltip whether text length overflows
                    for (const button of this.iconButtons.values()) {
                      if (button.dataset.id == key && button.textElement) {
                        const isOverflowing = this._isTextOverflowing(
                          button.textElement,
                        );
                        this._showTooltip = isOverflowing;
                        break;
                      }
                    }
                  }}
                >
                  ${icon} ${tooltip}
                </icon-button>`;
              })}
            </div>
          `;
        })}
    </div>`;
  }

  override willUpdate() {
    if (!this.hasUpdated) {
      const updatePosition = throttle(() => {
        this._position = getPopperPosition(
          {
            getBoundingClientRect: () => {
              return {
                ...this.getBoundingClientRect(),
                // Workaround: the width of the popover is zero when it is not rendered
                width: 280,
              };
            },
          },
          this.context.startNativeRange,
        );
      }, 10);

      this.disposables.addFromEvent(window, "resize", updatePosition);
      const scrollContainer = getViewportElement(this.context.std.host);
      if (scrollContainer) {
        // Note: in edgeless mode, the scroll container is not exist!
        this.disposables.addFromEvent(
          scrollContainer,
          "scroll",
          updatePosition,
          {
            passive: true,
          },
        );
      }

      const gfx = this.context.std.get(GfxControllerIdentifier);
      this.disposables.add(
        gfx.viewport.viewportUpdated.subscribe(updatePosition),
      );

      updatePosition();
    }
  }

  private scrollToFocusedItem() {
    const shadowRoot = this.shadowRoot;
    if (!shadowRoot) {
      return;
    }

    // If there's no active item key, don't try to scroll
    if (!this._activatedItemKey) {
      return;
    }

    const ele = shadowRoot.querySelector(
      `icon-button[data-id=${CSS.escape(this._activatedItemKey)}]`,
    );

    // If the element doesn't exist, don't log a warning
    if (!ele) {
      return;
    }

    ele.scrollIntoView({
      block: "nearest",
    });
  }

  get _activatedItemIndex() {
    const index = this._flattenActionList.findIndex(
      (item) => item.key === this._activatedItemKey,
    );
    return index === -1 ? 0 : index;
  }

  @state()
  private accessor _activatedItemKey: string | null = null;

  @state()
  private accessor _linkedDocGroup: LinkedMenuGroup[] = [];

  @state()
  private accessor _position: {
    height: number;
    x: string;
    y: string;
  } | null = null;

  @state()
  private accessor _showTooltip = false;

  @property({ attribute: false })
  accessor context!: LinkedDocContext;

  @queryAll("icon-button")
  accessor iconButtons!: NodeListOf<IconButton>;

  @query(".linked-doc-popover")
  accessor linkedDocElement: Element | null = null;
}
