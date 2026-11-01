import { FavoritedIcon, FavoriteIcon } from "@myoxus/icons/react";
import { cssVar } from "@myoxus/theme";
import type { SVGProps } from "react";

export const IsFavoriteIcon = ({
  favorite,
  style,
  ...props
}: { favorite?: boolean } & SVGProps<SVGSVGElement>) => {
  return favorite ? (
    <FavoritedIcon
      style={{ color: cssVar("primaryColor"), ...style }}
      {...props}
    />
  ) : (
    <FavoriteIcon style={style} {...props} />
  );
};
