import type { PublicDocMode } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { GlobeIcon } from "@myoxus/icons/react";
import { IconButton, type IconButtonProps } from "@myoxus/ui-facade";
import { forwardRef, useCallback } from "react";

export const PublicStatusTag = forwardRef<
  HTMLButtonElement,
  {
    mode: PublicDocMode | null | undefined;
  } & Omit<IconButtonProps, "children" | "icon" | "iconClassName" | "iconStyle">
>(({ mode, onClick, variant, ...props }, ref) => {
  const t = useI18n();
  const publicMode = mode ?? null;
  const active = publicMode !== null;
  const tooltip =
    publicMode === "Page"
      ? t["com.myoxus.public-sharing.status.page"]()
      : publicMode === "Edgeless"
        ? t["com.myoxus.public-sharing.status.edgeless"]()
        : t["com.myoxus.public-sharing.status.private"]();
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      onClick?.(event);
    },
    [onClick],
  );

  return (
    <IconButton
      {...props}
      aria-label={tooltip}
      data-myoxus-ui-role="public-status-button"
      data-public={active ? "true" : "false"}
      data-public-mode={publicMode?.toLowerCase()}
      onClick={handleClick}
      ref={ref}
      tooltip={props.tooltip ?? tooltip}
      tooltipOptions={props.tooltipOptions ?? { side: "top" }}
      variant={variant ?? (active ? "primary" : "plain")}
    >
      <GlobeIcon data-myoxus-ui-role="public-status-icon" />
    </IconButton>
  );
});
PublicStatusTag.displayName = "PublicStatusTag";
