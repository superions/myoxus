import { MoreHorizontalIcon } from "@myoxus/icons/react";
import {
  IconButton,
  MobileMenu,
  MobilePageHeaderBar,
  MobilePageHeaderPrefix,
  MobilePageHeaderRoot,
  MobilePageHeaderSpacer,
  MobilePageHeaderSuffix,
  SafeArea,
} from "@myoxus/ui-facade";

import { AllDocsTabs } from "./tabs";

export interface AllDocsHeaderProps {
  operations?: React.ReactNode;
}

export const AllDocsHeader = ({ operations }: AllDocsHeaderProps) => {
  return (
    <>
      <MobilePageHeaderRoot data-myoxus-ui-role="mobile-all-docs-header">
        <MobilePageHeaderBar>
          <MobilePageHeaderPrefix>
            <AllDocsTabs />
          </MobilePageHeaderPrefix>
          <MobilePageHeaderSuffix>
            {operations ? (
              <MobileMenu items={operations}>
                <IconButton icon={<MoreHorizontalIcon />} />
              </MobileMenu>
            ) : null}
          </MobilePageHeaderSuffix>
        </MobilePageHeaderBar>
      </MobilePageHeaderRoot>
      <SafeArea top>
        <MobilePageHeaderSpacer />
      </SafeArea>
    </>
  );
};
