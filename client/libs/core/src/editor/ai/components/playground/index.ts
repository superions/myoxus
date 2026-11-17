import { PlaygroundChat } from "./chat";
import { PlaygroundContent } from "./content";

export function effects() {
  customElements.define("playground-chat", PlaygroundChat);
  customElements.define("playground-content", PlaygroundContent);
}
