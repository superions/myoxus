import { createIdentifier, type Memento } from "@myoxus/infra";

export interface AppSidebarState extends Memento {}

export const AppSidebarState =
  createIdentifier<AppSidebarState>("AppSidebarState");
