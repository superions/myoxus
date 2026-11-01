const SENSITIVE_STRING_PATTERN =
  /password|secret|token|api.?key|private.?key|webhook.?key|client.?secret/i;

type ConfigDescriptorLike = {
  type?: string;
  desc?: string;
  env?: string;
};

/**
 * Returns true when a string setting is likely a credential and should be masked in the UI.
 */
export function isSensitiveConfigField(
  module: string,
  key: string,
  descriptor?: ConfigDescriptorLike,
): boolean {
  if (descriptor?.type !== "String") {
    return false;
  }

  const text = `${module}.${key} ${descriptor.env ?? ""} ${descriptor.desc ?? ""}`;
  return SENSITIVE_STRING_PATTERN.test(text);
}
