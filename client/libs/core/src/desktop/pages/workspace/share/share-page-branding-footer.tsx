import { EditorService } from "@myoxus/core/modules/editor";
import { AuthService } from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  BrandAssetImage,
  PublicShareFloatingBrandIcon,
  PublicShareFloatingBrandLink,
  PublicShareFloatingBrandText,
} from "@myoxus/ui-facade";

/**
 * "Built with Myoxus" branding footer shown at the bottom of the share page.
 *
 * Hidden while the editor is in presentation mode and for authenticated users
 * (logged-in users already know the product). Only rendered in browser
 * environments (not Electron).
 */
export const SharePageBrandingFooter = () => {
  const t = useI18n();
  const editorService = useService(EditorService);
  const isPresent = useLiveData(editorService.editor.isPresenting$);
  const authService = useService(AuthService);
  const loginStatus = useLiveData(authService.session.status$);

  if (isPresent || loginStatus === "authenticated") {
    return null;
  }
  return (
    <PublicShareFloatingBrandLink
      href={BUILD_CONFIG.websiteUrl}
      target="_blank"
      rel="noreferrer"
    >
      <PublicShareFloatingBrandText>
        {t["com.myoxus.share-page.footer.built-with"]()}
      </PublicShareFloatingBrandText>
      <PublicShareFloatingBrandIcon>
        <BrandAssetImage slot="productMark" alt="Myoxus Product Mark" />
      </PublicShareFloatingBrandIcon>
    </PublicShareFloatingBrandLink>
  );
};
