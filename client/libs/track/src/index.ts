/**
 * @file index.ts — @myoxus/track
 *
 * Public entry-point for the Myoxus analytics / telemetry package.
 *
 * Primary export is {@link track}: a four-level Proxy-based event dispatcher
 * whose call signature is statically typed against the {@link Events} tree.
 * Use it like:
 * ```ts
 * import track from '@myoxus/track';
 * track.dashboard.sidebar.workspace.switchWorkspace({ id: ws.id });
 * ```
 *
 * Secondary exports:
 *  - {@link tracker}              — low-level tracker with opt-in/opt-out and
 *                                   session management.
 *  - {@link enableAutoTrack}      — wires up click-event listeners for
 *                                   `data-event-props` HTML attributes.
 *  - {@link sentry}               — Sentry error monitoring integration.
 *  - {@link setTelemetryTransport} — injects the backend-specific transport
 *                                    (GA4, Mixpanel, etc.).
 *  - {@link setTelemetryContext}  — updates user/session context on the transport.
 *  - {@link flushTelemetry}       — forces pending events to be sent (e.g. before
 *                                   page unload in Electron).
 *
 * Consumers: `client/admin`, `client/web`.
 */

import { enableAutoTrack, makeTracker } from "./auto";
import { type EventArgs, type Events } from "./events";
import { sentry } from "./sentry";
import {
  flushTelemetry,
  setTelemetryContext,
  setTelemetryTransport,
} from "./telemetry";
import { tracker } from "./tracker";

/**
 * The main typed event dispatcher.
 *
 * Built via {@link makeTracker} over the low-level {@link tracker.track}
 * function.  Navigate the four-level hierarchy as property accesses and call
 * the leaf to fire the event:
 * ```ts
 * track.admin.accounts.userList.deleteAccount();
 * track.admin.workspaces.workspaceDetail.switchTab({ control: 'members' });
 * ```
 */
export const track = makeTracker((event, props) => {
  tracker.track(event, props);
});

export {
  enableAutoTrack,
  type EventArgs,
  type Events,
  flushTelemetry,
  sentry,
  setTelemetryContext,
  setTelemetryTransport,
  tracker,
};
export default track;
