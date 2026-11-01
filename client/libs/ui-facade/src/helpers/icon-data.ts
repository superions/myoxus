// SPDX-License-Identifier: MIT

export const IconType = {
  Emoji: "emoji",
  MyoxusIcon: "myoxus-icon",
  Blob: "blob",
} as const;

export type IconType = (typeof IconType)[keyof typeof IconType];

export type IconData =
  | {
      type: typeof IconType.Emoji;
      unicode: string;
    }
  | {
      type: typeof IconType.MyoxusIcon;
      name: string;
      color: string;
    }
  | {
      type: typeof IconType.Blob;
      blob: Blob;
    };
