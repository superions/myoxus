import type { Store } from "@virgultum/core/store";
import { multiPlayersColor, vividRemoteColor } from "./color-picker";

const sessionKey = "virgultum:remote-color";

export class RemoteColorManager {
  private readonly color: string;
  constructor(private readonly awarenessStore: Store["awarenessStore"]) {
    let saved: unknown;
    try {
      saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? "null");
    } catch {
      /* An unreadable preference has no bearing on presence. */
    }
    this.color =
      typeof saved === "string" && saved
        ? vividRemoteColor(saved)
        : multiPlayersColor.pick();
    if (saved !== this.color) {
      try {
        sessionStorage.setItem(sessionKey, JSON.stringify(this.color));
      } catch {
        /* The session can still publish its color. */
      }
    }
    awarenessStore.awareness.setLocalStateField("color", this.color);
  }
  get(id: number) {
    const color = this.awarenessStore.getStates().get(id)?.color;
    if (color) return vividRemoteColor(color);
    if (id !== this.awarenessStore.awareness.clientID) return null;
    this.awarenessStore.awareness.setLocalStateField("color", this.color);
    return this.color;
  }
}
