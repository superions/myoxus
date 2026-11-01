// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string, fallback?: string) => en[key] ?? fallback ?? key,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

import { CryptoKeyStep } from "./crypto-key";

describe("CryptoKeyStep", () => {
  afterEach(() => cleanup());

  test("keeps the file-only server secret out of the browser write path", () => {
    const onNext = vi.fn();

    render(
      <MyoxusUIProvider>
        <CryptoKeyStep onNext={onNext} />
      </MyoxusUIProvider>,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText("Private key")).toBeNull();
    expect(
      screen.queryByText(/MYOXUS__CRYPTO__PRIVATE_KEY_FILE/),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onNext).toHaveBeenCalledOnce();
  });
});
