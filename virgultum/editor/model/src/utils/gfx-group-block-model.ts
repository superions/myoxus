// SPDX-License-Identifier: MIT

import { Bound } from "@virgultum/global/gfx";
import type { Constructor } from "@virgultum/global/utils";
import {
  canSafeAddToContainer,
  descendantElementsImpl,
  GfxBlockElementModel,
  type GfxCompatibleProps,
  type GfxGroupCompatibleInterface,
  type GfxModel,
  gfxGroupCompatibleSymbol,
  hasDescendantElementImpl,
  type PointTestOptions,
} from "@virgultum/std/gfx";

export type GfxGroupChildProps = {
  childElementIds?: Record<string, boolean>;
};

export class GfxGroupBlockElementModel<
  Props extends GfxCompatibleProps & GfxGroupChildProps,
>
  extends GfxBlockElementModel<Props>
  implements GfxGroupCompatibleInterface
{
  [gfxGroupCompatibleSymbol] = true as const;

  get childElements() {
    if (!this.surface) return [];

    const elements: GfxModel[] = [];
    for (const key of this.childIds) {
      const element =
        this.surface.getElementById(key) ||
        (this.surface.store.getModelById(key) as GfxBlockElementModel);
      if (element) elements.push(element);
    }
    return elements;
  }

  get childIds() {
    return this.props.childElementIds
      ? Object.keys(this.props.childElementIds)
      : [];
  }

  get descendantElements(): GfxModel[] {
    return descendantElementsImpl(this);
  }

  addChild(element: GfxModel) {
    if (!canSafeAddToContainer(this, element)) return;

    this.store.transact(() => {
      this.props.childElementIds = {
        ...this.props.childElementIds,
        [element.id]: true,
      };
    });
  }

  addChildren(elements: GfxModel[]): void {
    elements = [...new Set(elements)].filter((element) =>
      canSafeAddToContainer(this, element),
    );

    const newChildren: Record<string, boolean> = {};
    for (const element of elements) {
      newChildren[element.id] = true;
    }

    this.store.transact(() => {
      this.props.childElementIds = {
        ...this.props.childElementIds,
        ...newChildren,
      };
    });
  }

  override containsBound(bound: Bound): boolean {
    return this.elementBound.contains(bound);
  }

  hasChild(element: GfxModel): boolean {
    return this.props.childElementIds
      ? element.id in this.props.childElementIds
      : false;
  }

  hasDescendant(element: GfxModel): boolean {
    return hasDescendantElementImpl(this, element);
  }

  override includesPoint(x: number, y: number, _: PointTestOptions): boolean {
    return Bound.deserialize(this.xywh).isPointInBound([x, y]);
  }

  override intersectsBound(selectedBound: Bound): boolean {
    const bound = Bound.deserialize(this.xywh);
    return (
      bound.isIntersectWithBound(selectedBound) || selectedBound.contains(bound)
    );
  }

  removeChild(element: GfxModel): void {
    this.removeChildren([element]);
  }

  removeChildren(elements: GfxModel[]): void {
    const childIds = [...new Set(elements.map((element) => element.id))];
    if (!this.props.childElementIds || childIds.length === 0) return;
    const childIdSet = new Set(childIds);

    this.store.transact(() => {
      const childElementIds = this.props.childElementIds;
      if (!childElementIds) return;
      this.props.childElementIds = Object.fromEntries(
        Object.entries(childElementIds).filter(
          ([childId]) => !childIdSet.has(childId),
        ),
      );
    });
  }
}

export function GfxGroupCompatibleBlockModel<
  Props extends GfxCompatibleProps & GfxGroupChildProps,
  Base extends Constructor<GfxBlockElementModel<Props>> = Constructor<
    GfxBlockElementModel<Props>
  >,
>(BaseModel: Base) {
  if (BaseModel === GfxBlockElementModel) {
    return GfxGroupBlockElementModel as unknown as typeof GfxGroupBlockElementModel<Props>;
  }

  let currentClass = BaseModel;
  while (
    Object.getPrototypeOf(currentClass.prototype) !==
      GfxBlockElementModel.prototype &&
    Object.getPrototypeOf(currentClass.prototype) !== null
  ) {
    currentClass = Object.getPrototypeOf(currentClass.prototype).constructor;
  }
  if (
    Object.getPrototypeOf(currentClass.prototype) ===
    GfxBlockElementModel.prototype
  ) {
    Object.setPrototypeOf(
      currentClass.prototype,
      GfxGroupBlockElementModel.prototype,
    );
  }
  return BaseModel as unknown as typeof GfxGroupBlockElementModel<Props>;
}
