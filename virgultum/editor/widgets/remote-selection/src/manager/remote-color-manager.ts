import { EditPropsStore } from "@virgultum/shared/services";
import type { BlockStdScope } from "@virgultum/std";

import { multiPlayersColor, vividRemoteColor } from "./color-picker";

export class RemoteColorManager {
  private get awarenessStore() {
    return this.std.store.awarenessStore;
  }

  constructor(readonly std: BlockStdScope) {
    const savedColor = this.std.get(EditPropsStore).getStorage("remoteColor");
    const sessionColor = savedColor ? vividRemoteColor(savedColor) : null;
    if (sessionColor) {
      this.awarenessStore.awareness.setLocalStateField("color", sessionColor);
      if (sessionColor !== savedColor)
        this.std.get(EditPropsStore).setStorage("remoteColor", sessionColor);
      return;
    }

    const pickColor = multiPlayersColor.pick();
    this.awarenessStore.awareness.setLocalStateField("color", pickColor);
    this.std.get(EditPropsStore).setStorage("remoteColor", pickColor);
  }

  get(id: number) {
    const awarenessColor = this.awarenessStore.getStates().get(id)?.color;
    if (awarenessColor) {
      return vividRemoteColor(awarenessColor);
    }

    if (id !== this.awarenessStore.awareness.clientID) return null;

    const sessionColor = this.std.get(EditPropsStore).getStorage("remoteColor");
    if (sessionColor) {
      this.awarenessStore.awareness.setLocalStateField("color", sessionColor);
      return sessionColor;
    }

    const pickColor = multiPlayersColor.pick();
    this.awarenessStore.awareness.setLocalStateField("color", pickColor);
    this.std.get(EditPropsStore).setStorage("remoteColor", pickColor);
    return pickColor;
  }
}
