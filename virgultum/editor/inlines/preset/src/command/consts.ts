// corresponding to `formatText` command
import { TableModelFlavour } from "@virgultum/model";

export const FORMAT_TEXT_SUPPORT_FLAVOURS = [
  "myoxus:paragraph",
  "myoxus:list",
  "myoxus:code",
];
// corresponding to `formatBlock` command
export const FORMAT_BLOCK_SUPPORT_FLAVOURS = [
  "myoxus:paragraph",
  "myoxus:list",
  "myoxus:code",
];
// corresponding to `formatNative` command
export const FORMAT_NATIVE_SUPPORT_FLAVOURS = [
  "myoxus:database",
  TableModelFlavour,
];
