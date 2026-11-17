import { textKeymap } from "../../inlines/preset/index";
import { CodeBlockSchema } from "@virgultum/core/models";
import { KeymapExtension } from "@virgultum/core/runtime";

export const CodeKeymapExtension = KeymapExtension(textKeymap, {
  flavour: CodeBlockSchema.model.flavour,
});
