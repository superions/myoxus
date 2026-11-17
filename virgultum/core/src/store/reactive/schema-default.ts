import { isPureObject } from "./is-pure-object.js";
import { copyNativeValue } from "./native-y.js";

/** Project a missing native schema value without writing the document. Nested
 * edits install the complete default once; retained references then use the
 * normal persisted proxy rather than overwriting newer values with a fallback. */
export function projectSchemaDefault(
  value: unknown,
  read: () => { value: unknown } | undefined,
  write: (value: unknown) => void,
): unknown {
  const mutable = (
    value: unknown,
  ): value is Record<string, unknown> | unknown[] =>
    Array.isArray(value) || isPureObject(value);
  if (!mutable(value)) return value;

  // Schema factories may reuse theme/default objects. Never edit those objects.
  const fallback = copyNativeValue(value) as Record<string, unknown>;
  const project = (
    target: Record<string, unknown>,
    current: () => Record<string, unknown>,
  ): Record<string, unknown> => {
    const children = new Map<PropertyKey, unknown>();
    return new Proxy(target, {
      get(target, key, receiver) {
        const live = current();
        if (live !== target) return Reflect.get(live, key, live);
        const value = Reflect.get(target, key, receiver);
        if (!mutable(value)) return value;
        if (!children.has(key))
          children.set(
            key,
            project(value as Record<string, unknown>, () =>
              Reflect.get(current(), key),
            ),
          );
        return children.get(key);
      },
      set(target, key, value) {
        const live = current();
        const result = Reflect.set(live, key, value);
        if (live === target) write(fallback);
        return result;
      },
      deleteProperty(target, key) {
        const live = current();
        const result = Reflect.deleteProperty(live, key);
        if (live === target) write(fallback);
        return result;
      },
      has: (_, key) => Reflect.has(current(), key),
      ownKeys: () => Reflect.ownKeys(current()),
      getOwnPropertyDescriptor: (_, key) =>
        Reflect.getOwnPropertyDescriptor(current(), key),
    });
  };
  return project(fallback, () => {
    const persisted = read();
    return (persisted ? persisted.value : fallback) as Record<string, unknown>;
  });
}
