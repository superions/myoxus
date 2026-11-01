import { useExportPage } from "@myoxus/core/components/hooks/myoxus/use-export-page";
import {
  ExportMenuItems,
  PrintMenuItems,
} from "@myoxus/core/components/page-list";
import { EditorService } from "@myoxus/core/modules/editor";
import { MermaidDiagramsService } from "@myoxus/core/modules/mermaid-diagrams";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { MenuSection, MyoxusText, Stack } from "@myoxus/ui-facade";

export const ShareExport = () => {
  const t = useI18n();
  const editor = useService(EditorService).editor;
  const mermaidDiagramsService = useService(MermaidDiagramsService);
  const exportHandler = useExportPage();
  const currentMode = useLiveData(editor.mode$);
  const isMermaidDiagram = useLiveData(
    mermaidDiagramsService.isDiagramDoc$(editor.doc.virgultumDoc.id),
  );

  return (
    <Stack data-myoxus-ui-role="share-menu-export">
      <MenuSection>
        <MyoxusText tone="secondary" typographySlot="body-small">
          {t["com.myoxus.share-menu.ShareViaExportDescription"]()}
        </MyoxusText>
        <ExportMenuItems
          exportHandler={exportHandler}
          pageMode={currentMode}
          isMermaidDiagram={isMermaidDiagram}
        />
      </MenuSection>
      {currentMode === "page" && (
        <MenuSection>
          <MyoxusText tone="secondary" typographySlot="body-small">
            {t["com.myoxus.share-menu.ShareViaPrintDescription"]()}
          </MyoxusText>
          <PrintMenuItems exportHandler={exportHandler} />
        </MenuSection>
      )}
    </Stack>
  );
};
