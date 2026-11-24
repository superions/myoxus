import { DisposableGroup } from "../../primitives/disposable/index";
import {
  getCommonBoundWithRotation,
  type IPoint,
} from "../../primitives/gfx/index";
import { assertType } from "../../primitives/utils/index";
import groupBy from "lodash-es/groupBy";
import { Subject } from "rxjs";

import { CursorSelection, SurfaceSelection } from "../selection/index.js";
import type { GfxController } from "./controller.js";
import { GfxExtension, GfxExtensionIdentifier } from "./extension.js";
import type { GfxModel } from "./model/model.js";
import { GfxGroupLikeElementModel } from "./model/surface/element-model.js";

export interface SurfaceSelectionState {
  /**
   * The selected elements. Could be blocks or canvas elements
   */
  elements: string[];

  /**
   * Indicate whether the selected element is in editing mode
   */
  editing?: boolean;

  /**
   *  Cannot be operated, only box is displayed
   */
  inoperable?: boolean;
}

/**
 * GfxSelectionManager is just a wrapper of std selection providing
 * convenient method and states in gfx
 */
export class GfxSelectionManager extends GfxExtension {
  static override key = "gfxSelection";

  private _activeGroup: GfxGroupLikeElementModel | null = null;

  private _cursorSelection: CursorSelection | null = null;

  private _lastSurfaceSelections: SurfaceSelection[] = [];

  private _selectedSet = new Set<string>();

  private _surfaceSelections: SurfaceSelection[] = [];

  disposable: DisposableGroup = new DisposableGroup();

  readonly slots = {
    updated: new Subject<SurfaceSelection[]>(),

    cursorUpdated: new Subject<CursorSelection>(),
  };

  get activeGroup() {
    return this._activeGroup;
  }

  get cursorSelection() {
    return this._cursorSelection;
  }

  get editing() {
    return this.surfaceSelections.some((sel) => sel.editing);
  }

  get empty() {
    return this.surfaceSelections.every((sel) => sel.elements.length === 0);
  }

  get firstElement() {
    return this.selectedElements[0];
  }

  get inoperable() {
    return this.surfaceSelections.some((sel) => sel.inoperable);
  }

  get lastSurfaceSelections() {
    return this._lastSurfaceSelections;
  }

  get selectedBound() {
    return getCommonBoundWithRotation(this.selectedElements);
  }

  get selectedElements() {
    const elements: GfxModel[] = [];

    this.selectedIds.forEach((id) => {
      const el = this.gfx.getElementById(id) as GfxModel;
      el && elements.push(el);
    });

    return elements;
  }

  get selectedIds() {
    return [...this._selectedSet];
  }

  get selectedSet() {
    return this._selectedSet;
  }

  get stdSelection() {
    return this.std.selection;
  }

  get surfaceModel() {
    return this.gfx.surface;
  }

  get surfaceSelections() {
    return this._surfaceSelections;
  }

  static override extendGfx(gfx: GfxController): void {
    Object.defineProperty(gfx, "selection", {
      get() {
        return this.std.get(GfxExtensionIdentifier("gfxSelection"));
      },
    });
  }

  clear() {
    this.stdSelection.clear();

    this.set({
      elements: [],
      editing: false,
    });
  }

  clearLast() {
    this._lastSurfaceSelections = [];
  }

  equals(selection: SurfaceSelection[]) {
    let count = 0;
    let editing = false;
    const exist = selection.every((sel) => {
      const exist = sel.elements.every((id) => this._selectedSet.has(id));

      if (exist) {
        count += sel.elements.length;
      }

      if (sel.editing) editing = true;

      return exist;
    });

    return (
      exist && count === this._selectedSet.size && editing === this.editing
    );
  }

  /**
   * check if the element is selected in local
   * @param element
   */
  has(element: string) {
    return this._selectedSet.has(element);
  }

  /**
   * check if element is selected by remote peers
   * @param element
   */

  isEmpty(selections: SurfaceSelection[]) {
    return selections.every((sel) => sel.elements.length === 0);
  }

  isInSelectedRect(modelX: number, modelY: number) {
    const selected = this.selectedElements;
    if (!selected.length) return false;

    const commonBound = getCommonBoundWithRotation(selected);
    if (commonBound && commonBound.isPointInBound([modelX, modelY])) {
      return true;
    }
    return false;
  }

  override mounted() {
    this.disposable.add(
      this.stdSelection.slots.changed.subscribe((selections) => {
        const { cursor = [], surface = [] } = groupBy(selections, (sel) => {
          if (sel.is(SurfaceSelection)) {
            return "surface";
          } else if (sel.is(CursorSelection)) {
            return "cursor";
          }

          return "none";
        });

        assertType<CursorSelection[]>(cursor);
        assertType<SurfaceSelection[]>(surface);

        if (cursor[0] && !this.cursorSelection?.equals(cursor[0])) {
          this._cursorSelection = cursor[0];
          this.slots.cursorUpdated.next(cursor[0]);
        }

        if ((surface.length === 0 && this.empty) || this.equals(surface)) {
          return;
        }

        this._lastSurfaceSelections = this.surfaceSelections;
        this._surfaceSelections = surface;
        this._selectedSet = new Set<string>();

        surface.forEach((sel) =>
          sel.elements.forEach((id) => {
            this._selectedSet.add(id);
          }),
        );

        this.slots.updated.next(this.surfaceSelections);
      }),
    );
  }

  set(selection: SurfaceSelectionState | SurfaceSelection[]) {
    if (Array.isArray(selection)) {
      this.stdSelection.setGroup(
        "gfx",
        this.cursorSelection ? [...selection, this.cursorSelection] : selection,
      );
      return;
    }

    const { blocks = [], elements = [] } = groupBy(selection.elements, (id) => {
      return this.std.store.hasBlock(id) ? "blocks" : "elements";
    });
    let instances: (SurfaceSelection | CursorSelection)[] = [];

    if (elements.length > 0 && this.surfaceModel) {
      instances.push(
        this.stdSelection.create(
          SurfaceSelection,
          this.surfaceModel.id,
          elements,
          selection.editing ?? false,
          selection.inoperable,
        ),
      );
    }

    if (blocks.length > 0) {
      instances = instances.concat(
        blocks.map((blockId) =>
          this.stdSelection.create(
            SurfaceSelection,
            blockId,
            [blockId],
            selection.editing ?? false,
            selection.inoperable,
          ),
        ),
      );
    }

    this.stdSelection.setGroup(
      "gfx",
      this.cursorSelection
        ? instances.concat([this.cursorSelection])
        : instances,
    );

    if (instances.length > 0) {
      this.stdSelection.setGroup("note", []);
    }

    if (
      selection.elements.length === 1 &&
      this.firstElement instanceof GfxGroupLikeElementModel
    ) {
      this._activeGroup = this.firstElement;
    } else {
      if (
        this.selectedElements.some((ele) => ele.group !== this._activeGroup) ||
        this.selectedElements.length === 0
      ) {
        this._activeGroup = null;
      }
    }
  }

  /**
   * Toggle the selection state of single element
   * @param element
   * @returns
   */
  toggle(element: GfxModel | string) {
    element = typeof element === "string" ? element : element.id;

    this.set({
      elements: this.has(element)
        ? this.selectedIds.filter((id) => id !== element)
        : [...this.selectedIds, element],
    });
  }

  setCursor(cursor: CursorSelection | IPoint) {
    const instance = this.stdSelection.create(
      CursorSelection,
      cursor.x,
      cursor.y,
    );

    this.stdSelection.setGroup("gfx", [...this.surfaceSelections, instance]);
  }

  override unmounted() {
    this.disposable.dispose();
  }
}

declare module "./controller.js" {
  interface GfxController {
    readonly selection: GfxSelectionManager;
  }
}
