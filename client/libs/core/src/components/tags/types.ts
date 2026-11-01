import type { TagColorRole } from "@myoxus/ui-facade";

export interface TagLike {
  id: string;
  name: string; // display name
  color: TagColorRole;
  description?: string;
  archived?: boolean;
}

export interface TagColor {
  id: string;
  value: TagColorRole;
  name?: string; // display name
}
