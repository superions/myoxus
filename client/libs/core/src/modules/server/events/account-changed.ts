import { createEvent } from "@myoxus/infra";

import type { AuthAccountInfo } from "../entities/session";

export const AccountChanged = createEvent<AuthAccountInfo | null>(
  "AccountChanged",
);
