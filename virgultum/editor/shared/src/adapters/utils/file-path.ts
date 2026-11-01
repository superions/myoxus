const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;
const WINDOWS_DRIVE_PATH = /^[a-z]:/i;

function isAbsoluteMarkdownPath(path: string) {
  return (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    WINDOWS_DRIVE_PATH.test(path)
  );
}

function decodeMarkdownPath(path: string) {
  if (isAbsoluteMarkdownPath(path) || ENCODED_PATH_SEPARATOR.test(path)) {
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return;
  }
  if (
    decoded.includes("\0") ||
    isAbsoluteMarkdownPath(decoded) ||
    ENCODED_PATH_SEPARATOR.test(decoded)
  ) {
    return;
  }
  return decoded.replaceAll("\\", "/");
}

function normalizeRootRelativeMarkdownPath(path: string) {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.pop()) return;
    } else {
      parts.push(part);
    }
  }
  return parts.length ? parts.join("/") : undefined;
}

/** Normalizes one untrusted archive path after exactly one URL decode. */
export function normalizeMarkdownSourcePath(path: string) {
  const decoded = decodeMarkdownPath(path);
  return decoded ? normalizeRootRelativeMarkdownPath(decoded) : undefined;
}

/** Resolves one untrusted Markdown target without permitting a batch-root escape. */
export function resolveMarkdownRelativePath(
  sourcePath: string,
  target: string,
) {
  const source = normalizeMarkdownSourcePath(sourcePath);
  const decodedTarget = decodeMarkdownPath(target);
  if (!source || !decodedTarget) return;
  const parent = source.split("/").slice(0, -1).join("/");
  return normalizeRootRelativeMarkdownPath(
    parent ? `${parent}/${decodedTarget}` : decodedTarget,
  );
}

/**
 * Normalizes a relative path by resolving all relative path segments
 * @param basePath The base path (markdown file's directory)
 * @param relativePath The relative path to normalize
 * @returns The full path
 */
function resolveFullPath(basePath: string, relativePath: string): string {
  // Split both paths into segments
  const baseSegments = basePath.split("/").filter(Boolean);
  const relativeSegments = relativePath.split("/").filter(Boolean);

  // Handle each segment of the relative path
  for (const segment of relativeSegments) {
    if (segment === ".") {
      // Current directory, do nothing
      continue;
    } else if (segment === "..") {
      // Parent directory, remove last segment from base
      if (baseSegments.length > 0) {
        baseSegments.pop();
      }
    } else {
      // Regular directory or file, add to base
      baseSegments.push(segment);
    }
  }

  // Join segments back into a path
  return baseSegments.join("/");
}

/**
 * Get the full path of the reference image from the file path and the image reference
 * @param filePath The full path of the file containing the image reference
 * @param imageReference The image reference from the file (can be relative or absolute path)
 * @returns The full path of the reference image
 */
export function getImageFullPath(
  filePath: string,
  imageReference: string,
): string {
  // Decode the image reference in case it contains URL-encoded characters
  const decodedReference = decodeURIComponent(imageReference);

  // Get the directory of the file path
  const markdownDir = filePath.substring(0, filePath.lastIndexOf("/"));

  // Check if the image reference is a relative path
  const isRelative = !decodedReference.startsWith("/");

  // If the image reference is a relative path, resolve it against the file path's directory
  // Otherwise, it is an absolute path, remove the leading slash if it exists
  return isRelative
    ? resolveFullPath(markdownDir, decodedReference)
    : decodedReference.replace(/^\//, "");
}
