export type TemplateDocSettings = {
  enablePageTemplate?: boolean;
  pageTemplateId?: string;
  journalTemplateId?: string;
  /**
   * Retained only for deployed settings compatibility. Cloud and local
   * reconciliation no longer use this legacy cleanup marker.
   */
  builtinReconcileMigrationDone?: boolean;
  /**
   * Local/offline slug → Yjs document mapping. Cloud workspaces project the
   * authoritative Registry binding and never use this setting for lifecycle
   * decisions.
   */
  builtinTemplateInstanceDocIds?: Record<string, string>;
  /**
   * Retained only for deployed settings compatibility. The server binding is
   * authoritative for cloud retirement and restoration.
   */
  userTrashedBuiltinSlugs?: string[];
};
