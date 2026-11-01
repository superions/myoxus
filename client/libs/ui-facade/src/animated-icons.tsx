// SPDX-License-Identifier: AGPL-3.0-or-later

import "./animated-icons.css";

import {
  AddCollectionIcon,
  CollectionsIcon,
  TranscriptWithAiIcon,
} from "@myoxus/icons/react";
import type { MouseEvent, SVGAttributes } from "react";

import { joinClassName } from "./css-utils";

export interface AnimatedTranscribeIconProps extends Omit<
  SVGAttributes<SVGSVGElement>,
  "onClick"
> {
  state: "idle" | "transcribing";
  onClick?: (event: MouseEvent<SVGSVGElement>) => void;
}

export const AnimatedTranscribeIcon = ({
  state,
  className,
  ...props
}: AnimatedTranscribeIconProps) => (
  <TranscriptWithAiIcon
    {...props}
    className={joinClassName(
      "myoxus-animated-icon",
      "myoxus-animated-transcribe-icon",
      className,
    )}
    data-state={state}
  />
);

export interface AnimatedCollectionsIconProps {
  closed: boolean;
  className?: string;
}

export const AnimatedCollectionsIcon = ({
  closed,
  className,
}: AnimatedCollectionsIconProps) => {
  // Existing callers set `closed` for a make-child drop target, not collapse.
  const Icon = closed ? AddCollectionIcon : CollectionsIcon;
  return <Icon className={joinClassName("myoxus-animated-icon", className)} />;
};
