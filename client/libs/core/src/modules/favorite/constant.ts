export const FavoriteSupportType = [
  "collection",
  "database",
  "doc",
  "tag",
  "folder",
] as const;
export type FavoriteSupportTypeUnion = (typeof FavoriteSupportType)[number];
export const isFavoriteSupportType = (
  type: string,
): type is FavoriteSupportTypeUnion =>
  FavoriteSupportType.includes(type as FavoriteSupportTypeUnion);
