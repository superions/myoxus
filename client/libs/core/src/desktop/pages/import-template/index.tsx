import {
  RouteLogic,
  useNavigateHelper,
} from "@myoxus/core/components/hooks/use-navigate-helper";
import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { useI18n } from "@myoxus/i18n";
import { AllDocsIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  AuthPageContainer,
  Button,
  DialogFooterActions,
  EmptyState,
  EmptyStateTitle,
} from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";

export type TemplateImportRequest = {
  templateName: string;
  templateMode: DocMode;
  snapshotUrl: string;
};

export const parseTemplateImportRequest = (
  searchParams: URLSearchParams,
): TemplateImportRequest | null => {
  const templateName = searchParams.get("name")?.trim() ?? "";
  const templateMode = searchParams.get("mode") ?? "page";
  const snapshotUrl = searchParams.get("snapshotUrl")?.trim() ?? "";

  if (
    !templateName ||
    (templateMode !== "page" && templateMode !== "edgeless")
  ) {
    return null;
  }

  try {
    const parsedUrl = new URL(snapshotUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }

  return {
    templateName,
    templateMode,
    snapshotUrl,
  };
};

/**
 * /template/import page, only for web
 *
 * no ui for this route, just open the dialog
 */
export const Component = () => {
  const globalDialogService = useService(GlobalDialogService);
  const [searchParams] = useSearchParams();
  const { jumpToIndex } = useNavigateHelper();
  const t = useI18n();
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const request = useMemo(
    () => parseTemplateImportRequest(searchParams),
    [searchParams],
  );
  const handleSafeReturn = useCallback(
    () => jumpToIndex(RouteLogic.REPLACE),
    [jumpToIndex],
  );

  useEffect(() => {
    if (!request) return;

    returnFocusRef.current?.focus();
    const id = globalDialogService.open("import-template", {
      ...request,
    });

    return () => {
      globalDialogService.close(id);
    };
  }, [globalDialogService, request]);

  return (
    <AuthPageContainer>
      <EmptyState
        title={
          <EmptyStateTitle icon={<AllDocsIcon />}>
            {request
              ? t["com.myoxus.import-template.route.preparing.title"]()
              : t["com.myoxus.import-template.route.invalid.title"]()}
          </EmptyStateTitle>
        }
        description={
          request
            ? t["com.myoxus.import-template.route.preparing.description"]()
            : t["com.myoxus.import-template.route.invalid.description"]()
        }
        cta={
          <DialogFooterActions>
            <Button ref={returnFocusRef} onClick={handleSafeReturn}>
              {t["Go Back"]()}
            </Button>
          </DialogFooterActions>
        }
        data-testid={
          request ? "template-import-preparing" : "template-import-invalid"
        }
      />
    </AuthPageContainer>
  );
};
