import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { useI18n } from "@myoxus/i18n";
import { Button } from "@myoxus/ui-facade";

export const ImportTemplateButton = ({
  name,
  snapshotUrl,
}: {
  name: string;
  snapshotUrl: string;
}) => {
  const t = useI18n();
  const { jumpToImportTemplate } = useNavigateHelper();
  return (
    <Button
      variant="primary"
      onClick={() => jumpToImportTemplate(name, snapshotUrl)}
    >
      {t["com.myoxus.share-page.header.import-template"]()}
    </Button>
  );
};
