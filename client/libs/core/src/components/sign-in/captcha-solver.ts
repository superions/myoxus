// SPDX-License-Identifier: AGPL-3.0-or-later

import { createSHA256, createSHA384, createSHA512 } from "hash-wasm";

import type { AltchaChallenge } from "../../modules/server/services/captcha";

type HashAlgorithm = "SHA-256" | "SHA-384" | "SHA-512";

export interface AltchaSolveProgress {
  current: number;
  maxNumber: number;
  ratio: number;
}

export interface AltchaSolveResult {
  token: string;
  number: number;
  took: number;
}

export interface AltchaSolveOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AltchaSolveProgress) => void;
}

const DEFAULT_MAX_NUMBER = 1_000_000;
const YIELD_INTERVAL = 512;

function normalizeAlgorithm(value: string): HashAlgorithm {
  const algorithm = value.toUpperCase();
  if (
    algorithm === "SHA-256" ||
    algorithm === "SHA-384" ||
    algorithm === "SHA-512"
  ) {
    return algorithm;
  }
  throw new Error(`Unsupported ALTCHA algorithm: ${value}`);
}

async function createHasher(algorithm: HashAlgorithm) {
  switch (algorithm) {
    case "SHA-256": {
      return createSHA256();
    }
    case "SHA-384": {
      return createSHA384();
    }
    case "SHA-512": {
      return createSHA512();
    }
  }
}

function maxNumberFromChallenge(challenge: AltchaChallenge): number {
  const value =
    challenge.maxnumber ?? challenge.maxNumber ?? DEFAULT_MAX_NUMBER;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ALTCHA maxnumber: ${value}`);
  }
  return value;
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("ALTCHA solve aborted", "AbortError");
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Solves the legacy ALTCHA v1 challenge emitted by `altcha-lib-rs`.
 *
 * ALTCHA v3's browser widget hard-requires `globalThis.isSecureContext`
 * because it uses WebCrypto (`crypto.subtle`). Our self-hosted Rust server
 * still validates the same signed v1 payload, so HTTP development/LAN access
 * can keep real CAPTCHA protection by solving `hash(salt + number)` via
 * `hash-wasm` instead of disabling server-side verification.
 */
export async function solveAltchaChallenge(
  challenge: AltchaChallenge,
  options: AltchaSolveOptions = {},
): Promise<AltchaSolveResult> {
  const algorithm = normalizeAlgorithm(challenge.algorithm);
  const maxNumber = maxNumberFromChallenge(challenge);
  const expectedChallenge = challenge.challenge.toLowerCase();
  const hasher = await createHasher(algorithm);
  const started = performance.now();

  for (let number = 0; number <= maxNumber; number += 1) {
    abortIfNeeded(options.signal);
    const hash = hasher
      .init()
      .update(`${challenge.salt}${number}`)
      .digest("hex")
      .toLowerCase();

    if (hash === expectedChallenge) {
      const took = Math.max(0, Math.round(performance.now() - started));
      const payload = JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number,
        salt: challenge.salt,
        signature: challenge.signature,
        took,
      });
      return {
        token: encodeBase64Utf8(payload),
        number,
        took,
      };
    }

    if (number % YIELD_INTERVAL === 0) {
      options.onProgress?.({
        current: number,
        maxNumber,
        ratio: maxNumber === 0 ? 1 : number / maxNumber,
      });
      await yieldToBrowser();
    }
  }

  throw new Error(`ALTCHA solve reached maxnumber ${maxNumber}`);
}
