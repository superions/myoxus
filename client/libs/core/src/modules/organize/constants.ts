export const OrganizeSupportType = [
  "folder",
  "doc",
  "database",
  "collection",
  "tag",
] as const;
export type OrganizeSupportTypeUnion = (typeof OrganizeSupportType)[number];

export const isOrganizeSupportType = (
  type: string,
): type is OrganizeSupportTypeUnion =>
  OrganizeSupportType.includes(type as OrganizeSupportTypeUnion);
