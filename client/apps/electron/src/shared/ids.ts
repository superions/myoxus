// SPDX-License-Identifier: AGPL-3.0-or-later

import { nanoid } from "nanoid";

export const createRuntimeId = () => nanoid();

export const createAppViewId = () => `app-${createRuntimeId()}`;

export const createWorkspaceImportId = () => nanoid(10);
