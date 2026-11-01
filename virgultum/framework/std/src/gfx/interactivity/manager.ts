import { signal } from "@preact/signals-core";
import { type ServiceIdentifier } from "@virgultum/global/di";
import { DisposableGroup } from "@virgultum/global/disposable";

import type { PointerEventState } from "../../event/state/pointer.js";
import { GfxExtension, GfxExtensionIdentifier } from "../extension.js";
import type { GfxModel } from "../model/model.js";
import { CloneInteractionManager } from "./clone-interaction-manager.js";
import { createInteractionContext, type SupportedEvents } from "./event.js";
import {
  type InteractivityActionAPI,
  type InteractivityEventAPI,
  InteractivityExtensionIdentifier,
} from "./extension/base.js";
import { GfxViewEventManager } from "./gfx-view-event-handler.js";
import { MoveInteractionManager } from "./move-interaction-manager.js";
import { ResizeInteractionManager } from "./resize-interaction-manager.js";
import {
  type RotateConfigResult,
  RotateInteractionManager,
} from "./rotate-interaction-manager.js";
import type { SafeExecuteContext } from "./safe-execute-context.js";
import { formatSafeExecuteMessage } from "./safe-execute-formatter.js";
import { SelectionInteractionManager } from "./selection-interaction-manager.js";
import type { RequestElementsCloneContext } from "./types/clone.js";
import type { DragInitializationOption } from "./types/drag.js";
import type { BoxSelectionContext } from "./types/view.js";

type ExtensionPointerHandler = Exclude<
  SupportedEvents,
  "pointerleave" | "pointerenter"
>;

export const InteractivityIdentifier = GfxExtensionIdentifier(
  "interactivity-manager",
) as ServiceIdentifier<InteractivityManager>;

export class InteractivityManager extends GfxExtension {
  static override key = "interactivity-manager";

  private readonly _disposable = new DisposableGroup();

  private canvasEventHandler = new GfxViewEventManager(this.gfx);

  private selection = new SelectionInteractionManager(this);

  private move = new MoveInteractionManager(this);

  private resize = new ResizeInteractionManager(this);

  private rotate = new RotateInteractionManager(this);

  private clone = new CloneInteractionManager(this);

  override mounted(): void {
    this.canvasEventHandler = new GfxViewEventManager(this.gfx);
    this.selection = new SelectionInteractionManager(this);
    this.move = new MoveInteractionManager(this);
    this.resize = new ResizeInteractionManager(this);
    this.rotate = new RotateInteractionManager(this);
    this.clone = new CloneInteractionManager(this);
    this.interactExtensions.forEach((ext) => {
      ext.mounted();
    });
  }

  activeInteraction$ = signal<null | {
    type: "move" | "resize" | "rotate";
    elements: GfxModel[];
  } | null>(null);

  override unmounted(): void {
    this._disposable.dispose();
    this.interactExtensions.forEach((ext) => {
      ext.unmounted();
    });
  }

  get interactExtensions() {
    return this.std.provider.getAll(InteractivityExtensionIdentifier);
  }

  get keyboard() {
    return this.gfx.keyboard;
  }

  // ===== G-02 Public API fuer Sub-Manager =====
  // Die Sub-Manager (Selection, Move, Resize, Rotate, Clone) duerfen
  // nicht direkt auf `this.gfx` / `this.std` / `this.interactExtensions`
  // zugreifen — diese sind in `GfxExtension` `protected`. Stattdessen
  // reichen wir hier minimal die Sicht nach aussen, die ein Sub-Manager
  // braucht. Bewusst les-only: kein Setter, kein Mutations-Pfad.

  /** @internal Wird ausschliesslich von Sub-Managern benutzt. */
  get _gfx() {
    return this.gfx;
  }

  /** @internal Wird ausschliesslich von Sub-Managern benutzt. */
  get _std() {
    return this.std;
  }

  /** @internal Wird ausschliesslich von Sub-Managern benutzt. */
  get _interactExtensions() {
    return this.interactExtensions;
  }

  /**
   * @internal Wird ausschliesslich von Sub-Managern benutzt.
   * `activeInteraction$` muss von aussen beschreibbar sein, weil
   * z.B. `MoveInteractionManager` waehrend `onDragStart` auf
   * `{ type: "move" }` setzt.
   */
  get _activeInteraction$() {
    return this.activeInteraction$;
  }

  /**
   * @internal Used by the GFX interactivity sub-managers
   * to look up the current editor mode for
   * `SafeExecuteContext`. P-VIRG-ARCH-H-02-Slice-2
   * wires the actual `DocModeProvider` lookup at the
   * host boundary; see `GfxController.setModeResolver`.
   *
   * Returns `undefined` when no resolver has been
   * registered; the formatter renders `?` for the
   * unknown-mode case.
   */
  get _currentMode() {
    return this.gfx.getMode();
  }

  // ===== /G-02 Public API fuer Sub-Manager =====

  /**
   * @internal Wird ausschliesslich von Sub-Managern benutzt.
   * Bewusst public, damit Sub-Manager in eigenstaendigen
   * Extension-Hooks nicht in eine `try/catch`-Wiederholung
   * verfallen.
   *
   * **P-VIRG-ARCH-H-02 (Observability, Slice 1):** the
   * error is logged with a structured
   * `SafeExecuteContext` (operation, mode, flavours,
   * elementCount) so console.log reading can identify
   * which dispatch crashed without attaching a
   * debugger. The thrown error object is still passed
   * to `console.error` as a second argument to preserve
   * the stack trace.
   */
  _safeExecute(fn: () => void, ctx: SafeExecuteContext) {
    try {
      fn();
    } catch (e) {
      console.error(formatSafeExecuteMessage(ctx, e), e);
    }
  }

  /**
   * Dispatch event to extensions and gfx view.
   * @param eventName
   * @param evt
   * @returns
   */
  dispatchEvent(eventName: ExtensionPointerHandler, evt: PointerEventState) {
    if (this.activeInteraction$.peek()) {
      return;
    }

    const { context, preventDefaultState } = createInteractionContext(evt);
    const extensions = this.interactExtensions;

    extensions.forEach((ext) => {
      (ext.event as InteractivityEventAPI).emit(eventName, context);
    });

    const handledByView =
      this.canvasEventHandler.dispatch(eventName, evt) ?? false;

    return {
      preventDefaultState,
      handledByView,
    };
  }

  // ===== G-02 Sub-Manager-Delegation =====
  // Selection-bezogene Methoden leiten an `SelectionInteractionManager`
  // weiter. Die Sub-Manager-Klasse beheimatet die volle Logik;
  // die oeffentliche Signatur bleibt unveraendert, damit externe
  // Konsumenten (z.B. `default-tool.ts:98, 161, 214`) ohne Anpassung
  // weiterarbeiten.

  /**
   * @see SelectionInteractionManager#handleElementSelection
   */
  handleElementSelection = (evt: PointerEventState) =>
    this.selection.handleElementSelection(evt);

  /**
   * @see SelectionInteractionManager#handleBoxSelection
   */
  handleBoxSelection = (context: { box: BoxSelectionContext["box"] }) =>
    this.selection.handleBoxSelection(context);

  // ===== /G-02 Sub-Manager-Delegation =====

  /** Resolve semantic membership without changing selection or geometry. */
  resolveMoveElements(elements: readonly GfxModel[]): GfxModel[] {
    const context = { elements: [...elements] };
    for (const extension of this.interactExtensions.values()) {
      (extension.action as InteractivityActionAPI).emit(
        "moveElements",
        context,
      );
    }
    // A member can be selected directly and included through several nested
    // containers. Native movement must write each actual model exactly once.
    return [
      ...new Map(context.elements.map((model) => [model.id, model])).values(),
    ];
  }

  /** @see MoveInteractionManager#handleElementMove */
  handleElementMove = (options: DragInitializationOption) =>
    this.move.handleElementMove(options);

  // ===== G-02 Sub-Manager-Delegation (Rotate) =====
  // Rotate-bezogene Methoden leiten an `RotateInteractionManager`
  // weiter. Die Sub-Manager-Klasse beheimatet die volle Logik;
  // die oeffentliche Signatur bleibt unveraendert, damit externe
  // Konsumenten (z.B. `default-tool.ts:140 ff.`) ohne Anpassung
  // weiterarbeiten.

  /**
   * @see RotateInteractionManager#getRotateConfig
   */
  getRotateConfig = (options: { elements: GfxModel[] }): RotateConfigResult =>
    this.rotate.getRotateConfig(options);

  /**
   * @see RotateInteractionManager#handleElementRotate
   */
  handleElementRotate = (
    options: Parameters<RotateInteractionManager["handleElementRotate"]>[0],
  ) => this.rotate.handleElementRotate(options);

  // ===== /G-02 Sub-Manager-Delegation (Rotate) =====

  // ===== G-02 Sub-Manager-Delegation (Resize) =====
  // Resize-bezogene Methoden leiten an `ResizeInteractionManager`
  // weiter. Die Sub-Manager-Klasse beheimatet die volle Logik;
  // die oeffentliche Signatur bleibt unveraendert, damit externe
  // Konsumenten (z.B. `default-tool.ts:118 ff.`) ohne Anpassung
  // weiterarbeiten.

  /**
   * @see ResizeInteractionManager#getResizeHandlers
   */
  getResizeHandlers = (options: { elements: GfxModel[] }) =>
    this.resize.getResizeHandlers(options);

  /**
   * @see ResizeInteractionManager#handleElementResize
   */
  handleElementResize = (
    options: Parameters<ResizeInteractionManager["handleElementResize"]>[0],
  ) => this.resize.handleElementResize(options);

  // ===== /G-02 Sub-Manager-Delegation (Resize) =====

  /**
   * @see CloneInteractionManager#requestElementClone
   */
  requestElementClone = (options: RequestElementsCloneContext) =>
    this.clone.requestElementClone(options);
}
