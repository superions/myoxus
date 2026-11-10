// SPDX-License-Identifier: AGPL-3.0-or-later
import { Map as YMap, type Text as YText } from "yjs";
import { resolveFlavour } from "../../schema/flavour-alias";

/** Whether removing this block would remove fixed native text, including cells. */
export function hasFixedBlockText(owner: YMap<unknown>): boolean {
  const rawFlavour = owner.get("sys:flavour");
  const flavour =
    typeof rawFlavour === "string" ? resolveFlavour(rawFlavour) : undefined;
  if (
    flavour === "myoxus:paragraph" ||
    flavour === "myoxus:list" ||
    flavour === "myoxus:callout"
  )
    return owner.get("prop:textProtection") === "fixed";
  if (flavour !== "myoxus:table") return false;
  for (const [key, value] of owner.entries())
    if (
      key.startsWith("prop:cells.") &&
      key.endsWith(".textProtection") &&
      value === "fixed"
    )
      return true;
  return false;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Preflight for explicit local property operations on existing fixed owners.
 * Remote projection and hydration do not call this policy.
 */
export function canChangeFixedTextProperty(
  owner: YMap<unknown>,
  path: string,
  value: unknown,
): boolean {
  const rawFlavour = owner.get("sys:flavour");
  if (
    typeof rawFlavour === "string" &&
    resolveFlavour(rawFlavour) === "myoxus:table" &&
    path.startsWith("prop:cells.")
  ) {
    const prefix = path.slice(0, path.lastIndexOf("."));
    if (owner.has(`${prefix}.text`))
      return (
        owner.get(`${prefix}.textProtection`) !== "fixed" ||
        (record(value)?.yText ?? value) === owner.get(path)
      );
  }
  if (!hasFixedBlockText(owner)) return true;
  if (owner.get("prop:textProtection") === "fixed")
    return (
      path.startsWith("prop:meta:") ||
      path === "prop:comments" ||
      path === "prop:collapsed" ||
      (resolveFlavour(String(rawFlavour)) === "myoxus:list" &&
        (path === "prop:checked" || path === "prop:order")) ||
      owner.get(path) === value
    );

  const protectedCells = [...owner.entries()]
    .filter(
      ([key, mode]) =>
        key.startsWith("prop:cells.") &&
        key.endsWith(".textProtection") &&
        mode === "fixed",
    )
    .map(([key]) => key.slice("prop:cells.".length, -".textProtection".length));
  for (const cell of protectedCells) {
    const prefix = `prop:cells.${cell}`;
    if (path === "prop:cells" || path === prefix) {
      const candidate = record(path === prefix ? value : record(value)?.[cell]);
      const text = candidate?.text;
      if (
        !candidate ||
        candidate.textProtection !== "fixed" ||
        (record(text)?.yText ?? text) !== owner.get(`${prefix}.text`) ||
        candidate.backgroundColor !== owner.get(`${prefix}.backgroundColor`)
      )
        return false;
    } else if (
      path.startsWith(`${prefix}.`) &&
      (record(value)?.yText ?? value) !== owner.get(path)
    ) {
      return false;
    }
    const coordinate = cell.split(":");
    if (coordinate.length !== 2) {
      if (path.startsWith("prop:rows") || path.startsWith("prop:columns"))
        return false;
      continue;
    }
    for (const [group, id, identity] of [
      ["rows", coordinate[0]!, "rowId"],
      ["columns", coordinate[1]!, "columnId"],
    ] as const) {
      const unit = `prop:${group}.${id}`;
      if (path === `prop:${group}` || path === unit) {
        const candidate = record(path === unit ? value : record(value)?.[id]);
        if (
          !candidate ||
          candidate[identity] !== owner.get(`${unit}.${identity}`) ||
          candidate.backgroundColor !== owner.get(`${unit}.backgroundColor`) ||
          (group === "columns" &&
            candidate.textAlign !== owner.get(`${unit}.textAlign`))
        )
          return false;
      } else if (path === `${unit}.${identity}` && value !== owner.get(path))
        return false;
      else if (
        (path === `${unit}.backgroundColor` ||
          (group === "columns" && path === `${unit}.textAlign`)) &&
        value !== owner.get(path)
      )
        return false;
    }
  }
  return true;
}

/** Read the persisted owner, not DOM state: a field draft can outlive a render
 * or a protection change. Table cells use their existing flat native prop path.
 */
export function hasFixedTextOwner(text: YText): boolean {
  const owner = text.parent;
  if (!(owner instanceof YMap)) return false;
  const rawFlavour = owner.get("sys:flavour");
  const flavour =
    typeof rawFlavour === "string" ? resolveFlavour(rawFlavour) : undefined;
  if (
    (flavour === "myoxus:paragraph" ||
      flavour === "myoxus:list" ||
      flavour === "myoxus:callout") &&
    (owner.get("prop:text") === text || owner.get("prop:title") === text)
  )
    return owner.get("prop:textProtection") === "fixed";
  if (flavour !== "myoxus:table") return false;
  // A map-integrated Y.Text retains its native property key on its Item. Read
  // that association rather than scanning every cell on each keystroke.
  const key = text._item?.parentSub;
  if (
    typeof key === "string" &&
    owner.get(key) === text &&
    key.startsWith("prop:cells.") &&
    key.endsWith(".text")
  )
    return owner.get(`${key.slice(0, -5)}.textProtection`) === "fixed";
  return false;
}
