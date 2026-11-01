export interface TemplateImportWarning {
  code: string;
  message: string;
  field?: string;
  severity: string;
}

export interface TemplateImportResult {
  entry: { id: string; slug: string; title: string } | null;
  revision: { id: string; version: string; state: string } | null;
  documents?: {
    entry: { id: string; slug: string; title: string };
    revision: { id: string; version: string; state: string };
  }[];
  package?: { package_id: string; version: string } | null;
  jobId?: string | null;
  error?: string | null;
  warnings: TemplateImportWarning[];
  detectedFormat?: string;
  normalized?: boolean;
  ignoredEntriesCount?: number;
  errorCatalogVersion?: string;
}

export interface TemplateImportStatusModel {
  detectedFormat: string | null;
  normalizationWarnings: string[];
  compatibilityNotes: string[];
  ignoredEntriesCount: number | null;
  normalized: boolean | null;
  errorCatalogVersion: string | null;
}

export interface TemplateImportErrorDetail {
  errorCode?: string;
  path?: string;
  message: string;
}

export interface TemplateImportErrorState {
  message: string;
  details: TemplateImportErrorDetail[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePath(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === "string" || typeof part === "number") {
          return String(part);
        }
        return null;
      })
      .filter((part): part is string => !!part);

    return parts.length > 0 ? parts.join(".") : undefined;
  }

  return readString(value);
}

function parseJsonLikeString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function createImportErrorDetail(
  record: Record<string, unknown>,
): TemplateImportErrorDetail | null {
  const errorCode = readString(record.error_code) ?? readString(record.code);
  const path = normalizePath(record.path);
  const message =
    readString(record.human_message) ??
    readString(record.message) ??
    readString(record.error);

  if (!message && !errorCode && !path) {
    return null;
  }

  return {
    errorCode,
    path,
    message: message ?? "Validation error",
  };
}

function collectImportErrorDetails(
  value: unknown,
  seen = new WeakSet<object>(),
): TemplateImportErrorDetail[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectImportErrorDetails(entry, seen));
  }

  if (typeof value === "string") {
    const parsed = parseJsonLikeString(value);
    return parsed === value ? [] : collectImportErrorDetails(parsed, seen);
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  if (seen.has(record)) {
    return [];
  }
  seen.add(record);

  const details: TemplateImportErrorDetail[] = [];
  const detail = createImportErrorDetail(record);
  if (detail) {
    details.push(detail);
  }

  for (const key of [
    "errors",
    "details",
    "causes",
    "issues",
    "violations",
    "extensions",
    "data",
    "originalError",
    "cause",
  ]) {
    if (key in record) {
      details.push(...collectImportErrorDetails(record[key], seen));
    }
  }

  return details;
}

export function parseTemplateImportError(
  error: unknown,
): TemplateImportErrorState {
  const message =
    (error instanceof Error ? error.message : readString(error)) ??
    "Import failed.";
  const details = collectImportErrorDetails(error)
    .filter((detail, index, all) => {
      const signature = `${detail.errorCode ?? ""}|${detail.path ?? ""}|${detail.message}`;
      return (
        all.findIndex((entry) => {
          return (
            `${entry.errorCode ?? ""}|${entry.path ?? ""}|${entry.message}` ===
            signature
          );
        }) === index
      );
    })
    .filter((detail) => {
      return detail.message !== message || !!detail.errorCode || !!detail.path;
    });

  return { message, details };
}

export function buildTemplateImportStatusModel(
  result: TemplateImportResult,
): TemplateImportStatusModel {
  const normalizationWarnings = result.warnings
    .filter((warning) => {
      const code = warning.code.toLowerCase();
      const message = warning.message.toLowerCase();
      return code.includes("normaliz") || message.includes("normaliz");
    })
    .map((warning) => `${warning.code}: ${warning.message}`);

  const compatibilityNotes = result.warnings
    .filter((warning) => {
      const code = warning.code.toLowerCase();
      const message = warning.message.toLowerCase();
      return !code.includes("normaliz") && !message.includes("normaliz");
    })
    .map((warning) => `${warning.code}: ${warning.message}`);

  return {
    detectedFormat: result.detectedFormat ?? null,
    normalizationWarnings,
    compatibilityNotes,
    ignoredEntriesCount:
      typeof result.ignoredEntriesCount === "number"
        ? result.ignoredEntriesCount
        : null,
    normalized:
      typeof result.normalized === "boolean" ? result.normalized : null,
    errorCatalogVersion: result.errorCatalogVersion ?? null,
  };
}

export function parseTemplateExportFilename(
  headerValue: string | null,
): string | null {
  if (!headerValue) {
    return null;
  }

  const utf8Match = headerValue.match(/filename\*\s*=\s*([^;]+)/i);
  const encodedFilename = utf8Match?.[1]?.trim();
  if (encodedFilename) {
    const normalized = encodedFilename
      .replace(/^UTF-8''/i, "")
      .replace(/^"(.*)"$/, "$1");

    try {
      return decodeURIComponent(normalized).replace(/[\\/]/g, "-");
    } catch {
      return normalized.replace(/[\\/]/g, "-");
    }
  }

  const plainMatch = headerValue.match(
    /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i,
  );
  const filename = plainMatch?.[1] ?? plainMatch?.[2];

  return filename ? filename.trim().replace(/[\\/]/g, "-") : null;
}

export async function readTemplateExportError(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const body = await response.json();
      const message =
        typeof body?.message === "string"
          ? body.message
          : typeof body?.error === "string"
            ? body.error
            : null;
      if (message) {
        return message;
      }
    } catch {}
  }

  try {
    const text = await response.text();
    if (text) {
      return text;
    }
  } catch {}

  return `request failed with status ${response.status}`;
}
