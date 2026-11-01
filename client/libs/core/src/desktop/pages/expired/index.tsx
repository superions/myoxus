import { useCallback } from "react";

import {
  RouteLogic,
  useNavigateHelper,
} from "../../../components/hooks/use-navigate-helper";
import { ExpiredPage } from "../invite/member-pages";

/**
 * /expired page
 *
 * only on web
 */
export const Component = () => {
  const { jumpToIndex } = useNavigateHelper();
  const onOpenMyoxus = useCallback(() => {
    jumpToIndex(RouteLogic.REPLACE);
  }, [jumpToIndex]);

  return <ExpiredPage onOpenMyoxus={onOpenMyoxus} />;
};
