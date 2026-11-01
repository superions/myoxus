import { signal } from "@preact/signals-core";
import { type Container, createIdentifier } from "@virgultum/global/di";
import { type BlockStdScope, StdIdentifier } from "@virgultum/std";
import type { GfxModel } from "@virgultum/std/gfx";
import { Extension, type ExtensionType } from "@virgultum/store";

import type { ToolbarPlacement } from "./config";
import { Flags } from "./flags";
import type { ToolbarModule } from "./module";

export const ToolbarModuleIdentifier = createIdentifier<ToolbarModule>(
  "MyoxusToolbarModuleIdentifier",
);

export const ToolbarRegistryIdentifier =
  createIdentifier<ToolbarRegistryExtension>("MyoxusToolbarRegistryIdentifier");

export function ToolbarModuleExtension(module: ToolbarModule): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(ToolbarModuleIdentifier(module.id.variant), module);
    },
  };
}

export class ToolbarRegistryExtension extends Extension {
  /** The scoped native popup can own keyboard focus outside the editor DOM. */
  floatingElement: HTMLElement | null = null;

  flavour$ = signal<string>("myoxus:note");

  elementsMap$ = signal<Map<string, GfxModel[]>>(new Map());

  message$ = signal<{
    flavour: string;
    element: Element;
    setFloating: (element?: Element) => void;
  } | null>(null);

  placement$ = signal<ToolbarPlacement>("top");

  flags = new Flags();

  constructor(readonly std: BlockStdScope) {
    super();
  }

  get readonlyTextSelectionActive() {
    return (
      this.std.store.readonly &&
      [...this.std.provider.getAll(ToolbarModuleIdentifier).values()].some(
        (module) => Boolean(module.config.readonlyTextSelection?.(this.std)),
      )
    );
  }

  get modules() {
    const modules = this.std.provider.getAll(ToolbarModuleIdentifier);
    if (!this.readonlyTextSelectionActive) return modules;
    return new Map(
      [...modules].flatMap(([key, module]) => {
        const actions = module.config.readonlyTextSelection?.(this.std);
        return actions
          ? [
              [
                key,
                { ...module, config: { ...module.config, actions } },
              ] as const,
            ]
          : [];
      }),
    );
  }

  getModuleBy(flavour: string) {
    return this.modules.get(flavour)?.config ?? null;
  }

  getModulePlacement(flavour: string, fallback: ToolbarPlacement = "top") {
    return (
      this.getModuleBy(`custom:${flavour}`)?.placement ??
      this.getModuleBy(flavour)?.placement ??
      fallback
    );
  }

  static override setup(di: Container) {
    di.addImpl(ToolbarRegistryIdentifier, this, [StdIdentifier]);
  }
}
