// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useCallback } from "react";

import {
  RouteLogic,
  useNavigateHelper,
} from "../../../components/hooks/use-navigate-helper";
import { ExpiredPage } from "../invite/member-pages";

export function Component() {
  const { jumpToIndex } = useNavigateHelper();
  const handleOpenMyoxus = useCallback(() => {
    jumpToIndex(RouteLogic.REPLACE);
  }, [jumpToIndex]);

  return <ExpiredPage onOpenMyoxus={handleOpenMyoxus} />;
}
