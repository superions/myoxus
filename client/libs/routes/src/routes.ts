// #region Path Parameter Types
export interface RouteParamsTypes {
  admin: { organization: { unit: { id: string } } };
}
// #endregion

// #region Absolute Paths
export const ROUTES = {
  index: "/",
  admin: {
    index: "/adminfrontend",
    auth: "/adminfrontend/auth",
    setup: "/adminfrontend/setup",
    configWizard: "/adminfrontend/config-wizard",
    dashboard: "/adminfrontend/dashboard",
    security: "/adminfrontend/security",
    workspaces: "/adminfrontend/workspaces",
    design: "/adminfrontend/design",
    typography: "/adminfrontend/typography",
    queue: "/adminfrontend/queue",
    gitSync: "/adminfrontend/git-sync",
    templates: "/adminfrontend/templates",
    documents: "/adminfrontend/documents",
    pdfExport: "/adminfrontend/pdf-export",
    ai: "/adminfrontend/ai",
    storage: "/adminfrontend/storage",
    performance: "/adminfrontend/performance",
    organization: {
      index: "/adminfrontend/organization",
      organigram: "/adminfrontend/organization/organigram",
      unit: "/adminfrontend/organization/units/:id",
    },
    configChanges: "/adminfrontend/config-changes",
    auditLog: "/adminfrontend/audit-log",
    system: "/adminfrontend/system",
    notFound: "/adminfrontend/404",
  },
};
// #endregion

// #region Relative Paths
export const RELATIVE_ROUTES = {
  index: "/",
  admin: {
    index: "adminfrontend",
    auth: "auth",
    setup: "setup",
    configWizard: "config-wizard",
    dashboard: "dashboard",
    security: "security",
    workspaces: "workspaces",
    design: "design",
    typography: "typography",
    queue: "queue",
    gitSync: "git-sync",
    templates: "templates",
    documents: "documents",
    pdfExport: "pdf-export",
    ai: "ai",
    storage: "storage",
    performance: "performance",
    organization: {
      index: "organization",
      organigram: "organigram",
      unit: "units/:id",
    },
    configChanges: "config-changes",
    auditLog: "audit-log",
    system: "system",
    notFound: "404",
  },
};
// #endregion

// #region Path Factories
const home = () => "/";
const admin = () => "/adminfrontend";
admin.auth = () => "/adminfrontend/auth";
admin.setup = () => "/adminfrontend/setup";
admin.configWizard = () => "/adminfrontend/config-wizard";
admin.dashboard = () => "/adminfrontend/dashboard";
admin.security = () => "/adminfrontend/security";
admin.workspaces = () => "/adminfrontend/workspaces";
admin.design = () => "/adminfrontend/design";
admin.typography = () => "/adminfrontend/typography";
admin.queue = () => "/adminfrontend/queue";
admin.gitSync = () => "/adminfrontend/git-sync";
admin.templates = () => "/adminfrontend/templates";
admin.documents = () => "/adminfrontend/documents";
admin.pdfExport = () => "/adminfrontend/pdf-export";
admin.ai = () => "/adminfrontend/ai";
admin.storage = () => "/adminfrontend/storage";
admin.performance = () => "/adminfrontend/performance";
const admin_organization = () => "/adminfrontend/organization";
admin_organization.organigram = () => "/adminfrontend/organization/organigram";
admin_organization.unit = (params: { id: string }) =>
  `/adminfrontend/organization/units/${params.id}`;
admin.organization = admin_organization;
admin.configChanges = () => "/adminfrontend/config-changes";
admin.auditLog = () => "/adminfrontend/audit-log";
admin.system = () => "/adminfrontend/system";
admin.notFound = () => "/adminfrontend/404";
export const FACTORIES = { admin, home };
// #endregion
