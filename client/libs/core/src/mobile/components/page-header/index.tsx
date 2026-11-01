import {
  MobilePageHeaderBar,
  MobilePageHeaderContent,
  type MobilePageHeaderContentLayout,
  MobilePageHeaderPrefix,
  MobilePageHeaderRoot,
  MobilePageHeaderSpacer,
  type MobilePageHeaderSpacerSize,
  MobilePageHeaderSuffix,
  SafeArea,
} from "@myoxus/ui-facade";
import {
  forwardRef,
  type HtmlHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SVGAttributes,
} from "react";

import { NavigationBackButton } from "../navigation-back";

export interface PageHeaderProps extends Omit<
  HtmlHTMLAttributes<HTMLHeadElement>,
  "prefix"
> {
  /**
   * Semantic mobile header chrome. Route-specific geometry must map through
   * this role so product pages do not pass facade class names or spacing tokens.
   */
  variant?: "default" | "detail" | "workspace";
  /**
   * whether to show back button
   */
  back?: boolean;
  backIcon?: ReactElement<SVGAttributes<SVGElement>>;
  /**
   * Override back button action
   */
  backAction?: () => void;

  /**
   * prefix content, shown after back button(if exists)
   */
  prefix?: ReactNode;

  /**
   * suffix content
   */
  suffix?: ReactNode;

  /**
   * Weather to center the content
   * @default true
   */
  centerContent?: boolean;
  contentLayout?: MobilePageHeaderContentLayout;

  /**
   * Custom bottom content
   */
  bottom?: ReactNode;
  /**
   * Semantic bottom spacer size owned by the facade.
   */
  bottomSpacing?: MobilePageHeaderSpacerSize;
  "data-myoxus-ui-role"?: string;
}
function pageHeaderRole(variant: PageHeaderProps["variant"]) {
  if (variant === "detail") return "detail-page-mobile-header";
  if (variant === "workspace") return "mobile-workspace-page-header";
  return undefined;
}

export const PageHeader = forwardRef<HTMLDivElement, PageHeaderProps>(
  function PageHeader(
    {
      variant = "default",
      back,
      backIcon,
      backAction,
      prefix,
      suffix,
      children,
      className,
      centerContent = true,
      contentLayout,
      bottom,
      bottomSpacing,
      "data-myoxus-ui-role": uiRole,
      ...attrs
    },
    ref,
  ) {
    return (
      <>
        <MobilePageHeaderRoot
          {...attrs}
          ref={ref}
          className={className}
          data-myoxus-ui-role={uiRole ?? pageHeaderRole(variant)}
          data-testid="mobile-page-header"
        >
          <MobilePageHeaderBar>
            <MobilePageHeaderPrefix>
              {back ? (
                <NavigationBackButton icon={backIcon} backAction={backAction} />
              ) : null}
              {prefix}
            </MobilePageHeaderPrefix>

            <MobilePageHeaderContent
              centered={centerContent}
              layout={
                contentLayout ?? (variant === "detail" ? "detail" : "default")
              }
            >
              {children}
            </MobilePageHeaderContent>

            <MobilePageHeaderSuffix>{suffix}</MobilePageHeaderSuffix>
          </MobilePageHeaderBar>
          {bottom}
        </MobilePageHeaderRoot>

        {/* Spacer */}
        <SafeArea top>
          <MobilePageHeaderSpacer />
          {bottom ? (
            <MobilePageHeaderSpacer
              data-myoxus-ui-role="mobile-page-header-bottom-spacer"
              size={bottomSpacing}
            />
          ) : null}
        </SafeArea>
      </>
    );
  },
);
