// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ServerSetupStatusQuery,
  serverSetupStatusQuery,
} from "@myoxus/graphql";

import { adminFetch } from "../fetch-utils";
import { gqlFetcher } from "../use-query";

export interface CreateFirstAdminUserInput {
  name: string;
  email: string;
  password: string;
}

export async function fetchServerSetupStatus(): Promise<
  ServerSetupStatusQuery["serverSetupStatus"] | undefined
> {
  const response = await gqlFetcher({ query: serverSetupStatusQuery });
  return response.serverSetupStatus;
}

export async function createFirstAdminUser(
  input: CreateFirstAdminUserInput,
): Promise<unknown> {
  const response = await adminFetch("/api/setup/create-admin-user", {
    method: "POST",
    body: JSON.stringify(input),
    headers: {
      "Content-Type": "application/json",
    },
    admin: {
      channel: "setup",
      operationName: "createFirstAdminUser",
      invalidateOnAuthFailure: false,
    },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : `Setup failed (HTTP ${response.status})`;
    throw new Error(message);
  }

  return response.json();
}
