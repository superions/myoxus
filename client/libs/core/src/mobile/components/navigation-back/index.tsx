import { ArrowLeftSmallIcon, CloseIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  IconButton,
  type IconButtonProps,
  useIsInsideModal,
} from "@myoxus/ui-facade";
import { useCallback, useEffect } from "react";

import { NavigationGestureService } from "../../modules/navigation-gesture";

export interface NavigationBackButtonProps extends IconButtonProps {
  backAction?: () => void;
}

/**
 * A button to control the back behavior of the mobile app, as well as manage navigation gesture
 */
export const NavigationBackButton = ({
  icon,
  backAction,
  children,
  ...otherProps
}: NavigationBackButtonProps) => {
  const navigationGesture = useService(NavigationGestureService);
  const isInsideModal = useIsInsideModal();

  const handleRouteBack = useCallback(() => {
    backAction ? backAction() : history.back();
  }, [backAction]);

  useEffect(() => {
    if (isInsideModal) return;

    const prev = navigationGesture.enabled$.value;
    navigationGesture.setEnabled(true);

    return () => {
      navigationGesture.setEnabled(prev);
    };
  }, [isInsideModal, navigationGesture]);

  if (children) return children;

  return (
    <IconButton
      onClick={handleRouteBack}
      icon={icon ?? (isInsideModal ? <CloseIcon /> : <ArrowLeftSmallIcon />)}
      data-testid="page-header-back"
      {...otherProps}
    />
  );
};
