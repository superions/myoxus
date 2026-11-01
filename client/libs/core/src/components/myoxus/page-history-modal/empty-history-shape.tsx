import { getArtworkUrl } from "@myoxus/theme/artwork";
import { ThemedImg } from "@myoxus/ui-facade";

export const EmptyHistoryShape = () => (
  <ThemedImg lightSrc={getArtworkUrl("history")} alt="" width={200} />
);
