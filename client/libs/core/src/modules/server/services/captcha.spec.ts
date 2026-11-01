// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServerFeature } from "@myoxus/graphql";
import { Framework } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { CaptchaService } from "./captcha";
import { FetchService } from "./fetch";
import { ServerService } from "./server";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CaptchaService", () => {
  test("does not request a challenge when the server config omits captcha", async () => {
    const fetch = vi.fn();
    const framework = new Framework();
    framework.service(FetchService, { fetch } as any);
    framework.service(ServerService, {
      server: { config$: { value: { features: [] } } },
    } as any);
    framework.service(CaptchaService, [FetchService, ServerService]);
    const service = framework.provider().get(CaptchaService);

    service.revalidate();
    await tick();

    expect(fetch).not.toHaveBeenCalled();
    expect(service.needCaptcha$.value).toBe(false);
    expect(service.hasResolved$.value).toBe(true);
    expect(service.challenge$.value).toBeUndefined();
    expect(service.verifyToken$.value).toBeUndefined();
  });

  test("treats challenge 503 as disabled captcha and resolves the login gate", async () => {
    const fetch = vi.fn(async () => new Response("disabled", { status: 503 }));
    const framework = new Framework();
    framework.service(FetchService, { fetch } as any);
    framework.service(ServerService, {
      server: { config$: { value: { features: [ServerFeature.Captcha] } } },
    } as any);
    framework.service(CaptchaService, [FetchService, ServerService]);
    const service = framework.provider().get(CaptchaService);

    service.revalidate();
    await tick();

    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/challenge",
      expect.objectContaining({ throwOnHttpError: false }),
    );
    expect(service.needCaptcha$.value).toBe(false);
    expect(service.hasResolved$.value).toBe(true);
    expect(service.challenge$.value).toBeUndefined();
    expect(service.verifyToken$.value).toBeUndefined();
  });
});
