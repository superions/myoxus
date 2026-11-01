import {
  NATIVE_UNIQ_IDENTIFIER,
  TEXT_UNIQ_IDENTIFIER,
  LEGACY_NATIVE_UNIQ_IDENTIFIER,
  LEGACY_TEXT_UNIQ_IDENTIFIER,
} from "../consts";
import { isPureObject } from "../reactive";
import { Boxed } from "../reactive/boxed";
import { Text } from "../reactive/text";

export function toJSON(value: unknown): unknown {
  if (value instanceof Boxed) {
    return {
      [NATIVE_UNIQ_IDENTIFIER]: true,
      value: value.getValue(),
    };
  }
  if (value instanceof Text) {
    return {
      [TEXT_UNIQ_IDENTIFIER]: true,
      delta: value.yText.toDelta(),
    };
  }
  if (Array.isArray(value)) {
    return value.map(toJSON);
  }
  if (isPureObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => {
        return [key, toJSON(value)];
      }),
    );
  }
  return value;
}

export function fromJSON(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(fromJSON);
  }
  if (typeof value === "object" && value != null) {
    if (
      Reflect.has(value, NATIVE_UNIQ_IDENTIFIER) ||
      Reflect.has(value, LEGACY_NATIVE_UNIQ_IDENTIFIER)
    ) {
      return new Boxed(Reflect.get(value, "value"));
    }
    if (
      Reflect.has(value, TEXT_UNIQ_IDENTIFIER) ||
      Reflect.has(value, LEGACY_TEXT_UNIQ_IDENTIFIER)
    ) {
      return new Text(Reflect.get(value, "delta"));
    }
    // Warn when an object has a $...:internal:...$-style key that we don't
    // recognise — indicates a new marker format or a migration gap.
    const unknownMarker = Object.keys(value).find(
      (k) => k.startsWith("$") && k.endsWith("$") && k.includes(":internal:"),
    );
    if (unknownMarker) {
      console.warn(
        `[fromJSON] Unknown internal marker key "${unknownMarker}" — expected` +
          ` "${NATIVE_UNIQ_IDENTIFIER}" or "${TEXT_UNIQ_IDENTIFIER}".` +
          ` Treating as plain object. Check consts.ts and boxed.ts for backward-compat.`,
      );
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => {
        return [key, fromJSON(value)];
      }),
    );
  }

  return value;
}
