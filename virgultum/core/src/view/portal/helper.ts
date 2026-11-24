import { VirgultumError } from "@virgultum/core/primitives/exceptions";
import type { ComputePositionReturn } from "@floating-ui/dom";
import { positionPortal } from "./popup";
import { render } from "lit";
import { Subject } from "rxjs";

import type { AdvancedPortalOptions, PortalOptions } from "./types";

/**
 * Similar to `<virgultum-portal>`, but only renders once when called.
 *
 * The template should be a **static** template since it will not be re-rendered unless `updatePortal` is called.
 *
 * See {@link Portal} for more details.
 */
export function createSimplePortal({
  template,
  container = document.body,
  signal = new AbortController().signal,
  renderOptions,
  shadowDom = true,
  identifyWrapper = true,
}: PortalOptions) {
  const portalRoot = document.createElement("div");
  if (identifyWrapper) {
    portalRoot.classList.add("virgultum-portal");
  }
  if (shadowDom) {
    portalRoot.attachShadow({
      mode: "open",
      ...(typeof shadowDom !== "boolean" ? shadowDom : {}),
    });
  }
  signal.addEventListener("abort", () => {
    portalRoot.remove();
  });

  const root = shadowDom ? portalRoot.shadowRoot : portalRoot;
  if (!root) {
    throw new VirgultumError(
      VirgultumError.ErrorCode.ValueNotExists,
      "Failed to create portal root",
    );
  }

  let updateId = 0;
  const updatePortal: (id: number) => void = (id) => {
    if (id !== updateId) {
      console.warn(
        "Potentially infinite recursion! Please clean up the old event listeners before `updatePortal`",
      );
      return;
    }
    updateId++;
    const curId = updateId;
    const templateResult =
      template instanceof Function
        ? template({ updatePortal: () => updatePortal(curId) })
        : template;
    render(templateResult, root, renderOptions);
  };

  updatePortal(updateId);
  container.append(portalRoot);

  // The host modal sets `pointer-events: none` on the body.
  // in order to avoid the issue that the floating element in virgultum cannot be clicked
  // we add pointer-events: auto here
  portalRoot.style.pointerEvents = "auto";

  return portalRoot;
}

/**
 * Similar to `createSimplePortal`, but supports auto update position.
 *
 * The template should be a **static** template since it will not be re-rendered.
 *
 * See {@link createSimplePortal} for more details.
 *
 * @example
 * ```ts
 * createLitPortal({
 *   template: RenameModal({
 *     model,
 *     abortController: renameAbortController,
 *   }),
 *   computePosition: {
 *     referenceElement: anchor,
 *     placement: 'top-end',
 *     middleware: [flip(), offset(4)],
 *     autoUpdate: true,
 *   },
 *   abortController: renameAbortController,
 * });
 * ```
 */
export function createLitPortal({
  computePosition: positionConfigOrFn,
  abortController,
  closeOnClickAway = false,
  positionStrategy = "absolute",
  ...portalOptions
}: AdvancedPortalOptions) {
  let positionSlot = new Subject<ComputePositionReturn>();
  const template = portalOptions.template;
  const templateWithPosition =
    template instanceof Function
      ? ({ updatePortal }: { updatePortal: () => void }) => {
          // We need to create a new slot for each template, otherwise the slot may be used in the old template
          positionSlot = new Subject<ComputePositionReturn>();
          return template({ updatePortal, positionSlot });
        }
      : template;

  const portalRoot = createSimplePortal({
    ...portalOptions,
    signal: abortController.signal,
    template: templateWithPosition,
  });

  if (closeOnClickAway) {
    // Avoid triggering click away listener on initial render
    setTimeout(() =>
      document.addEventListener(
        "click",
        (e) => {
          if (portalRoot.contains(e.target as Node)) return;
          abortController.abort();
        },
        {
          signal: abortController.signal,
        },
      ),
    );
  }

  return positionPortal(
    portalRoot,
    abortController,
    positionConfigOrFn,
    positionStrategy,
    portalOptions.portalStyles,
    (position) => positionSlot.next(position),
  );
}
