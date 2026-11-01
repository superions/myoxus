// SPDX-License-Identifier: AGPL-3.0-or-later

import { LoggingContent } from "../../logging";

/**
 * System-owned logging tab.
 *
 * Logging keeps its GraphQL-backed editor in `modules/logging`, but routing and
 * navigation ownership live under System after P-AR-3-04. This wrapper prevents
 * `modules/system` from importing a legacy page shell with its own Header or
 * scroll container.
 */
export function SystemLoggingTab() {
  return <LoggingContent />;
}
