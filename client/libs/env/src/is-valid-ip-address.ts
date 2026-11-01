/**
 * @file is-valid-ip-address.ts — @myoxus/env
 *
 * Utility to validate IPv4 addresses and the `localhost` hostname.
 */

/**
 * Returns `true` if `address` is `'localhost'` or a valid IPv4 address.
 *
 * Does NOT validate IPv6 addresses or hostnames.
 *
 * @param address - The string to test (e.g. `'192.168.1.1'`).
 */
export function isValidIPAddress(address: string) {
  if (address === "localhost") {
    return true;
  }
  return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
    address,
  );
}
