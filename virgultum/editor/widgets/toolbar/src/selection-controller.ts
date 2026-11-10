import {
  autoUpdate,
  type ReferenceElement,
  type SideObject,
} from "@floating-ui/dom";
import { batch, effect, signal } from "@preact/signals-core";
import { EdgelessLegacySlotIdentifier } from "@virgultum/block-surface";
import { TableSelection } from "@virgultum/block-table";
import {
  Bound,
  getCommonBound,
  getCommonBoundWithRotation,
} from "@virgultum/global/gfx";
import { nextTick } from "@virgultum/global/utils";
import {
  CodeBlockModel,
  ImageBlockModel,
  ListBlockModel,
  ParagraphBlockModel,
} from "@virgultum/model";
import {
  ToolbarContext,
  EditorI18nProvider,
  resolveToolbarActions,
  presentToolbarActions,
  type EditorSelectionControls,
  type EditorSelectionState,
  ToolbarFlag as Flag,
  ToolbarRegistryIdentifier,
} from "@virgultum/shared/services";
import { matchModels } from "@virgultum/shared/utils";
import {
  type BlockComponent,
  BlockSelection,
  TextSelection,
  type WidgetComponent,
} from "@virgultum/std";
import {
  GfxBlockElementModel,
  type GfxController,
  type GfxModel,
  GfxPrimitiveElementModel,
} from "@virgultum/std/gfx";
import { RANGE_SYNC_EXCLUDE_ATTR } from "@virgultum/std/inline";
import groupBy from "lodash-es/groupBy";
import throttle from "lodash-es/throttle";
import toPairs from "lodash-es/toPairs";

const MERMAID_GFX_ROLE_PREFIX = "mermaid-";
// Selection bounds include the existing canvas handles, not popup layout.
const sideMap = new Map<string, Partial<SideObject>>([
  ["myoxus:surface:frame", { top: 28 }],
  ["myoxus:surface:group", { top: 20 }],
  ["myoxus:surface:shape", { top: 26, bottom: -26 }],
]);

type GfxModelWithMermaidMeta = GfxModel & {
  props?: Record<string, unknown>;
  yMap?: { get?: (key: string) => unknown };
};

function readGfxMeta(model: GfxModelWithMermaidMeta, key: string) {
  const value = model.yMap?.get?.(key) ?? model.props?.[key];
  return value == null ? "" : String(value);
}

function isMermaidGfxElement(model: GfxModel) {
  return readGfxMeta(
    model as GfxModelWithMermaidMeta,
    "mermaidRole",
  ).startsWith(MERMAID_GFX_ROLE_PREFIX);
}

function resolveMermaidOwnerToolbarReference(
  gfx: GfxController,
  elements: GfxModel[],
) {
  if (!elements.length || !elements.every(isMermaidGfxElement)) {
    return null;
  }
  const owners = gfx.doc.getBlocksByFlavour("myoxus:mermaid") ?? [];
  for (const { model } of owners) {
    const owner = model as GfxModel & { childIds?: readonly string[] };
    const childIds = new Set(owner.childIds ?? []);
    if (elements.every((element) => childIds.has(element.id))) {
      return [owner];
    }
  }
  return null;
}

export class SelectionToolbarController {
  constructor(readonly widget: WidgetComponent) {}

  get std() {
    return this.widget.std;
  }
  get host() {
    return this.widget.host;
  }
  get disposables() {
    return this.widget.disposables;
  }
  getBoundingClientRect() {
    return this.widget.getBoundingClientRect();
  }
  handleEvent: WidgetComponent["handleEvent"] = (...args) =>
    this.widget.handleEvent(...args);

  sideOptions$ = signal<Partial<SideObject> | null>(null);

  referenceElement$ = signal<(() => ReferenceElement | null) | null>(null);

  setReferenceElementWithRange(range: Range | null) {
    this.referenceElement$.value = range
      ? () => ({
          getBoundingClientRect: () => range.getBoundingClientRect(),
          getClientRects: () =>
            Array.from(range.getClientRects()).filter((rect) =>
              Math.round(rect.width),
            ),
        })
      : null;
  }

  setReferenceElementWithHtmlElement(element: Element | null) {
    this.referenceElement$.value = element ? () => element : null;
  }

  setReferenceElementWithBlocks(blocks: BlockComponent[]) {
    const getClientRects = () => blocks.map((e) => e.getBoundingClientRect());

    this.referenceElement$.value = blocks.length
      ? () => ({
          getBoundingClientRect: () => {
            const rects = getClientRects();
            const bounds = getCommonBound(rects.map(Bound.fromDOMRect));
            if (!bounds) return rects[0];
            return new DOMRect(bounds.x, bounds.y, bounds.w, bounds.h);
          },
          getClientRects,
        })
      : null;
  }

  setReferenceElementWithElements(gfx: GfxController, elements: GfxModel[]) {
    const getBoundingClientRect = () => {
      const bounds = getCommonBoundWithRotation(elements);
      const { x: offsetX, y: offsetY } = this.getBoundingClientRect();
      const [x, y, w, h] = gfx.viewport.toViewBound(bounds).toXYWH();
      const rect = new DOMRect(x + offsetX, y + offsetY, w, h);
      return rect;
    };

    this.referenceElement$.value = elements.length
      ? () => ({
          getBoundingClientRect,
          getClientRects: () => [getBoundingClientRect()],
        })
      : null;
  }

  updateWithSurface(
    ctx: ToolbarContext,
    activated: boolean,
    elementIds: string[],
  ) {
    const gfx = ctx.gfx;
    const surface = gfx.surface;
    let flavour = "myoxus:surface";
    let elements: GfxModel[] = [];
    let hasLocked = false;
    let sideOptions = null;
    let paired: [string, GfxModel[]][] = [];

    if (activated && surface) {
      elements = elementIds
        .map((id) => gfx.getElementById(id))
        .filter((model) => model !== null) as GfxModel[];

      // Should double check
      activated &&= Boolean(elements.length);

      hasLocked = elements.some((e) => e.isLocked());

      const grouped = groupBy(
        elements.map((model) => {
          let flavour = surface.flavour;

          if (model instanceof GfxBlockElementModel) {
            flavour += `:${model.flavour.split(":").pop()}`;
          } else if (model instanceof GfxPrimitiveElementModel) {
            flavour += `:${model.type}`;
          }

          return { model, flavour };
        }),
        (e) => e.flavour,
      );

      paired = toPairs(grouped).map(([flavour, items]) => [
        flavour,
        items.map(({ model }) => model),
      ]);

      if (hasLocked) {
        flavour = "myoxus:surface:locked";
      } else {
        if (paired.length === 1) {
          flavour = paired[0][0];
          if (flavour === "myoxus:surface:shape" && paired[0][1].length === 1) {
            sideOptions = sideMap.get(flavour) ?? null;
          }
        }
      }
      if (!sideOptions) {
        const flavours = new Set(paired.map(([f]) => f));
        if (flavours.has("myoxus:surface:frame")) {
          sideOptions = sideMap.get("myoxus:surface:frame") ?? null;
        } else if (flavours.has("myoxus:surface:group")) {
          sideOptions = sideMap.get("myoxus:surface:group") ?? null;
        }
      }
    }

    batch(() => {
      ctx.flags.toggle(Flag.Surface, activated);

      ctx.elementsMap$.value = new Map(paired);

      if (!activated || !flavour) return;

      // Mermaid diagrams are composite GFX owners. Anchoring the native
      // selection toolbar to a selected data point covers chart content; use
      // the owning block as the floating reference while keeping the selected
      // element's toolbar actions and source-sync semantics unchanged.
      this.setReferenceElementWithElements(
        gfx,
        resolveMermaidOwnerToolbarReference(gfx, elements) ?? elements,
      );

      this.sideOptions$.value = sideOptions;
      ctx.flavour$.value = flavour;
      ctx.placement$.value = hasLocked ? "top" : "top-start";
      ctx.flags.refresh(Flag.Surface);
    });
  }

  toolbar: HTMLElement | null = null;
  private readonly anchor$ = signal<HTMLElement | null>(null);
  private readonly state$ = signal<EditorSelectionState>({
    open: false,
    key: "",
    placement: "top",
    primary: [],
    more: [],
  });
  readonly controls: EditorSelectionControls = {
    getSnapshot: () => this.state$.peek(),
    subscribe: (listener) => this.state$.subscribe(() => listener()),
    setAnchor: (anchor) => {
      this.anchor$.value = anchor;
    },
    setFloating: (element) => {
      this.toolbar = element;
      this.toolbarRegistry.floatingElement = element;
      this.toolbarRegistry.message$.peek()?.setFloating(element ?? undefined);
    },
    dismiss: () => this.toolbarRegistry.flags.reset(),
  };

  get toolbarRegistry() {
    return this.std.get(ToolbarRegistryIdentifier);
  }

  connect() {
    // The widget is a transparent canvas overlay; its native popup owns pointer input.
    Object.assign(this.widget.style, {
      pointerEvents: "none",
      position: "absolute",
      inset: "0",
      overflow: "visible",
    });
    this.widget.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");

    const {
      sideOptions$,
      referenceElement$,
      disposables,
      toolbarRegistry,
      host,
      std,
    } = this;
    const { flags, flavour$, message$, placement$ } = toolbarRegistry;
    const context = new ToolbarContext(std);
    let surfaceUpdateQueued = false;
    let surfaceUpdatesDisposed = false;
    disposables.add(() => {
      surfaceUpdatesDisposed = true;
    });
    const queueSurfaceUpdate = () => {
      if (surfaceUpdateQueued) return;
      surfaceUpdateQueued = true;
      // A composite Source/history transaction changes many Surface props.
      // Resolve its controls once from the final graph instead of rendering
      // against each intermediate Yjs observer notification.
      queueMicrotask(() => {
        surfaceUpdateQueued = false;
        if (surfaceUpdatesDisposed || !flags.isSurface()) return;
        const elementIds = context.gfx.selection.selectedIds;
        this.updateWithSurface(
          context,
          context.surfaceActivated && Boolean(elementIds.length),
          elementIds,
        );
      });
    };

    const isNativeTextSelection = () => {
      const tableViewSelection = std.selection.find(TableSelection)?.data;
      return tableViewSelection?.type === "area";
    };

    // Formatting
    // Selects text in note.
    disposables.add(
      std.selection.find$(TextSelection).subscribe((result) => {
        const range = std.range.value ?? null;
        const activated = Boolean(
          context.textSelectionActivated &&
          range &&
          result &&
          !result.isCollapsed() &&
          result.from.length + (result.to?.length ?? 0),
        );

        batch(() => {
          flags.toggle(Flag.Text, activated);

          if (!activated) return;

          this.setReferenceElementWithRange(range);

          sideOptions$.value = null;
          flavour$.value = "myoxus:note";
          placement$.value = toolbarRegistry.getModulePlacement("myoxus:note");
          flags.refresh(Flag.Text);
        });
      }),
    );

    // Formatting
    // Selects `native` text in database's cell or in table.
    disposables.addFromEvent(document, "selectionchange", () => {
      // Native inputs have their own browser range; retain the editor selection
      // while its scoped popup owns focus, as the inline range binding does.
      if (this.toolbar?.contains(document.activeElement)) return;
      const range = std.range.value ?? null;
      let activated = context.activated && Boolean(range && !range.collapsed);

      if (activated) {
        activated = isNativeTextSelection();
      }

      batch(() => {
        // Focues outside: `doc-title`
        if (
          flags.check(Flag.Text) &&
          !std.host.contains(range?.commonAncestorContainer ?? null)
        ) {
          flags.toggle(Flag.Text, false);
        }

        flags.toggle(Flag.Native, activated);

        if (!activated) return;

        this.setReferenceElementWithRange(range);

        sideOptions$.value = null;
        flavour$.value = "myoxus:note";
        placement$.value = toolbarRegistry.getModulePlacement("myoxus:note");
        flags.refresh(Flag.Native);
      });
    });

    // Selects blocks in note.
    disposables.add(
      std.selection.filter$(BlockSelection).subscribe((selections) => {
        const blockIds = selections.map((s) => s.blockId);
        const count = blockIds.length;
        let flavour = "myoxus:note";
        let activated = context.textSelectionActivated && Boolean(count);

        if (activated) {
          // Handles a signal block.
          const block = count === 1 && std.store.getBlock(blockIds[0]);

          // Chencks if block's config exists.
          if (block) {
            const modelFlavour = block.model.flavour;
            const existed =
              toolbarRegistry.modules.has(modelFlavour) ||
              toolbarRegistry.modules.has(`custom:${modelFlavour}`);
            if (existed) {
              flavour = modelFlavour;
            } else {
              activated = matchModels(block.model, [
                ParagraphBlockModel,
                ListBlockModel,
                CodeBlockModel,
                ImageBlockModel,
              ]);
            }
          }
        }

        batch(() => {
          flags.toggle(Flag.Block, activated);

          if (!activated) return;

          this.setReferenceElementWithBlocks(
            blockIds
              .map((id) => std.view.getBlock(id))
              .filter((block) => block !== null),
          );

          sideOptions$.value = null;
          flavour$.value = flavour;
          placement$.value = toolbarRegistry.getModulePlacement(
            flavour,
            flavour === "myoxus:note" ? "top" : "top-start",
          );
          flags.refresh(Flag.Block);
        });
      }),
    );

    // Selects elements in edgeless.
    // Triggered only when not in editing state.
    disposables.add(
      context.gfx.selection.slots.updated.subscribe((selections) => {
        // Should remove selections when clicking on frame navigator
        if (context.isPageMode) {
          if (
            std.host.contains(std.range.value?.commonAncestorContainer ?? null)
          ) {
            std.range.clear();
          }
          context.reset();
          return;
        }

        const elementIds = selections.flatMap((s) =>
          s.editing || s.inoperable ? [] : s.elements,
        );
        const count = elementIds.length;
        const activated = context.surfaceActivated && Boolean(count);

        this.updateWithSurface(context, activated, elementIds);
      }),
    );

    disposables.add(
      std.selection.slots.changed.subscribe((selections) => {
        if (!context.activated) return;

        const value = flags.value$.peek();
        if (flags.contains(Flag.Hovering | Flag.Hiding, value)) return;
        if (!flags.check(Flag.Text, value)) return;

        const hasTextSelection =
          selections.filter((s) => s.is(TextSelection)).length > 0;
        if (!hasTextSelection) return;

        const range = std.range.value ?? null;

        this.setReferenceElementWithRange(range);

        // TODO(@fundon): maybe here can be further optimized
        // 1. Prevents flickering effects.
        // 2. We cannot use `host.getUpdateComplete()` here
        // because it would cause excessive DOM queries, leading to UI jamming.
        nextTick()
          .then(() => flags.refresh(Flag.Text))
          .catch(console.error);
      }),
    );

    // Handles blocks when adding
    // TODO(@fundon): improve these cases
    // Waits until the view is created when switching the view mode.
    // `card view` or `embed view`
    disposables.add(
      std.view.viewUpdated.subscribe((record) => {
        const hasAdded = record.type === "block" && record.method === "add";
        if (!hasAdded) return;

        if (flags.isBlock()) {
          const blockIds = std.selection
            .filter$(BlockSelection)
            .peek()
            .map((s) => s.blockId);
          if (blockIds.includes(record.id)) {
            batch(() => {
              this.setReferenceElementWithBlocks(
                blockIds
                  .map((id) => std.view.getBlock(id))
                  .filter((block) => block !== null),
              );
              flags.refresh(Flag.Block);
            });
          }
          return;
        }

        if (flags.isSurface()) {
          flags.refresh(Flag.Surface);
          return;
        }
      }),
    );

    // Handles blocks when updating
    disposables.add(
      // TODO(@fundon): use rxjs' filter
      std.store.slots.blockUpdated.subscribe((record) => {
        const hasUpdated = record.type === "update";
        if (!hasUpdated) return;

        if (flags.isBlock()) {
          const blockIds = std.selection
            .filter$(BlockSelection)
            .peek()
            .map((s) => s.blockId);
          if (blockIds.includes(record.id)) {
            batch(() => {
              this.setReferenceElementWithBlocks(
                blockIds
                  .map((id) => std.view.getBlock(id))
                  .filter((block) => block !== null),
              );
              flags.refresh(Flag.Block);
            });
          }
          return;
        }

        if (flags.isSurface()) {
          queueSurfaceUpdate();
          return;
        }
      }),
    );

    // Handles elements when updating
    disposables.add(
      context.gfx.surface$.subscribe((surface) => {
        if (!surface) return;

        const subscription = surface.elementUpdated.subscribe(() => {
          if (!flags.isSurface()) return;
          queueSurfaceUpdate();
        });

        disposables.add(subscription);
      }),
    );

    // Handles `drag and drop`
    const dragStart = () => flags.toggle(Flag.Hiding, true);
    const dragEnd = () => flags.toggle(Flag.Hiding, false);
    const eventOptions = { passive: false };
    this.handleEvent("dragStart", () => {
      dragStart();
      document.addEventListener("pointerup", dragEnd, { once: true });
    });
    this.handleEvent("nativeDrop", dragEnd);
    disposables.addFromEvent(host, "dragenter", dragStart, eventOptions);
    disposables.addFromEvent(
      host,
      "dragleave",
      throttle(
        (event: DragEvent) => {
          const { x, y, target } = event;
          if (target === this.widget) return;
          const rect = host.getBoundingClientRect();
          if (
            x >= rect.left &&
            x <= rect.right &&
            y >= rect.top &&
            y <= rect.bottom
          )
            return;
          dragEnd();
        },
        144,
        { trailing: true },
      ),
      eventOptions,
    );

    // Handles elements when resizing
    const edgelessSlots = std.getOptional(EdgelessLegacySlotIdentifier);
    if (edgelessSlots) {
      disposables.add(edgelessSlots.elementResizeStart.subscribe(dragStart));
      disposables.add(edgelessSlots.elementResizeEnd.subscribe(dragEnd));
    }

    // Handles elements when hovering
    disposables.add(
      message$.subscribe((data) => {
        if (
          !context.activated ||
          flags.contains(Flag.Text | Flag.Native | Flag.Block)
        ) {
          flags.toggle(Flag.Hovering, false);
          return;
        }

        const activated = !!data;

        batch(() => {
          flags.toggle(Flag.Hovering, activated);

          if (!activated) return;

          const { flavour, setFloating } = data;

          setFloating(this.toolbar ?? undefined);

          this.setReferenceElementWithHtmlElement(data.element);

          sideOptions$.value = null;
          flavour$.value = flavour;
          placement$.value = toolbarRegistry.getModulePlacement(flavour);
          flags.refresh(Flag.Hovering);
        });
      }),
    );

    disposables.add(
      effect(() => {
        const value = flags.value$.value;
        void context.std.getOptional(EditorI18nProvider)?.locale$.value;
        const open =
          !flags.check(Flag.Hiding, value) &&
          flags.contains(
            Flag.Text | Flag.Native | Flag.Block | Flag.Hovering | Flag.Surface,
            value,
          );
        if (!open) {
          this.state$.value = { ...this.state$.peek(), open: false };
          return;
        }
        const flavour = flavour$.value;
        const resolved = resolveToolbarActions(context, flavour);
        const primary = presentToolbarActions(
          resolved.primaryActionGroup,
          context,
        );
        if (!primary.length) {
          context.reset();
          return;
        }
        const selection = JSON.stringify(
          std.selection.value.map((item) => item.toJSON()),
        );
        const key =
          flavour +
          ":" +
          context
            .getSurfaceModels()
            .map((model) => model.id)
            .join(",") +
          ":" +
          selection +
          ":" +
          (context.getCurrentModel()?.id ?? "");
        this.state$.value = {
          open: true,
          key,
          placement:
            placement$.value === "inner" ? "bottom-end" : placement$.value,
          primary,
          more: presentToolbarActions(resolved.moreActionGroup, context),
        };
      }),
    );
    disposables.add(
      effect(() => {
        const anchor = this.anchor$.value;
        const build = referenceElement$.value;
        const value = flags.value$.value;
        const placement = placement$.value;
        const side = sideOptions$.value;
        if (!anchor || !build || flags.check(Flag.Hiding, value) || !value)
          return;
        const reference = build();
        if (!reference) return;
        // The anchor is local to the widget overlay, including its containing-block offset.
        // Mantine portals and positions the popup from the actual anchor rectangle.
        return autoUpdate(
          reference,
          anchor,
          () => {
            const rect = reference.getBoundingClientRect();
            const top = side?.top ?? 0;
            const origin = this.widget.getBoundingClientRect();
            Object.assign(anchor.style, {
              position: "absolute",
              pointerEvents: "none",
              left: rect.left - origin.left + "px",
              top: rect.top - top - origin.top + "px",
              width: rect.width + "px",
              height: (placement === "inner" ? 0 : rect.height + top) + "px",
            });
          },
          { animationFrame: true, elementResize: false },
        );
      }),
    );
    disposables.add(() => {
      this.state$.value = { ...this.state$.peek(), open: false };
      this.toolbar = null;
      this.toolbarRegistry.floatingElement = null;
    });
  }
}
