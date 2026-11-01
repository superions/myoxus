import type { PageRegistrationState } from "../../storage/doc";

export class DocSyncProtocolError extends Error {
  /** Retained page content needs an explicit lifecycle decision after rejection. */
  pageRegistration?: PageRegistrationState;

  constructor(
    readonly protocolName: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = protocolName;
  }
}
