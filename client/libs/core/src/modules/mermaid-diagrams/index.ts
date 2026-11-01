import { type Framework } from "@myoxus/infra";

import { DocsService } from "../doc";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { MermaidDiagramsService } from "./services/mermaid-diagrams";
import { MermaidDiagramsStore } from "./store/mermaid-diagrams";

export {
  DIAGRAM_DOC_KIND,
  DEFAULT_MERMAID_DIAGRAM_SOURCE,
  DEFAULT_MERMAID_DIAGRAM_TITLE,
} from "./constants";
export { MermaidDiagramsService } from "./services/mermaid-diagrams";
export { MermaidDiagramsStore } from "./store/mermaid-diagrams";

export function configureMermaidDiagramsModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(MermaidDiagramsService, [
      MermaidDiagramsStore,
      DocsService,
      WorkspaceService,
    ])
    .store(MermaidDiagramsStore, [DocsService, WorkspaceService]);
}
