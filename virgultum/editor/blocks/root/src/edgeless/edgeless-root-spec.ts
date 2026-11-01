import { LifeCycleWatcher } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";

export class EdgelessLocker extends LifeCycleWatcher {
  static override key = "edgeless-locker";

  override mounted() {
    const { viewport } = this.std.get(GfxControllerIdentifier);
    viewport.locked = true;
  }
}
