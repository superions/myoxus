const sharedRegistries = new WeakSet<CustomElementRegistry>();

export function registerAISharedEffects() {
  const registry = customElements;
  if (sharedRegistries.has(registry)) return;
  sharedRegistries.add(registry);
}
