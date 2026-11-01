// SPDX-License-Identifier: AGPL-3.0-or-later
// @myoxus/crypto — Hashcash challenge-response NAPI binding.
//
// This package is a standalone NAPI module compiled from Rust.
// The .node binary is loaded at runtime; types are declared below.

// oxlint-disable-next-line typescript/no-require-imports
// oxlint-disable-next-line typescript/no-var-requires
const binding = require("../myoxus_crypto.node") as {
  mintChallengeResponse(
    resource: string,
    bits?: number | null,
  ): Promise<string>;
  verifyChallengeResponse(
    response: string,
    bits: number,
    resource: string,
  ): Promise<boolean>;
};

export const mintChallengeResponse: (
  resource: string,
  bits?: number | null,
) => Promise<string> = binding.mintChallengeResponse.bind(binding);

export const verifyChallengeResponse: (
  response: string,
  bits: number,
  resource: string,
) => Promise<boolean> = binding.verifyChallengeResponse.bind(binding);
