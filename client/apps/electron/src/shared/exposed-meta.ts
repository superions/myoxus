import type { ExposedMeta } from "./type";

type ChannelSurface = Readonly<Record<string, object>>;
type ChannelManifest = Readonly<Record<string, Readonly<Record<string, true>>>>;

function entriesFromSurface(surface: ChannelSurface) {
  return Object.entries(surface)
    .map(
      ([namespace, channels]) =>
        [namespace, Object.keys(channels).sort()] as const,
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

export function createExposedMeta(
  handlers: ChannelSurface,
  events: ChannelSurface,
): ExposedMeta {
  return {
    handlers: entriesFromSurface(handlers),
    events: entriesFromSurface(events),
  };
}

function isMetaEntries(value: unknown): value is ExposedMeta["handlers"] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        Array.isArray(entry[1]) &&
        entry[1].every((channel) => typeof channel === "string"),
    )
  );
}

function assertEntriesMatch(
  actual: ExposedMeta["handlers"],
  manifest: ChannelManifest,
  label: string,
) {
  const expected = entriesFromSurface(manifest);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the desktop IPC contract`);
  }
}

export function parseExposedMeta(
  value: unknown,
  handlerManifest: ChannelManifest,
  eventManifest: ChannelManifest,
  label: string,
): ExposedMeta {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} is missing`);
  }
  const handlers = Reflect.get(value, "handlers");
  const events = Reflect.get(value, "events");
  if (!isMetaEntries(handlers) || !isMetaEntries(events)) {
    throw new Error(`${label} has an invalid shape`);
  }

  const normalized: ExposedMeta = {
    handlers: [...handlers]
      .map(
        ([namespace, channels]) => [namespace, [...channels].sort()] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right)),
    events: [...events]
      .map(
        ([namespace, channels]) => [namespace, [...channels].sort()] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  };
  assertEntriesMatch(normalized.handlers, handlerManifest, `${label}.handlers`);
  assertEntriesMatch(normalized.events, eventManifest, `${label}.events`);
  return normalized;
}
