import { createEvent } from "@myoxus/infra";

import type { AuthAccountInfo } from "../entities/session";

export const AccountLoggedIn = createEvent<AuthAccountInfo>("AccountLoggedIn");
