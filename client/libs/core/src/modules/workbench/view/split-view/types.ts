import type { MyoxusDNDEntity } from "@myoxus/core/types/dnd";

export const allowedSplitViewEntityTypes: Set<MyoxusDNDEntity["type"]> =
  new Set(["doc", "database", "collection", "tag"]);

export const inferToFromEntity = (entity: MyoxusDNDEntity) => {
  if (entity.type === "doc") {
    return `/${entity.id}`;
  } else if (entity.type === "database") {
    return `/databases/${entity.id}`;
  } else if (entity.type === "collection") {
    const search = new URLSearchParams({ collection: entity.id });
    return `/all?${search.toString()}`;
  } else if (entity.type === "tag") {
    return `/tag/${entity.id}`;
  }
  return null;
};
