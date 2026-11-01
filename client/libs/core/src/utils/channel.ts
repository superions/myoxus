import { z } from "zod";

export const appSchemes = z.enum([
  "myoxus",
  "myoxus-beta",
  "myoxus-internal",
  "myoxus-dev",
]);

export type Scheme = z.infer<typeof appSchemes>;
export type Channel = "stable" | "beta" | "internal";

export const schemeToChannel = {
  myoxus: "stable",
  "myoxus-beta": "beta",
  "myoxus-internal": "internal",
  "myoxus-dev": "internal",
} as Record<Scheme, Channel>;

export const channelToScheme = {
  stable: "myoxus",
  beta: "myoxus-beta",
  internal: BUILD_CONFIG.debug ? "myoxus-dev" : "myoxus-internal",
} as Record<Channel, Scheme>;

// All channels display as "Myoxus" — build channel is an internal build-system
// concept and carries no product meaning for Myoxus deployments.
export const appNames = {
  stable: "Myoxus",
  beta: "Myoxus",
  internal: "Myoxus",
} satisfies Record<Channel, string>;

export const appSchemaUrl = z.custom<string>(
  (url: string) => {
    try {
      return appSchemes.safeParse(new URL(url).protocol.replace(":", ""))
        .success;
    } catch {
      return false;
    }
  },
  { message: "Invalid URL or protocol" },
);
