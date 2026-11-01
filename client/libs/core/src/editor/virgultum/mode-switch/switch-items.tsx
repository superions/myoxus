import { useI18n } from "@myoxus/i18n";
import { EdgelessIcon, PageIcon } from "@myoxus/icons/react";
import { SurfaceListItemIcon, Tooltip } from "@myoxus/ui-facade";
import type { HTMLAttributes } from "react";
import type React from "react";

type ModeSwitchIconProps = {
  children: React.ReactNode;
} & HTMLAttributes<HTMLDivElement>;

const ModeSwitchIcon = ({ children, ...props }: ModeSwitchIconProps) => (
  <SurfaceListItemIcon
    {...props}
    data-myoxus-ui-role="editor-mode-switch-icon"
    size="sm"
  >
    {children}
  </SurfaceListItemIcon>
);

export const PageSwitchItem = (
  props: Omit<ModeSwitchIconProps, "children">,
) => {
  const t = useI18n();
  return (
    <Tooltip
      content={t["com.myoxus.header.mode-switch.page"]()}
      shortcut={["$alt", "S"]}
      side="bottom"
    >
      <ModeSwitchIcon {...props}>
        <PageIcon size="1em" />
      </ModeSwitchIcon>
    </Tooltip>
  );
};

export const EdgelessSwitchItem = (
  props: Omit<ModeSwitchIconProps, "children">,
) => {
  const t = useI18n();
  return (
    <Tooltip
      content={t["com.myoxus.header.mode-switch.edgeless"]()}
      shortcut={["$alt", "S"]}
      side="bottom"
    >
      <ModeSwitchIcon {...props}>
        <EdgelessIcon size="1em" />
      </ModeSwitchIcon>
    </Tooltip>
  );
};
