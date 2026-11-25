import { registerAISharedEffects } from "./shared";

const appRegistries = new WeakSet<CustomElementRegistry>();

export function registerAIAppEffects() {
  const registry = customElements;
  if (appRegistries.has(registry)) return;
  appRegistries.add(registry);

  registerAISharedEffects();
}
