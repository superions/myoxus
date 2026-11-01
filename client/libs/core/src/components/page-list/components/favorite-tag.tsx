import { useI18n } from "@myoxus/i18n";
import { FavoritedIcon, FavoriteIcon } from "@myoxus/icons/react";
import { IconButton, type IconButtonProps } from "@myoxus/ui-facade";
import { forwardRef, useCallback } from "react";

export const FavoriteTag = forwardRef<
  HTMLButtonElement,
  {
    active: boolean;
  } & Omit<IconButtonProps, "children" | "iconClassName" | "iconStyle" | "size">
>(({ active, onClick, ...props }, ref) => {
  const t = useI18n();
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.preventDefault();
      onClick?.(e);
    },
    [onClick],
  );
  return (
    <IconButton
      tooltip={active ? t["Favorited"]() : t["Favorite"]()}
      tooltipOptions={{ side: "top" }}
      ref={ref}
      onClick={handleClick}
      data-myoxus-ui-role="favorite-tag-button"
      {...props}
    >
      {active ? (
        <FavoritedIcon
          data-active="true"
          data-testid="favorited-icon"
          data-myoxus-ui-role="favorite-tag-icon"
        />
      ) : (
        <FavoriteIcon data-myoxus-ui-role="favorite-tag-icon" />
      )}
    </IconButton>
  );
});
FavoriteTag.displayName = "FavoriteTag";
