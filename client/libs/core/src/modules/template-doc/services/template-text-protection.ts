// SPDX-License-Identifier: AGPL-3.0-or-later

const textOwners = new Set([
  "myoxus:paragraph",
  "myoxus:list",
  "myoxus:callout",
]);

/** Validate native owner markers without materializing defaults. Only a detached
 * application copy may freeze source markers; copying/editing a source must not.
 */
export function prepareTemplateTextProtection(
  snapshot: unknown,
  apply = false,
): void {
  const owner = (value: Record<string, unknown>) => {
    const protection = value.textProtection;
    if (protection === undefined) return;
    if (!("text" in value))
      throw new TypeError("Native text protection requires a text owner");
    if (protection !== "source" && protection !== "fixed")
      throw new TypeError("Invalid native text protection");
    if (apply && protection === "source") value.textProtection = "fixed";
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const props = record.props;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      const properties = props as Record<string, unknown>;
      if (
        properties.textProtection !== undefined &&
        (typeof record.flavour !== "string" || !textOwners.has(record.flavour))
      )
        throw new TypeError("Invalid native text protection owner");
      if (typeof record.flavour === "string" && textOwners.has(record.flavour))
        owner(properties);
      if (
        record.flavour === "myoxus:table" &&
        properties.cells &&
        typeof properties.cells === "object" &&
        !Array.isArray(properties.cells)
      ) {
        for (const cell of Object.values(properties.cells)) {
          if (cell && typeof cell === "object" && !Array.isArray(cell))
            owner(cell as Record<string, unknown>);
        }
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(snapshot);
}
