import { textKeymap } from "@virgultum/inline-preset";
import { CodeBlockSchema } from "@virgultum/model";
import { KeymapExtension } from "@virgultum/std";

export const CodeKeymapExtension = KeymapExtension(textKeymap, {
  flavour: CodeBlockSchema.model.flavour,
});
