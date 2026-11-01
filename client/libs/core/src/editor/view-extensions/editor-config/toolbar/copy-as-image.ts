import { getSurfaceComponent } from "@virgultum/editor/blocks/surface";
import { editorMessage } from "@virgultum/editor/shared/services";
import { EditorService } from "@myoxus/core/modules/editor";
import { getDownloadUrl } from "@myoxus/core/modules/open-in-app/get-download-url-pure";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { I18n } from "@myoxus/i18n";
import { CopyAsImgaeIcon } from "@myoxus/icons/lit";
import type { FrameworkProvider } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import type { MenuContext } from "@virgultum/editor/components/toolbar";
import { Bound, getCommonBound } from "@virgultum/editor/global/gfx";
import type { BlockStdScope } from "@virgultum/editor/std";
import {
  type GfxBlockElementModel,
  getGfxManagedOwner,
  GfxControllerIdentifier,
  type GfxModel,
  GfxPrimitiveElementModel,
  isGfxGroupCompatibleModel,
} from "@virgultum/editor/std/gfx";

const snapshotStyle = `
  myoxus-edgeless-root .widgets-container,
  .copy-as-image-transparent {
    opacity: 0;
  }
  .edgeless-background {
    background-image: none;
  }
`;

function getSelectedRect() {
  const selected = document
    .querySelector("edgeless-selected-rect")
    ?.shadowRoot?.querySelector(".myoxus-edgeless-selected-rect");
  if (!selected) {
    throw new Error("Missing edgeless selected rect");
  }
  return selected.getBoundingClientRect();
}

function expandBound(bound: Bound, margin: number) {
  const x = bound.x - margin;
  const y = bound.y - margin;
  const w = bound.w + margin * 2;
  const h = bound.h + margin * 2;
  return new Bound(x, y, w, h);
}

function isOverlap(target: Bound, source: Bound) {
  const { x, y, w, h } = source;
  const left = target.x;
  const top = target.y;
  const right = target.x + target.w;
  const bottom = target.y + target.h;

  return x < right && y < bottom && x + w > left && y + h > top;
}

function isInside(target: Bound, source: Bound) {
  const { x, y, w, h } = source;
  const left = target.x;
  const top = target.y;
  const right = target.x + target.w;
  const bottom = target.y + target.h;

  return x >= left && y >= top && x + w <= right && y + h <= bottom;
}

function hideEdgelessElements(elements: GfxModel[], std: BlockStdScope) {
  const view = getSurfaceComponent(std);
  const restoreRenderer = view?.renderer.excludeElementsTemporarily(
    new Set(elements.map((element) => element.id)),
  );
  const hiddenBlocks: Element[] = [];
  for (const element of elements) {
    if (element instanceof GfxPrimitiveElementModel) continue;
    const block = std.view.getBlock(element.id);
    if (block) {
      block.classList.add("copy-as-image-transparent");
      hiddenBlocks.push(block);
    }
  }
  return () => {
    restoreRenderer?.();
    hiddenBlocks.forEach((block) =>
      block.classList.remove("copy-as-image-transparent"),
    );
  };
}

function withDescendantElements(elements: GfxModel[]) {
  const set = new Set<GfxModel>();
  elements.forEach((element) => {
    if (set.has(element)) return;
    set.add(element);
    if (isGfxGroupCompatibleModel(element)) {
      element.descendantElements.forEach((descendant) => set.add(descendant));
    }
  });
  return [...set];
}

const MARGIN = 20;
const apis = getDesktopBridge()?.apis;

export function copyAsImage(std: BlockStdScope) {
  if (!apis) {
    notify.error({
      title: I18n.t("com.myoxus.copy.asImage.notAvailable.title"),
      message: I18n.t("com.myoxus.copy.asImage.notAvailable.message"),
      actions: [
        {
          key: "download",
          label: I18n.t("com.myoxus.copy.asImage.notAvailable.action"),
          onClick: () => {
            window.open(getDownloadUrl());
          },
        },
      ],
    });
    return;
  }

  const gfx = std.get(GfxControllerIdentifier);

  let selected = gfx.selection.selectedElements;
  // Capture the complete semantic owner when one of its children is selected.
  const firstSelected = selected[0];
  const owner = firstSelected && getGfxManagedOwner(firstSelected);
  if (selected.length === 1 && owner)
    gfx.selection.set({ elements: [owner.id] });

  // select bound
  selected = gfx.selection.selectedElements;
  const elements = withDescendantElements(selected);
  const bounds = elements.map((element) => Bound.deserialize(element.xywh));
  const bound = getCommonBound(bounds);
  if (!bound) return;
  const { zoom } = gfx.viewport;
  const exBound = expandBound(bound, MARGIN * zoom);

  // fit to screen
  if (
    !isInside(gfx.viewport.viewportBounds, exBound) ||
    gfx.viewport.zoom < 1
  ) {
    gfx.viewport.setViewportByBound(bound, [20, 20, 20, 20], false);
    if (gfx.viewport.zoom > 1) {
      gfx.viewport.setZoom(1);
    }
  }

  // hide unselected overlap elements
  const overlapElements = gfx.gfxElements.filter((ele) => {
    const eleBound = Bound.deserialize(ele.xywh);
    const exEleBound = expandBound(eleBound, MARGIN * zoom);
    const isSelected = elements.includes(ele);
    return !isSelected && isOverlap(exBound, exEleBound);
  });
  const restoreElements = hideEdgelessElements(overlapElements, std);

  // add css style
  const styleEle = document.createElement("style");
  styleEle.innerHTML = snapshotStyle;
  document.head.append(styleEle);

  // capture image
  setTimeout(() => {
    if (!apis) return;
    try {
      const domRect = getSelectedRect();
      const { zoom } = gfx.viewport;
      const isFrameSelected =
        selected.length === 1 &&
        (selected[0] as GfxBlockElementModel).flavour === "myoxus:frame";
      const margin = isFrameSelected ? -2 : MARGIN * zoom;

      gfx.selection.clear();

      apis.ui
        .captureArea({
          x: domRect.left - margin,
          y: domRect.top - margin,
          width: domRect.width + margin * 2,
          height: domRect.height + margin * 2,
        })
        .then(() => {
          notify.success({
            title: I18n.t("com.myoxus.copy.asImage.success"),
          });
        })
        .catch((e) => {
          notify.error({
            title: I18n.t("com.myoxus.copy.asImage.failed"),
            message: String(e),
          });
        })
        .finally(() => {
          styleEle.remove();
          restoreElements();
        });
    } catch (e) {
      styleEle.remove();
      restoreElements();
      notify.error({
        title: I18n.t("com.myoxus.copy.asImage.failed"),
        message: String(e),
      });
    }
  }, 100);
}

export function createCopyAsPngMenuItem(framework: FrameworkProvider) {
  return {
    icon: CopyAsImgaeIcon({ width: "20", height: "20" }),
    label: editorMessage(
      "com.myoxus.editor.toolbar.copy-as-image",
      "Copy as Image",
    ),
    type: "copy-as-image",
    when: (ctx: MenuContext) => {
      if (ctx.isEmpty()) return false;
      const { editor } = framework.get(EditorService);
      const mode = editor.mode$.value;
      return mode === "edgeless";
    },
    action: (ctx: MenuContext) => {
      const std = ctx.std;
      return copyAsImage(std);
    },
  };
}
