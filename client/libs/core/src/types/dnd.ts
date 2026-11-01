import type { DNDData } from "@myoxus/ui-facade";

export type MyoxusDNDEntity =
  | {
      type: "database";
      id: string;
    }
  | {
      type: "doc";
      id: string;
    }
  | {
      type: "folder";
      id: string;
    }
  | {
      type: "collection";
      id: string;
    }
  | {
      type: "tag";
      id: string;
    }
  | {
      type: "custom-property";
      id: string;
    };

export interface MyoxusDNDData extends DNDData {
  draggable: {
    entity?: MyoxusDNDEntity;
    /**
     * Optional multi-entity payload for drags that originate from a selected
     * document set. Drop targets must keep the single `entity` fallback because
     * structure-tree and editor drags still move one item at a time.
     */
    selection?: {
      type: "doc";
      ids: string[];
    };
    from?:
      | {
          at: "structure-tree:organize:folder-node";
          nodeId: string;
        }
      | {
          at: "structure-tree:collection:list";
        }
      | {
          at: "structure-tree:doc:linked-docs";
          docId: string;
        }
      | {
          at: "structure-tree:collection:filtered-docs";
          collectionId: string;
        }
      | {
          at: "structure-tree:favorite:list";
        }
      | {
          at: "structure-tree:old-favorite:list";
        }
      | {
          at: "structure-tree:migration-data:list";
        }
      | {
          at: "all-pages:list";
        }
      | {
          at: "all-docs:list";
          /** Visible origin group interpreted by the active grouped view. */
          groupId?: string;
        }
      | {
          at: "tag-selector:list";
        }
      | {
          at: "all-collections:list";
        }
      | {
          at: "structure-tree:tags:list";
        }
      | {
          at: "structure-tree:tags:docs";
        }
      | {
          at: "app-header:tabs";
          tabId: string;
        }
      | {
          at: "doc-property:table";
          docId: string;
        }
      | {
          at: "doc-property:manager";
          workspaceId: string;
        }
      | {
          at: "doc-detail:header";
          docId: string;
        }
      | {
          at: "workbench:view";
          viewId: string;
        }
      | {
          at: "workbench:link";
          to: string;
        }
      | {
          at: "workbench:resize-handle";
          viewId: string;
          edge: "left" | "right";
        }
      | {
          at: "virgultum-editor";
        }
      | {
          at: "external"; // for external apps
        };
  };
  dropTarget:
    | {
        at: "structure-tree:organize:root";
      }
    | {
        at: "structure-tree:favorite:root";
      }
    | {
        at: "structure-tree:organize:folder";
      }
    | {
        at: "structure-tree:favorite:root";
      }
    | {
        at: "structure-tree:old-favorite:root";
      }
    | {
        at: "structure-tree:doc";
      }
    | {
        at: "app-sidebar:trash";
      }
    | {
        at: "structure-tree:tag";
      }
    | {
        at: "app-header:tabs";
      }
    | {
        at: "workbench:view";
        viewId: string;
      }
    | Record<string, unknown>;
}
