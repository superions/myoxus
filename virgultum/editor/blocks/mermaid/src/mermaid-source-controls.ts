import { MERMAID_PRODUCT_TEMPLATES } from "./engine/product-types.js";

export type MermaidSourceControlChange = {
  source: string;
  templateId?: string;
};

export function resolveMermaidTemplateSourceControl(
  templateId: string,
): MermaidSourceControlChange | null {
  const template = MERMAID_PRODUCT_TEMPLATES.find(
    (item) => item.id === templateId,
  );
  if (!template) return null;
  return {
    source: template.source,
    templateId: template.id,
  };
}

export function resolveMermaidBlankSourceControl() {
  return (
    resolveMermaidTemplateSourceControl("flowchart-basic") ??
    resolveMermaidTemplateSourceControl(MERMAID_PRODUCT_TEMPLATES[0].id)
  );
}
