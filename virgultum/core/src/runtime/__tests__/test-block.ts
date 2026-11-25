import { effect, signal } from "@preact/signals-core";

import { GfxControllerIdentifier } from "../gfx/identifiers.js";
import type {
  BoxSelectionContext,
  DragMoveContext,
} from "../gfx/interactivity/index.js";
import {
  bindGfxBlockView,
  type GfxBlockComponent,
  GfxElementSymbol,
  gfxBlockRenderingRect,
  gfxBlockTransform,
  moveGfxBlock,
  NativeContainerBlock,
} from "../view/index.js";
import type {
  HeadingBlockModel,
  NoteBlockModel,
  RootBlockModel,
  SurfaceBlockModel,
  TestGfxBlockModel,
} from "./test-schema.js";

function defineTestElement(tag: string, ctor: CustomElementConstructor) {
  if (!customElements.get(tag)) {
    customElements.define(tag, ctor);
  }
}

export class RootBlockComponent extends NativeContainerBlock<RootBlockModel> {
  protected readonly blockStyles = "";
  protected mountBody() {
    const div = this.ownerDocument.createElement("div");
    div.className = "test-root-block";
    this.replaceChildren(div);
    return div;
  }
}
defineTestElement("test-root-block", RootBlockComponent);

export class NoteBlockComponent extends NativeContainerBlock<NoteBlockModel> {
  protected readonly blockStyles = "";
  protected mountBody() {
    const div = this.ownerDocument.createElement("div");
    div.className = "test-note-block";
    this.replaceChildren(div);
    return div;
  }
}
defineTestElement("test-note-block", NoteBlockComponent);

export class HeadingH1BlockComponent extends NativeContainerBlock<HeadingBlockModel> {
  protected readonly blockStyles = "";
  protected mountBody() {
    const div = this.ownerDocument.createElement("div");
    div.className = "test-heading-block h1";
    this.disposables.add(
      effect(() => {
        div.textContent = String(this.model.props.text ?? "");
      }),
    );
    this.replaceChildren(div);
    return null;
  }
}
defineTestElement("test-h1-block", HeadingH1BlockComponent);

export class HeadingH2BlockComponent extends NativeContainerBlock<HeadingBlockModel> {
  protected readonly blockStyles = "";
  protected mountBody() {
    const div = this.ownerDocument.createElement("div");
    div.className = "test-heading-block h2";
    this.disposables.add(
      effect(() => {
        div.textContent = String(this.model.props.text ?? "");
      }),
    );
    this.replaceChildren(div);
    return null;
  }
}
defineTestElement("test-h2-block", HeadingH2BlockComponent);

export class SurfaceBlockComponent extends NativeContainerBlock<SurfaceBlockModel> {
  protected readonly blockStyles = "";
  protected mountBody() {
    const div = this.ownerDocument.createElement("div");
    div.className = "test-surface-block";
    this.replaceChildren(div);
    return div;
  }
}
defineTestElement("test-surface-block", SurfaceBlockComponent);

export class TestGfxBlockComponent
  extends NativeContainerBlock<TestGfxBlockModel>
  implements GfxBlockComponent<TestGfxBlockModel>
{
  [GfxElementSymbol] = true;
  readonly transformState$ = signal<"idle" | "active">("active");
  protected readonly blockStyles = "";

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  onDragMove = (context: DragMoveContext) => moveGfxBlock(this.model, context);
  onDragStart() {
    this.model.stash("xywh");
  }
  onDragEnd() {
    this.model.pop("xywh");
  }
  onBoxSelected(_: BoxSelectionContext) {}
  getCSSTransform() {
    return gfxBlockTransform(this);
  }
  getRenderingRect() {
    return gfxBlockRenderingRect(this);
  }
  toZIndex() {
    return this.gfx.layer.getZIndex(this.model).toString() ?? "0";
  }
  updateZIndex() {
    this.style.zIndex = this.toZIndex();
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.std) {
      bindGfxBlockView(this);
      this.disposables.add(
        effect(() => {
          const { x, y, w, h, zIndex } = this.getRenderingRect();
          this.style.left = `${x}px`;
          this.style.top = `${y}px`;
          this.style.width = `${w}px`;
          this.style.height = `${h}px`;
          this.style.zIndex = zIndex;
        }),
      );
    }
  }

  protected mountBody() {
    const div = this.ownerDocument.createElement("div");
    div.className = "test-gfx-block";
    this.replaceChildren(div);
    return div;
  }
}
defineTestElement("test-gfx-block", TestGfxBlockComponent);
