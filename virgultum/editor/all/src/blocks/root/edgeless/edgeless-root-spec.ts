import { LifeCycleWatcher } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";

export class EdgelessLocker extends LifeCycleWatcher {
  static override key = "edgeless-locker";

  override mounted() {
    const { viewport } = this.std.get(GfxControllerIdentifier);
    viewport.locked = true;
  }
}
