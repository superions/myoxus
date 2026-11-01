// Registers the <altcha-widget> custom element as a side effect.
import "altcha";

import {
  type AltchaChallenge,
  CaptchaService,
} from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  AuthActionStack,
  AuthCaptchaFallback,
  AuthCaptchaFallbackButton,
  AuthCaptchaFallbackStatus,
  AuthInlineActionButton,
  AuthStatusText,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { canUseAltchaWidget } from "./captcha-runtime";
import { solveAltchaChallenge } from "./captcha-solver";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "altcha-widget": {
        ref?: React.Ref<HTMLElement>;
        challenge?: string;
        configuration?: string;
        language?: string;
        auto?: "onload" | "onsubmit" | "onfocus" | "off";
        className?: string;
      };
    }
  }
}

type AltchaGlobal = typeof globalThis & {
  $altcha?: {
    i18n?: {
      set?: (language: string, strings: Record<string, string>) => void;
    };
  };
};

/**
 * P-Captcha-D: ALTCHA proof-of-work CAPTCHA widget.
 *
 * Renders nothing when the server reports captcha disabled (503 on
 * GET /api/auth/challenge). When enabled, mounts an `<altcha-widget>` with
 * the ALTCHA v3 `challenge` attribute. The widget solves the pre-fetched v1
 * challenge only after the user clicks the checkbox and emits a base64 JSON
 * payload for the submit handler to pass as `x-captcha-token`.
 */
export const Captcha = () => {
  const t = useI18n();
  const captchaService = useService(CaptchaService);
  const hasCaptchaFeature = useLiveData(captchaService.needCaptcha$);
  const isLoading = useLiveData(captchaService.isLoading$);
  const verifyToken = useLiveData(captchaService.verifyToken$);
  const challenge = useLiveData(captchaService.challenge$);
  const widgetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!challenge && !isLoading) {
      captchaService.revalidate();
    }
  }, [captchaService, challenge, isLoading]);

  const handleStateChange = useCallback(
    (event: Event) => {
      const detail = (
        event as CustomEvent<{ state?: string; payload?: string }>
      ).detail;
      if (detail?.state === "verified" && detail.payload) {
        captchaService.verifyToken$.next(detail.payload);
      } else if (detail?.state === "error" || detail?.state === "expired") {
        captchaService.verifyToken$.next(undefined);
      }
    },
    [captchaService],
  );

  useEffect(() => {
    const node = widgetRef.current;
    if (!node) return;
    node.addEventListener("statechange", handleStateChange);
    return () => {
      node.removeEventListener("statechange", handleStateChange);
    };
  }, [handleStateChange, challenge]);

  // ALTCHA v3 reads visible labels from globalThis.$altcha.i18n, not from a
  // React prop. Registering the active language here keeps the shadow-DOM
  // localized without relying on undocumented custom-element attributes.
  const widgetLanguage = t.language || "en";
  const widgetStrings = useMemo(
    () => ({
      ariaLinkLabel: t["com.myoxus.captcha.widget.ariaLinkLabel"](),
      cancel: t["com.myoxus.captcha.widget.cancel"](),
      enterCode: t["com.myoxus.captcha.widget.enterCode"](),
      enterCodeAria: t["com.myoxus.captcha.widget.enterCodeAria"](),
      enterCodeFromImage: t["com.myoxus.captcha.widget.enterCodeFromImage"](),
      error: t["com.myoxus.captcha.widget.error"](),
      expired: t["com.myoxus.captcha.widget.expired"](),
      getAudioChallenge: t["com.myoxus.captcha.widget.getAudioChallenge"](),
      label: t["com.myoxus.captcha.widget.label"](),
      loading: t["com.myoxus.captcha.widget.loading"](),
      reload: t["com.myoxus.captcha.widget.reload"](),
      verificationRequired:
        t["com.myoxus.captcha.widget.verificationRequired"](),
      verified: t["com.myoxus.captcha.widget.verified"](),
      verify: t["com.myoxus.captcha.widget.verify"](),
      verifying: t["com.myoxus.captcha.widget.verifying"](),
      waitAlert: t["com.myoxus.captcha.widget.waitAlert"](),
    }),
    [t],
  );

  useEffect(() => {
    (globalThis as AltchaGlobal).$altcha?.i18n?.set?.(
      widgetLanguage,
      widgetStrings,
    );
  }, [widgetLanguage, widgetStrings]);

  const widgetConfiguration = useMemo(
    () =>
      JSON.stringify({
        hideFooter: true,
        hideLogo: true,
      }),
    [],
  );

  if (!hasCaptchaFeature) {
    return null;
  }

  if (isLoading || !challenge) {
    return (
      <AuthActionStack align="center">
        <AuthStatusText>{t["com.myoxus.captcha.loading"]()}</AuthStatusText>
      </AuthActionStack>
    );
  }

  if (verifyToken) {
    return (
      <AuthActionStack align="center">
        <AuthStatusText state="success">
          {t["com.myoxus.captcha.verified"]()}
        </AuthStatusText>
      </AuthActionStack>
    );
  }

  if (!canUseAltchaWidget()) {
    return <HttpAltchaFallback challenge={challenge} />;
  }

  return (
    <AuthActionStack align="center">
      <altcha-widget
        ref={widgetRef}
        challenge={JSON.stringify(challenge)}
        configuration={widgetConfiguration}
        language={widgetLanguage}
        auto="off"
      />
    </AuthActionStack>
  );
};

const HttpAltchaFallback = ({ challenge }: { challenge: AltchaChallenge }) => {
  const t = useI18n();
  const captchaService = useService(CaptchaService);
  const controllerRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState(0);
  const [state, setState] = useState<"idle" | "solving" | "error">("idle");

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const solve = useCallback(async () => {
    if (state === "solving") {
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState("solving");
    setProgress(0);
    captchaService.verifyToken$.next(undefined);

    try {
      const result = await solveAltchaChallenge(challenge, {
        signal: controller.signal,
        onProgress: ({ ratio }) => setProgress(ratio),
      });
      captchaService.verifyToken$.next(result.token);
      setProgress(1);
      setState("idle");
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return;
      }
      console.warn("[captcha] insecure-context ALTCHA fallback failed", {
        algorithm: challenge.algorithm,
        maxnumber: challenge.maxnumber ?? challenge.maxNumber,
        error,
      });
      captchaService.verifyToken$.next(undefined);
      setState("error");
    }
  }, [captchaService, challenge, state]);

  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));

  return (
    <AuthCaptchaFallback>
      <AuthCaptchaFallbackButton
        type="button"
        onClick={solve}
        disabled={state === "solving"}
        solving={state === "solving"}
      >
        {t["com.myoxus.captcha.widget.label"]()}
      </AuthCaptchaFallbackButton>
      {state === "solving" ? (
        <AuthCaptchaFallbackStatus progress={percent}>
          {t["com.myoxus.captcha.solving"]()} {percent}%
        </AuthCaptchaFallbackStatus>
      ) : null}
      {state === "error" ? (
        <AuthInlineActionButton type="button" onClick={solve}>
          {t["com.myoxus.captcha.retry"]()}
        </AuthInlineActionButton>
      ) : null}
    </AuthCaptchaFallback>
  );
};
