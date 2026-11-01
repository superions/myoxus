import { ServerFeature } from "@myoxus/graphql";
import {
  catchErrorInto,
  effect,
  fromPromise,
  LiveData,
  onComplete,
  onStart,
  Service,
} from "@myoxus/infra";
import { exhaustMap, switchMap, tap } from "rxjs";

import type { FetchService } from "./fetch";
import type { ServerService } from "./server";

/**
 * Minimal shape of the ALTCHA challenge object returned by the server.
 * Mirrors `altcha_lib_rs::Challenge` — only the fields the widget needs.
 */
export interface AltchaChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber?: number;
  maxNumber?: number;
}

/**
 * P-Captcha-D: ALTCHA-based CAPTCHA orchestration.
 *
 * `needCaptcha$` is set by the authoritative server response:
 *   - HTTP 200 on GET /api/auth/challenge → captcha is enabled, widget shown.
 *   - HTTP 503 → captcha is disabled, component renders nothing.
 *
 * The server config feature bit is used as a cheap negative gate so disabled
 * local stacks do not emit browser console 503 noise. When enabled, the
 * challenge endpoint remains authoritative for challenge shape and availability.
 */
export class CaptchaService extends Service {
  needCaptcha$ = new LiveData(false);
  challenge$ = new LiveData<AltchaChallenge | undefined>(undefined);
  /** True after the authoritative challenge endpoint answered 200 or 503. */
  hasResolved$ = new LiveData(false);
  isLoading$ = new LiveData(false);
  /** ALTCHA payload (base64 JSON) that the widget emits after a valid solve. */
  verifyToken$ = new LiveData<string | undefined>(undefined);
  error$ = new LiveData<any | undefined>(undefined);

  constructor(
    private readonly fetchService: FetchService,
    private readonly serverService: ServerService,
  ) {
    super();
  }

  revalidate = effect(
    exhaustMap(() => {
      return fromPromise(async (signal) => {
        if (
          !this.serverService.server.config$.value.features.includes(
            ServerFeature.Captcha,
          )
        ) {
          return { disabled: true as const };
        }

        const res = await this.fetchService.fetch("/api/auth/challenge", {
          signal,
          throwOnHttpError: false,
        });
        if (res.status === 503) {
          // CAPTCHA disabled on the server — do not render the widget.
          return { disabled: true as const };
        }
        if (!res.ok) {
          throw new Error(`challenge endpoint returned ${res.status}`);
        }
        const data = (await res.json()) as AltchaChallenge;
        if (!data || !data.challenge || !data.salt || !data.signature) {
          throw new Error("invalid challenge payload");
        }
        return { disabled: false as const, challenge: data };
      }).pipe(
        tap((result) => {
          if (result.disabled) {
            this.needCaptcha$.next(false);
            this.challenge$.next(undefined);
            this.verifyToken$.next(undefined);
            this.hasResolved$.next(true);
            return;
          }
          this.needCaptcha$.next(true);
          this.challenge$.next(result.challenge);
          this.verifyToken$.next(undefined);
          this.hasResolved$.next(true);
          this.resetAfter5min();
        }),
        catchErrorInto(this.error$),
        onStart(() => {
          this.hasResolved$.next(false);
          this.verifyToken$.next(undefined);
          this.isLoading$.next(true);
        }),
        onComplete(() => this.isLoading$.next(false)),
      );
    }),
  );

  resetAfter5min = effect(
    switchMap(() => {
      return fromPromise(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 1000 * 60 * 5);
        });
        return true;
      }).pipe(
        tap((_) => {
          this.challenge$.next(undefined);
          this.verifyToken$.next(undefined);
          this.hasResolved$.next(false);
          this.isLoading$.next(false);
        }),
      );
    }),
  );
}
