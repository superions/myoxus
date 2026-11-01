import type { IconButtonProps } from "@myoxus/ui-facade";

/**
 * Keeps icon-only document header actions on one visual contract while the
 * Facade maps the variants to Mantine theme tokens.
 */
export const getDocumentHeaderActionVariant = (
  active: boolean,
): IconButtonProps["variant"] => (active ? "primary" : "plain");
