import { useI18n } from "@myoxus/i18n";
import { ArrowRightBigIcon } from "@myoxus/icons/react";
import {
  PublicShareFooterDescription,
  PublicShareFooterLink,
  PublicShareFooterPanel,
  PublicShareFooterRoot,
} from "@myoxus/ui-facade";

export const ShareFooter = () => {
  const t = useI18n();
  return (
    <PublicShareFooterRoot>
      <PublicShareFooterPanel>
        <PublicShareFooterDescription>
          {t["com.myoxus.share-page.footer.description"]()}
        </PublicShareFooterDescription>
        <PublicShareFooterLink
          href={BUILD_CONFIG.websiteUrl}
          target="_blank"
          rel="noreferrer"
        >
          {t["com.myoxus.share-page.footer.get-started"]()}
          <ArrowRightBigIcon />
        </PublicShareFooterLink>
      </PublicShareFooterPanel>
    </PublicShareFooterRoot>
  );
};
