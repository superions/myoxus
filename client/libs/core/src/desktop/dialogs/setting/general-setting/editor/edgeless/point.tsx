// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { ColorDot } from "../../../primitives";

export const Point = ({ color }: { color: string }) => {
  return <ColorDot color={color} />;
};
