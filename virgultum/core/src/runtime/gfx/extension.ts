import { type Container, createIdentifier } from "../../primitives/di/index";
import { ErrorCode, VirgultumError } from "../../primitives/exceptions/index";
import { Extension } from "../../store/index";

import type { GfxController } from "./controller.js";
import { GfxControllerIdentifier } from "./identifiers.js";

export const GfxExtensionIdentifier =
  createIdentifier<Pick<GfxExtension, "mounted" | "unmounted">>("GfxExtension");

/** Spatial indices consume model notifications, independent of the mounted
 * editor or its interaction extensions. Both runtime entries use these owners. */
export type CanvasIndexSource = Pick<
  GfxController,
  "doc" | "surface" | "surface$"
>;
export abstract class CanvasIndex extends Extension {
  static key: string;
  constructor(protected readonly source: CanvasIndexSource) {
    super();
  }
  abstract mounted(): void;
  abstract unmounted(): void;
  static override setup(di: Container) {
    di.add(this as unknown as { new (gfx: CanvasIndexSource): CanvasIndex }, [
      GfxControllerIdentifier,
    ]);
    di.addImpl(GfxExtensionIdentifier(this.key), (p) => p.get(this));
  }
}

export const GfxClassExtenderIdentifier = createIdentifier<{
  extendFn: (gfx: GfxController) => void;
}>("GfxClassExtender");

export abstract class GfxExtension extends Extension {
  static key: string;

  get std() {
    return this.gfx.std;
  }

  constructor(protected readonly gfx: GfxController) {
    super();
  }

  // This method is used to extend the GfxController
  static extendGfx(_: GfxController) {}

  static override setup(di: Container) {
    if (!this.key) {
      throw new VirgultumError(
        ErrorCode.ValueNotExists,
        "key is not defined in the GfxExtension",
      );
    }

    di.addImpl(GfxClassExtenderIdentifier(this.key), {
      extendFn: this.extendGfx,
    });

    di.add(this as unknown as { new (gfx: GfxController): GfxExtension }, [
      GfxControllerIdentifier,
    ]);

    di.addImpl(GfxExtensionIdentifier(this.key), (provider) =>
      provider.get(this),
    );
  }

  mounted() {}

  unmounted() {}
}
