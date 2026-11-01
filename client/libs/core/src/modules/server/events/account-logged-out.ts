import { createEvent } from "@myoxus/infra";

import type { AuthAccountInfo } from "../entities/session";

export const AccountLoggedOut =
  createEvent<AuthAccountInfo>("AccountLoggedOut");
