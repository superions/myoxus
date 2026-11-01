/**
 * Traverse an object using a dot-separated path string.
 * Replaces lodash `get(obj, 'a.b.c')` (AF-PERF-B-04).
 */
export function getByPath<T = any>(obj: any, path: string): T {
  return path.split(".").reduce((o: any, k: string) => o?.[k], obj) as T;
}

/**
 * Set a value at a dot-separated path inside an existing (mutable) object.
 * Creates intermediate objects as needed.
 * Replaces lodash `set(obj, 'a.b.c', v)` (AF-PERF-B-04).
 */
export function setByPath<T extends Record<string, any> = Record<string, any>>(
  obj: T,
  path: string,
  value: any,
): T {
  const parts = path.split(".");
  let cursor: Record<string, any> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cursor[part] == null || typeof cursor[part] !== "object") {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  const lastPart = parts[parts.length - 1];
  cursor[lastPart] = value;
  return obj;
}

/**
 * Deep equality check used for detecting unsaved config changes.
 * Key-order independent recursive comparison (FE-H-3).
 */
export const isEqual = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v: any, i: number) => isEqual(v, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (k) => Object.prototype.hasOwnProperty.call(b, k) && isEqual(a[k], b[k]),
  );
};
