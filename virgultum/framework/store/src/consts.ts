export const SCHEMA_NOT_FOUND_MESSAGE =
  "Schema not found. The block flavour may not be registered.";

// New wrappers use Virgultum markers. Persisted documents and imported snapshots
// with the previous markers remain readable; opening them must not rewrite CRDTs.
export const TEXT_UNIQ_IDENTIFIER = "$virgultum:internal:text$";
export const NATIVE_UNIQ_IDENTIFIER = "$virgultum:internal:native$";
export const LEGACY_TEXT_UNIQ_IDENTIFIER = "$blocksuite:internal:text$";
export const LEGACY_NATIVE_UNIQ_IDENTIFIER = "$blocksuite:internal:native$";

export const SYS_KEYS = new Set(["id", "flavour", "children", "version"]);
