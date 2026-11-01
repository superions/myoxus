import groupBy from "lodash-es/groupBy";
import mergeWith from "lodash-es/mergeWith";
import orderBy from "lodash-es/orderBy";
import partition from "lodash-es/partition";
import toPairs from "lodash-es/toPairs";

import {
  ActionPlacement,
  type ToolbarAction,
  type ToolbarControl,
  type ToolbarActions,
} from "./action";
import type { ToolbarContext } from "./context";

export const defaultToolbarScore = Number.MAX_SAFE_INTEGER;

export function combine(actions: ToolbarActions, context: ToolbarContext) {
  const grouped = group(actions);

  const generated = grouped.map((action) => {
    const newAction = {
      ...action,
      placement: action.placement ?? ActionPlacement.Normal,
    };

    if ("generate" in action && typeof action.generate === "function") {
      // TODO(@fundon): should delete `generate` fn
      return {
        ...newAction,
        ...action.generate(context),
      };
    }

    return newAction;
  });

  const filtered = generated.filter((action) => {
    if (typeof action.when === "function") return action.when(context);
    return action.when ?? true;
  });

  return filtered;
}

function group(actions: ToolbarAction[]): ToolbarAction[] {
  const grouped = groupBy(actions, (a) => a.id);

  const paired = toPairs(grouped).map(([_, items]) => {
    if (items.length === 1) return items[0];
    const [first, ...others] = items;
    if (others.length === 1) return merge({ ...first }, others[0]);
    return others.reduce(merge, { ...first });
  });

  return paired;
}

const merge = (a: any, b: any) =>
  mergeWith(a, b, (obj, src) =>
    Array.isArray(obj) ? group(obj.concat(src)) : src,
  );

/** Resolves module precedence and action placement without rendering UI.
 * Custom IDs use the same flavour namespace as their base modules.
 */
export function resolveToolbarActions(
  context: ToolbarContext,
  flavour: string,
) {
  const hasSurfaceScope = flavour.includes("surface");
  const toolbarRegistry = context.toolbarRegistry;
  const customFlavour = `custom:${flavour}`;
  const customModule = toolbarRegistry.modules.get(customFlavour);
  const customModuleActive = Boolean(
    customModule &&
    (typeof customModule.config.when === "function"
      ? customModule.config.when(context)
      : (customModule.config.when ?? true)),
  );
  const replacesBase = Boolean(
    customModuleActive && customModule?.config.replaceBase,
  );

  const actions = [
    replacesBase ? [] : flavour,
    hasSurfaceScope && replacesBase
      ? ["myoxus:surface:*", "custom:myoxus:surface:*"]
      : [],
    customFlavour,
    hasSurfaceScope && !replacesBase
      ? ["myoxus:surface:*", "custom:myoxus:surface:*"]
      : [],
    "myoxus:*",
    "custom:myoxus:*",
  ]
    .flat()
    .map((key) => toolbarRegistry.modules.get(key))
    .filter((module) => !!module)
    .filter((module) =>
      typeof module.config.when === "function"
        ? module.config.when(context)
        : (module.config.when ?? true),
    )
    .flatMap((module) => module.config.actions);

  const combined = combine(actions, context);

  const ordered = orderBy(
    combined,
    ["placement", (action) => action.score ?? defaultToolbarScore, "id"],
    ["asc", "asc", "asc"],
  );

  const [moreActionGroup, primaryActionGroup] = partition(
    ordered,
    (a) => a.placement === ActionPlacement.More,
  );

  return { primaryActionGroup, moreActionGroup };
}

/** Native choices reuse the same resolved leaves as the command menu. */
export function resolveToolbarChoice(
  actions: ToolbarActions,
  context: ToolbarContext,
  value: string | null | undefined,
  onOpen?: () => void,
): ToolbarControl {
  const available = combine(actions, context) as ToolbarAction[];
  return {
    type: "choice",
    value: value ?? null,
    onOpen,
    options: available.map((action) => ({
      value: action.id,
      label:
        action.label ?? (action.tooltip as ToolbarAction["label"]) ?? action.id,
      icon: typeof action.icon === "string" ? action.icon : undefined,
      disabled:
        typeof action.disabled === "function"
          ? action.disabled(context)
          : action.disabled,
    })),
    change(value) {
      const action = available.find((action) => action.id === value);
      if (
        !action ||
        (typeof action.disabled === "function"
          ? action.disabled(context)
          : action.disabled)
      )
        return;
      action.run?.(context);
    },
  };
}
