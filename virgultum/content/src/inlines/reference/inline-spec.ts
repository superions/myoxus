import { ReferenceInfoSchema } from "@virgultum/core/models";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { StdIdentifier } from "@virgultum/core/runtime";
import { InlineSpecExtension } from "@virgultum/core/runtime/inline";
import { inlineChild } from "@virgultum/core/runtime/inline";
import { z } from "zod";

import {
  ReferenceNodeConfigExtension,
  ReferenceNodeConfigProvider,
} from "./reference-node/reference-config";

export const ReferenceInlineSpecExtension =
  InlineSpecExtension<MyoxusTextAttributes>("reference", (provider) => {
    const std = provider.get(StdIdentifier);
    const configProvider = new ReferenceNodeConfigProvider(std);
    const config =
      provider.getOptional(ReferenceNodeConfigExtension.identifier) ?? {};
    if (config.customContent) {
      configProvider.setCustomContent(config.customContent);
    }
    if (config.interactable !== undefined) {
      configProvider.setInteractable(config.interactable);
    }
    if (config.hidePopup !== undefined) {
      configProvider.setHidePopup(config.hidePopup);
    }
    return {
      name: "reference",
      schema: z.object({
        reference: z
          .object({
            type: z.enum([
              // @deprecated Subpage is deprecated, use LinkedPage instead
              "Subpage",
              "LinkedPage",
            ]),
          })
          .merge(ReferenceInfoSchema)
          .optional()
          .nullable()
          .catch(undefined),
      }),
      match: (delta) => {
        return !!delta.attributes?.reference;
      },
      renderer: ({ delta, selected }, parent) => {
        return inlineChild(parent, "myoxus-reference", {
          std,
          delta,
          selected,
          config: configProvider,
        });
      },
      embed: true,
    };
  });
