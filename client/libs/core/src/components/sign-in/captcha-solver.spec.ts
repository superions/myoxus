// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import type { AltchaChallenge } from "../../modules/server/services/captcha";
import { solveAltchaChallenge } from "./captcha-solver";

const BASE_CHALLENGE = {
  salt: "test-salt",
  maxnumber: 16,
  signature: "test-signature",
} satisfies Partial<AltchaChallenge>;

describe("solveAltchaChallenge", () => {
  test.each([
    [
      "SHA-256",
      "b52968c761c626ca482d182607fb82360084503246adfedd9b2946acb2480ffb",
    ],
    [
      "SHA-384",
      "c2742e042efe3227f700d2a3cf4f71b5eb1f429ddaeb6105b885f312f1621cd22be268b9cb4913e551caffcfe7e8ac75",
    ],
    [
      "SHA-512",
      "608810c7c75a79fad21d282f45f823ebefd23fc6a1b269e914ac9594dc087cfd2bae789f3165170afa8118b32390d16e8dff0be83e78f8ea1a12a6db892469e2",
    ],
  ])("solves %s v1 challenges without WebCrypto", async (algorithm, hash) => {
    const result = await solveAltchaChallenge({
      ...BASE_CHALLENGE,
      algorithm,
      challenge: hash,
    });

    expect(result.number).toBe(7);
    const payload = JSON.parse(atob(result.token));
    expect(payload).toMatchObject({
      algorithm,
      challenge: hash,
      number: 7,
      salt: BASE_CHALLENGE.salt,
      signature: BASE_CHALLENGE.signature,
    });
    expect(typeof payload.took).toBe("number");
  });

  test("rejects unsupported algorithms instead of silently bypassing captcha", async () => {
    await expect(
      solveAltchaChallenge({
        ...BASE_CHALLENGE,
        algorithm: "MD5",
        challenge: "irrelevant",
      }),
    ).rejects.toThrow("Unsupported ALTCHA algorithm");
  });
});
