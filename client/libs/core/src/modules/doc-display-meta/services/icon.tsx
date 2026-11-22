import { type IconData, IconRenderer } from "@myoxus/ui-facade";
export const getDocIconComponent = (icon: IconData) => {
  const Icon = () => <IconRenderer data={icon} />;
  Icon.displayName = "DocIcon";
  return Icon;
};
