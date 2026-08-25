import cors from "cors";
import express, { Request, Response } from "express";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { createReadStream, promises as fs, readFileSync } from "fs";
import { exiftool } from "exiftool-vendored";
import path from "path";

const loadServerEnv = () => {
  const envPath = path.resolve(__dirname, "../.env");

  try {
    const envFileContents = readFileSync(envPath, "utf8");
    envFileContents.split(/\r?\n/).forEach((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) {
        return;
      }

      const separatorIndex = trimmedLine.indexOf("=");
      if (separatorIndex <= 0) {
        return;
      }

      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine.slice(separatorIndex + 1).trim();
      if (!key || typeof process.env[key] === "string") {
        return;
      }

      process.env[key] = value;
    });
  } catch {
    // Ignore missing .env files and continue with existing process env.
  }
};

loadServerEnv();

type MediaKind = "image" | "video";
type ContentType = "image" | "video" | "gif";
type TagFilterMode = "AND" | "OR";

type MediaResult = {
  name: string;
  mimeType: string;
  kind: MediaKind;
  sizeBytes: number;
  streamUrl: string;
  tags: string[];
};

type AddImageTagBody = {
  tag?: string;
};

type ForgetRootBody = {
  root?: string | null;
};

type ImageTagRouteParams = {
  fileName: string;
};

type DeleteImageTagRouteParams = {
  fileName: string;
  tagName: string;
};

type MediaFile = {
  relativePath: string;
  fullPath: string;
  sizeBytes: number;
};

type FolderNode = {
  name: string;
  path: string;
  relativePath: string;
  imageCount: number;
  gifCount: number;
  videoCount: number;
  children: FolderNode[];
};

type CachedMediaEntry = MediaResult & {
  fullPath: string;
};

type MediaIndex = {
  rootDirectoryPath: string;
  mediaByRelativePath: Map<string, CachedMediaEntry>;
  sortedMedia: CachedMediaEntry[];
  scannedFiles: number;
  supportedFiles: number;
  builtAtMs: number;
  maxSupportedFiles?: number;
};

type MediaIndexOptions = {
  maxSupportedFiles?: number;
};

type MediaIndexProgress = {
  status: "idle" | "enumerating" | "indexing" | "complete" | "error";
  scannedFiles: number;
  totalFiles: number;
  indexedFiles: number;
  startedAtMs: number;
  updatedAtMs: number;
  error?: string;
};

type MediaIndexProgressResponse = {
  status: MediaIndexProgress["status"];
  current: number;
  total: number;
  percent: number;
  indexedFiles: number;
  startedAtMs: number;
  updatedAtMs: number;
  error?: string;
};

const app = express();
const port = Number(process.env.PORT ?? 3001);
const testDirPath = path.resolve(__dirname, "../../outdir");
const testDirName = path.basename(testDirPath).toLowerCase();
const scanProgressInterval = Number(process.env.SCAN_PROGRESS_INTERVAL ?? 250);
const isTestModeEnabled = process.env.TEST_MODE === "true";
const testModeMaxSupportedFiles = 500;
const mediaIndexByCacheKey = new Map<string, MediaIndex>();
const mediaIndexBuildsByCacheKey = new Map<string, Promise<MediaIndex>>();
const mediaIndexProgressByCacheKey = new Map<string, MediaIndexProgress>();
let requestSequence = 0;

const createRequestLabel = (scope: string): string => {
  requestSequence += 1;
  return `${scope}#${requestSequence}`;
};

const logProgress = (label: string, message: string): void => {
  console.log(`[${label}] ${message}`);
};

export const serializeMediaIndexProgress = (
  progress: MediaIndexProgress,
): MediaIndexProgressResponse => {
  const total = Math.max(progress.totalFiles, progress.scannedFiles, 1);
  const current = Math.min(progress.scannedFiles, total);
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  return {
    status: progress.status,
    current,
    total,
    percent: Math.max(0, Math.min(100, percent)),
    indexedFiles: progress.indexedFiles,
    startedAtMs: progress.startedAtMs,
    updatedAtMs: progress.updatedAtMs,
    ...(progress.error ? { error: progress.error } : {}),
  };
};

const selectRootFolderFromDialog = async (): Promise<string | null> => {
  if (process.platform !== "win32") {
    throw new Error(
      "Server-side folder picker is currently only implemented for Windows.",
    );
  }

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select a folder"
$dialog.ShowNewFolderButton = $true

# Preselect this folder
$dialog.SelectedPath = "Z:\\Pics"

if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;

  return await new Promise<string | null>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", psScript],
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }

        const selectedPath = stdout.trim();
        resolve(selectedPath || null);
      },
    );
  });
};

const normalizeRootCacheKey = (rootDirectoryPath: string): string => {
  const normalizedRoot = path.normalize(rootDirectoryPath).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
};

const resolveRootDirectoryPath = (
  rootDirectoryValue?: string | null,
): string => {
  if (!rootDirectoryValue || !rootDirectoryValue.trim()) {
    return testDirPath;
  }

  const normalizedRoot = rootDirectoryValue.replace(/\\/g, "/").trim();
  if (!normalizedRoot || normalizedRoot === "." || normalizedRoot === "..") {
    return testDirPath;
  }

  if (path.isAbsolute(normalizedRoot)) {
    return path.normalize(path.resolve(normalizedRoot));
  }

  const segments = normalizedRoot.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return testDirPath;
  }

  // Selecting the default root directory should map to the root itself, not root/root.
  if (segments.length === 1 && segments[0].toLowerCase() === testDirName) {
    return testDirPath;
  }

  const resolvedRoot = path.resolve(testDirPath, normalizedRoot);
  const rootPrefix = `${path.resolve(testDirPath)}${path.sep}`;

  if (
    resolvedRoot !== path.resolve(testDirPath) &&
    !resolvedRoot.startsWith(rootPrefix)
  ) {
    return testDirPath;
  }

  return path.normalize(resolvedRoot);
};

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

const mediaByExt: Record<string, { mimeType: string; kind: MediaKind }> = {
  ".jpg": { mimeType: "image/jpeg", kind: "image" },
  ".jpeg": { mimeType: "image/jpeg", kind: "image" },
  ".png": { mimeType: "image/png", kind: "image" },
  ".gif": { mimeType: "image/gif", kind: "image" },
  ".webp": { mimeType: "image/webp", kind: "image" },
  ".bmp": { mimeType: "image/bmp", kind: "image" },
  ".mp4": { mimeType: "video/mp4", kind: "video" },
  ".mov": { mimeType: "video/quicktime", kind: "video" },
  ".m4v": { mimeType: "video/x-m4v", kind: "video" },
  ".webm": { mimeType: "video/webm", kind: "video" },
  ".mkv": { mimeType: "video/x-matroska", kind: "video" },
  ".avi": { mimeType: "video/x-msvideo", kind: "video" },
};

const getMediaDescriptor = (fileName: string) => {
  const extension = path.extname(fileName).toLowerCase();
  const descriptor = mediaByExt[extension];
  return descriptor ? { extension, descriptor } : null;
};

const classifyMediaContentType = (
  media: Pick<MediaResult, "mimeType" | "kind" | "name">,
): ContentType => {
  const mimeType = media.mimeType.toLowerCase();
  const isGif =
    mimeType === "image/gif" || media.name.toLowerCase().endsWith(".gif");

  if (isGif) {
    return "gif";
  }

  if (media.kind === "video" || mimeType.startsWith("video/")) {
    return "video";
  }

  return "image";
};

const toRelativeFolderPath = (rootDirectoryPath: string, selectedFolderPath: string): string => {
  const relativePath = path.relative(rootDirectoryPath, selectedFolderPath).replace(/\\/g, "/");
  return relativePath === "." ? "" : relativePath;
};

const getParentRelativePath = (relativePath: string): string => {
  const lastSeparatorIndex = relativePath.lastIndexOf("/");
  return lastSeparatorIndex === -1 ? "" : relativePath.slice(0, lastSeparatorIndex);
};

const createMediaStreamUrl = (relativePath: string, rootDirectoryPath: string): string => {
  const streamParams = new URLSearchParams();
  streamParams.set("root", rootDirectoryPath);
  return `/api/media/${encodeURIComponent(relativePath)}/stream?${streamParams.toString()}`;
};

const resolveTestModeLimit = (): number | undefined =>
  isTestModeEnabled ? testModeMaxSupportedFiles : undefined;

const createMediaIndexCacheKey = (
  rootDirectoryPath: string,
  options?: MediaIndexOptions,
): string => {
  const modeSuffix = options?.maxSupportedFiles
    ? `test:${options.maxSupportedFiles}`
    : "full";
  return `${normalizeRootCacheKey(rootDirectoryPath)}::${modeSuffix}`;
};

const buildMediaIndex = async (
  rootDirectoryPath: string,
  requestLabel: string,
  indexCacheKey: string,
  options?: MediaIndexOptions,
): Promise<MediaIndex> => {
  const now = Date.now();
  mediaIndexProgressByCacheKey.set(indexCacheKey, {
    status: "enumerating",
    scannedFiles: 0,
    totalFiles: 0,
    indexedFiles: 0,
    startedAtMs: now,
    updatedAtMs: now,
  });

  const mediaByRelativePath = new Map<string, CachedMediaEntry>();
  const sortedMedia: CachedMediaEntry[] = [];
  const mediaFiles = await walkMediaFilesInFolder(
    rootDirectoryPath,
    rootDirectoryPath,
    true,
  );
  mediaFiles.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const maxSupportedFiles = options?.maxSupportedFiles;

  mediaIndexProgressByCacheKey.set(indexCacheKey, {
    status: "indexing",
    scannedFiles: 0,
    totalFiles: mediaFiles.length,
    indexedFiles: 0,
    startedAtMs: now,
    updatedAtMs: Date.now(),
  });

  let scannedFiles = 0;
  let supportedFiles = 0;

  logProgress(requestLabel, `Building media index. discoveredFiles=${mediaFiles.length}`);

  for (const mediaFile of mediaFiles) {
    scannedFiles += 1;

    const descriptorResult = getMediaDescriptor(mediaFile.relativePath);
    if (!descriptorResult) {
      mediaIndexProgressByCacheKey.set(indexCacheKey, {
        status: "indexing",
        scannedFiles,
        totalFiles: mediaFiles.length,
        indexedFiles: supportedFiles,
        startedAtMs: now,
        updatedAtMs: Date.now(),
      });

      if (scannedFiles % scanProgressInterval === 0) {
        logProgress(
          requestLabel,
          `Index progress: scanned=${scannedFiles}/${mediaFiles.length}, supported=${supportedFiles}`,
        );
      }
      continue;
    }

    const { descriptor } = descriptorResult;

    if (typeof maxSupportedFiles === "number" && supportedFiles >= maxSupportedFiles) {
      break;
    }

    supportedFiles += 1;

    let tags: string[] = [];
    try {
      const metadata = await exiftool.read(mediaFile.fullPath);
      tags = getTagsFromMetadata(metadata);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logProgress(
        requestLabel,
        `Unable to read metadata for '${mediaFile.relativePath}'; indexing it without tags. ${message}`,
      );
    }

    const indexedEntry: CachedMediaEntry = {
      name: mediaFile.relativePath,
      fullPath: mediaFile.fullPath,
      mimeType: descriptor.mimeType,
      kind: descriptor.kind,
      sizeBytes: mediaFile.sizeBytes,
      streamUrl: createMediaStreamUrl(mediaFile.relativePath, rootDirectoryPath),
      tags,
    };

    mediaByRelativePath.set(mediaFile.relativePath, indexedEntry);
    sortedMedia.push(indexedEntry);

    mediaIndexProgressByCacheKey.set(indexCacheKey, {
      status: "indexing",
      scannedFiles,
      totalFiles: mediaFiles.length,
      indexedFiles: supportedFiles,
      startedAtMs: now,
      updatedAtMs: Date.now(),
    });

    if (scannedFiles % scanProgressInterval === 0) {
      logProgress(
        requestLabel,
        `Index progress: scanned=${scannedFiles}/${mediaFiles.length}, supported=${supportedFiles}, indexed=${sortedMedia.length}`,
      );
    }
  }

  sortedMedia.sort((left, right) => left.name.localeCompare(right.name));

  mediaIndexProgressByCacheKey.set(indexCacheKey, {
    status: "complete",
    scannedFiles,
    totalFiles: mediaFiles.length,
    indexedFiles: supportedFiles,
    startedAtMs: now,
    updatedAtMs: Date.now(),
  });

  return {
    rootDirectoryPath,
    mediaByRelativePath,
    sortedMedia,
    scannedFiles,
    supportedFiles,
    builtAtMs: Date.now(),
    maxSupportedFiles,
  };
};

const ensureMediaIndex = async (
  rootDirectoryPath: string,
  requestLabel: string,
  options?: { force?: boolean; maxSupportedFiles?: number },
): Promise<MediaIndex> => {
  const shouldForce = options?.force ?? false;
  const indexCacheKey = createMediaIndexCacheKey(rootDirectoryPath, {
    maxSupportedFiles: options?.maxSupportedFiles,
  });

  const cachedIndex = mediaIndexByCacheKey.get(indexCacheKey);
  if (cachedIndex && !shouldForce) {
    return cachedIndex;
  }

  const pendingBuild = mediaIndexBuildsByCacheKey.get(indexCacheKey);
  if (pendingBuild && !shouldForce) {
    return pendingBuild;
  }

  const buildPromise = buildMediaIndex(
    rootDirectoryPath,
    requestLabel,
    indexCacheKey,
    {
      maxSupportedFiles: options?.maxSupportedFiles,
    },
  )
    .then((index) => {
      mediaIndexByCacheKey.set(indexCacheKey, index);
      return index;
    })
    .catch((err: unknown) => {
      const previousProgress = mediaIndexProgressByCacheKey.get(indexCacheKey);
      const startedAtMs = previousProgress?.startedAtMs ?? Date.now();
      mediaIndexProgressByCacheKey.set(indexCacheKey, {
        status: "error",
        scannedFiles: previousProgress?.scannedFiles ?? 0,
        totalFiles: previousProgress?.totalFiles ?? 0,
        indexedFiles: previousProgress?.indexedFiles ?? 0,
        startedAtMs,
        updatedAtMs: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    })
    .finally(() => {
      mediaIndexBuildsByCacheKey.delete(indexCacheKey);
    });

  mediaIndexBuildsByCacheKey.set(indexCacheKey, buildPromise);
  return buildPromise;
};

const clearMediaIndexCacheForRoot = (
  rootDirectoryPath: string,
): {
  clearedIndexes: number;
  clearedBuilds: number;
  clearedProgress: number;
} => {
  let clearedIndexes = 0;
  let clearedBuilds = 0;
  let clearedProgress = 0;
  const cacheKeyPrefix = `${normalizeRootCacheKey(rootDirectoryPath)}::`;

  Array.from(mediaIndexByCacheKey.keys()).forEach((cacheKey) => {
    if (!cacheKey.startsWith(cacheKeyPrefix)) {
      return;
    }

    mediaIndexByCacheKey.delete(cacheKey);
    clearedIndexes += 1;
  });

  Array.from(mediaIndexBuildsByCacheKey.keys()).forEach((cacheKey) => {
    if (!cacheKey.startsWith(cacheKeyPrefix)) {
      return;
    }

    mediaIndexBuildsByCacheKey.delete(cacheKey);
    clearedBuilds += 1;
  });

  Array.from(mediaIndexProgressByCacheKey.keys()).forEach((cacheKey) => {
    if (!cacheKey.startsWith(cacheKeyPrefix)) {
      return;
    }

    mediaIndexProgressByCacheKey.delete(cacheKey);
    clearedProgress += 1;
  });

  return { clearedIndexes, clearedBuilds, clearedProgress };
};

const getMediaForSelectedFolder = (
  index: MediaIndex,
  rootDirectoryPath: string,
  selectedFolderPath: string,
  recursive: boolean,
): CachedMediaEntry[] => {
  const selectedFolderRelativePath = toRelativeFolderPath(rootDirectoryPath, selectedFolderPath);

  if (recursive) {
    if (!selectedFolderRelativePath) {
      return index.sortedMedia;
    }

    const selectedFolderPrefix = `${selectedFolderRelativePath}/`;
    return index.sortedMedia.filter((entry) => entry.name.startsWith(selectedFolderPrefix));
  }

  return index.sortedMedia.filter(
    (entry) => getParentRelativePath(entry.name) === selectedFolderRelativePath,
  );
};

const updateCachedMediaTags = (
  rootDirectoryPath: string,
  relativePath: string,
  tags: string[],
): void => {
  const normalizedTags = Array.from(
    new Set(tags.map((tag) => normalizeTagToken(tag))),
  ).filter(Boolean);

  mediaIndexByCacheKey.forEach((index) => {
    if (index.rootDirectoryPath !== rootDirectoryPath) {
      return;
    }

    const entry = index.mediaByRelativePath.get(relativePath);
    if (!entry) {
      return;
    }

    entry.tags = normalizedTags;
  });
};

const removeCachedMediaEntry = (
  rootDirectoryPath: string,
  relativePath: string,
): void => {
  mediaIndexByCacheKey.forEach((index) => {
    if (index.rootDirectoryPath !== rootDirectoryPath) {
      return;
    }

    if (!index.mediaByRelativePath.has(relativePath)) {
      return;
    }

    index.mediaByRelativePath.delete(relativePath);
    index.sortedMedia = index.sortedMedia.filter(
      (entry) => entry.name !== relativePath,
    );
  });
};

const resolveMediaFilePath = (
  relativePath: string,
  baseRootDirectoryPath = testDirPath,
): string | null => {
  const normalizedRelativePath = relativePath.replace(/\\/g, "/").trim();
  if (!normalizedRelativePath) {
    return null;
  }

  const fullPath = path.resolve(baseRootDirectoryPath, normalizedRelativePath);
  const rootPath = `${path.resolve(baseRootDirectoryPath)}${path.sep}`;

  if (
    fullPath !== path.resolve(baseRootDirectoryPath) &&
    !fullPath.startsWith(rootPath)
  ) {
    return null;
  }

  return fullPath;
};

const statMediaFileForMetadataUpdate = async (
  fullPath: string,
): Promise<Awaited<ReturnType<typeof fs.stat>> | null> => {
  const retryDelaysMs = [75, 200, 500];

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fs.stat(fullPath);
    } catch (err) {
      const errorCode = (err as NodeJS.ErrnoException).code;
      if (errorCode !== "EPERM") {
        throw err;
      }

      const retryDelayMs = retryDelaysMs[attempt];
      if (typeof retryDelayMs !== "number") {
        // Windows and network drives can reject stat temporarily even though
        // ExifTool can access the file. Let the metadata read verify it next.
        return null;
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDelayMs);
      });
    }
  }
};

const normalizeFileTypeExtension = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/^\./, "");
  return normalized || null;
};

const prepareWritableMediaFile = async (
  fullPath: string,
  metadata: Awaited<ReturnType<typeof exiftool.read>>,
): Promise<{ path: string; isTemporary: boolean }> => {
  const pathExtension = normalizeFileTypeExtension(path.extname(fullPath));
  const metadataExtension = normalizeFileTypeExtension(
    (metadata as { FileTypeExtension?: unknown }).FileTypeExtension,
  );

  if (
    !metadataExtension ||
    metadataExtension === pathExtension ||
    !mediaByExt[`.${metadataExtension}`]
  ) {
    return { path: fullPath, isTemporary: false };
  }

  const directoryName = path.dirname(fullPath);
  const baseName = path.basename(fullPath, path.extname(fullPath));
  const temporaryPath = path.join(
    directoryName,
    `${baseName}.exiftool-write.${metadataExtension}`,
  );

  await fs.copyFile(fullPath, temporaryPath);
  return { path: temporaryPath, isTemporary: true };
};

const walkMediaFilesRecursive = async (
  directoryPath: string,
  basePath = directoryPath,
): Promise<MediaFile[]> => {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const mediaFiles: MediaFile[] = [];

  for (const entry of entries) {
    const entryFullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      mediaFiles.push(
        ...(await walkMediaFilesRecursive(entryFullPath, basePath)),
      );
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = path
      .relative(basePath, entryFullPath)
      .replace(/\\/g, "/");
    const stat = await fs.stat(entryFullPath);

    mediaFiles.push({
      relativePath,
      fullPath: entryFullPath,
      sizeBytes: Number(stat.size),
    });
  }

  return mediaFiles;
};

const walkMediaFilesInFolder = async (
  directoryPath: string,
  basePath = directoryPath,
  recursive = false,
): Promise<MediaFile[]> => {
  if (recursive) {
    return walkMediaFilesRecursive(directoryPath, basePath);
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const mediaFiles: MediaFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const entryFullPath = path.join(directoryPath, entry.name);
    const relativePath = path
      .relative(basePath, entryFullPath)
      .replace(/\\/g, "/");
    const stat = await fs.stat(entryFullPath);

    mediaFiles.push({
      relativePath,
      fullPath: entryFullPath,
      sizeBytes: Number(stat.size),
    });
  }

  return mediaFiles;
};

const resolveMediaFolderPath = (
  relativePath: string,
  baseRootDirectoryPath = testDirPath,
): string | null => {
  const normalizedRelativePath = relativePath.replace(/\\/g, "/").trim();
  if (!normalizedRelativePath || normalizedRelativePath === ".") {
    return baseRootDirectoryPath;
  }

  if (path.isAbsolute(normalizedRelativePath)) {
    return null;
  }

  const segments = normalizedRelativePath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    return null;
  }

  const fullPath = path.resolve(baseRootDirectoryPath, normalizedRelativePath);
  const rootPath = path.resolve(baseRootDirectoryPath);

  if (fullPath !== rootPath && !fullPath.startsWith(`${rootPath}${path.sep}`)) {
    return null;
  }

  return fullPath;
};

const buildFolderTree = async (
  directoryPath: string,
  rootDirectoryPath = directoryPath,
): Promise<FolderNode> => {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const children: FolderNode[] = [];
  let imageCount = 0;
  let gifCount = 0;
  let videoCount = 0;

  for (const entry of entries) {
    const entryFullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      const childTree = await buildFolderTree(entryFullPath, rootDirectoryPath);

      children.push({
        name: childTree.name,
        path: entryFullPath,
        relativePath: childTree.relativePath,
        imageCount: childTree.imageCount,
        gifCount: childTree.gifCount,
        videoCount: childTree.videoCount,
        children: childTree.children,
      });
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const descriptorResult = getMediaDescriptor(entry.name);
    if (!descriptorResult) {
      continue;
    }

    if (entry.name.toLowerCase().endsWith(".gif")) {
      gifCount += 1;
      continue;
    }

    if (descriptorResult.descriptor.kind === "video") {
      videoCount += 1;
      continue;
    }

    imageCount += 1;
  }

  children.sort((left, right) => left.name.localeCompare(right.name));

  return {
    name: path.basename(directoryPath),
    path: directoryPath,
    relativePath:
      path.relative(rootDirectoryPath, directoryPath).replace(/\\/g, "/") || "",
    imageCount,
    gifCount,
    videoCount,
    children,
  };
};

const countFolderTreeNodes = (node: FolderNode): number =>
  1 +
  node.children.reduce(
    (count, child) => count + countFolderTreeNodes(child),
    0,
  );

export { buildFolderTree, walkMediaFilesInFolder };

const normalizeTagToken = (value: unknown): string => {
  if (value === null || typeof value === "undefined") {
    return "";
  }

  return String(value).trim().replace(/^\{/, "").replace(/\}$/, "");
};

const toCommentTags = (comment: string): string[] => {
  if (!comment.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(comment) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([key, value]) => {
        const encodedValue =
          typeof value === "string" ? `"${value}"` : JSON.stringify(value);
        return `"${key}":${encodedValue}`;
      });
    }
  } catch {
    // Fall back to comma-splitting for plain-text comments.
  }

  return comment
    .split(/\s*,\s*/)
    .map((entry) => normalizeTagToken(entry))
    .filter(Boolean);
};

const removeTagFromComment = (
  comment: string,
  tagName: string,
): { changed: boolean; value: string } => {
  const trimmedComment = comment.trim();
  if (!trimmedComment) {
    return { changed: false, value: comment };
  }

  try {
    const parsed = JSON.parse(trimmedComment) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keyMatch = tagName.match(/^"([^"]+)":/);
      if (!keyMatch) {
        return { changed: false, value: comment };
      }

      const key = keyMatch[1];
      if (!(key in parsed)) {
        return { changed: false, value: comment };
      }

      delete parsed[key];
      return { changed: true, value: JSON.stringify(parsed) };
    }
  } catch {
    // Ignore and fall back to comma-based removal.
  }

  const normalizedTarget = normalizeTagToken(tagName);
  const entries = trimmedComment
    .split(/\s*,\s*/)
    .map((entry) => normalizeTagToken(entry))
    .filter(Boolean);
  const updatedEntries = entries.filter((entry) => entry !== normalizedTarget);

  return {
    changed: updatedEntries.length !== entries.length,
    value: updatedEntries.join(", "),
  };
};

const getTagsFromMetadata = (
  metadata: Awaited<ReturnType<typeof exiftool.read>>,
) => {
  const tagsFromKeywords = Array.isArray(metadata.Keywords)
    ? metadata.Keywords
    : metadata.Keywords
      ? [metadata.Keywords]
      : [];

  const tagsFromComment =
    typeof metadata.Comment === "string" && metadata.Comment.length > 0
      ? toCommentTags(metadata.Comment)
      : [];

  return Array.from(
    new Set(
      [...tagsFromKeywords, ...tagsFromComment].map((tag) =>
        normalizeTagToken(tag),
      ),
    ),
  ).filter(Boolean);
};

const writeMetadataWithXmpRepair = async (
  fullPath: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  const writeArgs = ["-overwrite_original_in_place", "-m"];

  const cleanupExiftoolTempFile = async (): Promise<void> => {
    const orphanTempPath = `${fullPath}_exiftool_tmp`;
    await fs.unlink(orphanTempPath).catch((err) => {
      const errorCode = (err as NodeJS.ErrnoException).code;
      if (errorCode !== "ENOENT") {
        throw err;
      }
    });
  };

  const writeViaTemporaryCopy = async (): Promise<void> => {
    const extension = path.extname(fullPath);
    const temporaryWritePath = path.join(
      path.dirname(fullPath),
      `${path.basename(fullPath, extension)}.exiftool-write-fallback-${randomUUID()}${extension}`,
    );

    await fs.copyFile(fullPath, temporaryWritePath);
    try {
      await exiftool.write(temporaryWritePath, payload as any, writeArgs);
      await fs.copyFile(temporaryWritePath, fullPath);
      await cleanupExiftoolTempFile();
    } finally {
      await fs.unlink(temporaryWritePath).catch(() => undefined);
    }
  };

  await cleanupExiftoolTempFile();

  try {
    await exiftool.write(fullPath, payload as any, writeArgs);
    await cleanupExiftoolTempFile();
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/for writing|for update/i.test(message)) {
      await writeViaTemporaryCopy();
      return;
    }

    if (!/XMP format error|no closing tag for x:xmpmeta/i.test(message)) {
      throw err;
    }
  }

  const extension = path.extname(fullPath);
  const repairPath = path.join(
    path.dirname(fullPath),
    `${path.basename(fullPath, extension)}.exiftool-xmp-repair-${randomUUID()}${extension}`,
  );

  await fs.copyFile(fullPath, repairPath);
  try {
    // The malformed packet cannot be safely amended. Remove it from a copy,
    // then let ExifTool create valid XMP containing the requested tags.
    await exiftool.write(
      repairPath,
      { "XMP:All": null } as any,
      writeArgs,
    );
    await exiftool.write(repairPath, payload as any, writeArgs);
    await fs.copyFile(repairPath, fullPath);
    await cleanupExiftoolTempFile();
  } finally {
    await fs.unlink(repairPath).catch(() => undefined);
  }
};

const writeTagsToFile = async (
  fullPath: string,
  extension: string,
  tags: string[],
  options?: { comment?: string },
) => {
  const isGif = extension === ".gif";
  const mediaDescriptor = mediaByExt[extension];
  const isVideo = mediaDescriptor?.kind === "video";

  if (isGif) {
    await writeMetadataWithXmpRepair(
      fullPath,
      {
        Comment: options?.comment ?? tags.join(", "),
      },
    );
    return;
  }

  const payload: Record<string, unknown> = {
    Keywords: tags,
    Subject: tags,
  };
  if (isVideo && typeof options?.comment !== "string") {
    payload.Comment = tags.join(", ");
  }
  if (typeof options?.comment === "string") {
    payload.Comment = options.comment;
  }

  await writeMetadataWithXmpRepair(fullPath, payload);
};

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/api/root/select", async (_req: Request, res: Response) => {
  const requestLabel = createRequestLabel("root-picker");
  const startTime = Date.now();

  try {
    logProgress(requestLabel, "Opening native folder dialog");
    const selectedRootPath = await selectRootFolderFromDialog();

    if (!selectedRootPath) {
      const durationMs = Date.now() - startTime;
      logProgress(
        requestLabel,
        `Folder selection cancelled after ${durationMs}ms`,
      );
      res.json({ cancelled: true });
      return;
    }

    const durationMs = Date.now() - startTime;
    logProgress(
      requestLabel,
      `Selected root folder '${selectedRootPath}' in ${durationMs}ms`,
    );
    res.json({ root: selectedRootPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    logProgress(
      requestLabel,
      `Failed to open folder dialog after ${durationMs}ms: ${message}`,
    );
    res.status(500).json({
      error: "Failed to choose root folder",
      details: message,
    });
  }
});

app.post("/api/root/forget", (req: Request<unknown, unknown, ForgetRootBody>, res: Response) => {
  const requestLabel = createRequestLabel("root-forget");

  try {
    const rootDirectoryPath = resolveRootDirectoryPath(
      typeof req.body?.root === "string" ? req.body.root : null,
    );

    const { clearedIndexes, clearedBuilds, clearedProgress } =
      clearMediaIndexCacheForRoot(rootDirectoryPath);

    logProgress(
      requestLabel,
      `Cleared media index cache for forgotten root '${rootDirectoryPath}'. indexes=${clearedIndexes}, pendingBuilds=${clearedBuilds}, progressEntries=${clearedProgress}`,
    );

    res.json({
      ok: true,
      root: rootDirectoryPath,
      clearedIndexes,
      clearedBuilds,
      clearedProgress,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logProgress(requestLabel, `Failed clearing forgotten root cache: ${message}`);
    res.status(500).json({
      error: "Failed to clear forgotten root cache",
      details: message,
    });
  }
});

app.get("/api/folders", async (req: Request, res: Response) => {
  const requestLabel = createRequestLabel("folders");
  const startTime = Date.now();

  try {
    const rootDirectoryPath = resolveRootDirectoryPath(
      typeof req.query.root === "string" ? req.query.root : null,
    );
    logProgress(
      requestLabel,
      `Started root folder scan at '${rootDirectoryPath}'`,
    );

    const rootFolder = await buildFolderTree(
      rootDirectoryPath,
      rootDirectoryPath,
    );

    const folderCount = countFolderTreeNodes(rootFolder);
    const durationMs = Date.now() - startTime;
    logProgress(
      requestLabel,
      `Completed root folder scan. folders=${folderCount}, elapsedMs=${durationMs}`,
    );

    res.json({ root: rootFolder });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    logProgress(
      requestLabel,
      `Failed root folder scan after ${durationMs}ms: ${message}`,
    );
    res.status(500).json({
      error: "Failed to read folder structure from selected root folder",
      details: message,
    });
  }
});

app.get("/api/media", async (req: Request, res: Response) => {
  const requestLabel = createRequestLabel("media");
  const startTime = Date.now();

  try {
    const rootDirectoryPath = resolveRootDirectoryPath(
      typeof req.query.root === "string" ? req.query.root : null,
    );
    const folderParam =
      typeof req.query.folder === "string" ? req.query.folder.trim() : "";
    const shouldLoadRecursively = req.query.recursive === "true";
    const selectedFolderPath = shouldLoadRecursively
      ? rootDirectoryPath
      : resolveMediaFolderPath(folderParam, rootDirectoryPath);

    if (!selectedFolderPath) {
      res.status(400).json({ error: "Invalid folder path" });
      return;
    }

    logProgress(
      requestLabel,
      `Started media query. root='${rootDirectoryPath}', folder='${selectedFolderPath}', recursive=${shouldLoadRecursively}`,
    );

    const page = Number.parseInt(
      typeof req.query.page === "string" ? req.query.page : "1",
      10,
    );
    const requestedLimit = Number.parseInt(
      typeof req.query.limit === "string" ? req.query.limit : "50",
      10,
    );
    const allowedLimits = new Set([15, 30, 50, 75, 100]);
    const limit = allowedLimits.has(requestedLimit) ? requestedLimit : 50;
    const safePage = Number.isFinite(page) && page > 0 ? page : 1;

    const requestedContentTypes: ContentType[] =
      typeof req.query.contentTypes === "string"
        ? req.query.contentTypes
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(
              (value): value is ContentType =>
                value === "image" || value === "video" || value === "gif",
            )
        : ["image", "video", "gif"];
    const allowedContentTypes = new Set<ContentType>(requestedContentTypes);
    const showOnlyUntaggedMedia = req.query.showOnlyUntagged === "true";
    const showOnlyTaggedMedia = req.query.showOnlyTagged === "true";
    const testModeLimit = resolveTestModeLimit();
    const useTagFilters = req.query.useTagFilters === "true";
    const requestedTags =
      typeof req.query.tags === "string"
        ? req.query.tags
            .split(",")
            .map((tag) => normalizeTagToken(tag))
            .filter(Boolean)
        : [];
    const tagFilterMode: TagFilterMode = req.query.filterMode === "AND" ? "AND" : "OR";

    const indexCacheKey = createMediaIndexCacheKey(rootDirectoryPath, {
      maxSupportedFiles: testModeLimit,
    });

    const progressState = mediaIndexProgressByCacheKey.get(indexCacheKey);
    const indexIsReady = mediaIndexByCacheKey.has(indexCacheKey);
    const indexIsRunning = Boolean(
      mediaIndexBuildsByCacheKey.has(indexCacheKey) ||
        (progressState &&
          (progressState.status === "enumerating" ||
            progressState.status === "indexing")),
    );

    if (!indexIsReady && indexIsRunning) {
      const activeProgress = progressState ?? {
        status: "enumerating" as const,
        scannedFiles: 0,
        totalFiles: 0,
        indexedFiles: 0,
        startedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };

      res.status(202).json({
        ok: true,
        indexing: true,
        progress: serializeMediaIndexProgress(activeProgress),
        images: [],
        count: 0,
        totalCount: 0,
        page: safePage,
        limit,
        availableTags: [],
        taggedCount: 0,
        untaggedCount: 0,
      });
      return;
    }

    if (!indexIsReady && progressState?.status === "error") {
      res.status(500).json({
        error: "Failed to build media index",
        details: progressState.error ?? "Unknown indexing error",
        progress: serializeMediaIndexProgress(progressState),
      });
      return;
    }

    if (!indexIsReady && !mediaIndexBuildsByCacheKey.has(indexCacheKey)) {
      void ensureMediaIndex(rootDirectoryPath, requestLabel, {
        maxSupportedFiles: testModeLimit,
      }).catch(() => undefined);

      const initialProgress = mediaIndexProgressByCacheKey.get(indexCacheKey) ?? {
        status: "enumerating" as const,
        scannedFiles: 0,
        totalFiles: 0,
        indexedFiles: 0,
        startedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };

      res.status(202).json({
        ok: true,
        indexing: true,
        progress: serializeMediaIndexProgress(initialProgress),
        images: [],
        count: 0,
        totalCount: 0,
        page: safePage,
        limit,
        availableTags: [],
        taggedCount: 0,
        untaggedCount: 0,
      });
      return;
    }

    const mediaIndex = await ensureMediaIndex(rootDirectoryPath, requestLabel, {
      maxSupportedFiles: testModeLimit,
    });
    const mediaInFolder = getMediaForSelectedFolder(
      mediaIndex,
      rootDirectoryPath,
      selectedFolderPath,
      shouldLoadRecursively,
    );

    const mediaAfterContentTypeFilters = mediaInFolder.filter((entry) =>
      allowedContentTypes.has(classifyMediaContentType(entry)),
    );

    const mediaAfterBaseFilters = mediaAfterContentTypeFilters.filter(
      (entry) => {
        if (showOnlyUntaggedMedia) {
          return entry.tags.length === 0;
        }

        if (showOnlyTaggedMedia) {
          return entry.tags.length > 0;
        }

        return true;
      },
    );

    const filteredMedia = mediaAfterBaseFilters
      .filter((entry) => {

        if (useTagFilters && requestedTags.length > 0) {
          return tagFilterMode === "AND"
            ? requestedTags.every((tag) => entry.tags.includes(tag))
            : requestedTags.some((tag) => entry.tags.includes(tag));
        }

        return true;
      });

    const tagCounts = new Map<string, number>();
    mediaAfterContentTypeFilters.forEach((entry) => {
      entry.tags.forEach((tag) => {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      });
    });
    const availableTags = Array.from(tagCounts.entries())
      .map(([name, occurenceCount]) => ({ name, occurenceCount }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const taggedCount = mediaAfterContentTypeFilters.filter(
      (entry) => entry.tags.length > 0,
    ).length;
    const untaggedCount = mediaAfterContentTypeFilters.length - taggedCount;

    const totalCount = filteredMedia.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const adjustedPage = Math.min(safePage, totalPages);
    const startIndex = (adjustedPage - 1) * limit;
    const paginatedMedia = filteredMedia.slice(startIndex, startIndex + limit);

    res.json({
      count: paginatedMedia.length,
      totalCount,
      page: adjustedPage,
      limit,
      images: paginatedMedia,
      availableTags,
      taggedCount,
      untaggedCount,
      testMode: isTestModeEnabled,
      maxSupportedFiles: mediaIndex.maxSupportedFiles ?? null,
    });

    const durationMs = Date.now() - startTime;
    logProgress(
      requestLabel,
      `Completed media query. indexed=${mediaIndex.sortedMedia.length}, folderMatches=${mediaInFolder.length}, returned=${paginatedMedia.length}, total=${totalCount}, elapsedMs=${durationMs}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    logProgress(
      requestLabel,
      `Failed media scan after ${durationMs}ms: ${message}`,
    );
    res.status(500).json({
      error: "Failed to read media",
      details: message,
    });
  }
});

app.get(
  "/api/media/:fileName/stream",
  async (req: Request<ImageTagRouteParams>, res: Response) => {
    try {
      const fileName = decodeURIComponent(req.params.fileName || "").trim();
      const rootDirectoryPath = resolveRootDirectoryPath(
        typeof req.query.root === "string" ? req.query.root : null,
      );

      const fullPath = resolveMediaFilePath(fileName, rootDirectoryPath);
      if (!fullPath) {
        res.status(400).json({ error: "Invalid fileName" });
        return;
      }

      const descriptorResult = getMediaDescriptor(fileName);
      if (!descriptorResult) {
        res.status(400).json({ error: "Unsupported file type" });
        return;
      }

      const { descriptor } = descriptorResult;
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const totalSize = stat.size;
      const rangeHeader = req.headers.range;

      if (rangeHeader) {
        const rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (!rangeMatch) {
          res
            .status(416)
            .setHeader("Content-Range", `bytes */${totalSize}`)
            .end();
          return;
        }

        const start = rangeMatch[1] ? Number.parseInt(rangeMatch[1], 10) : 0;
        const end = rangeMatch[2]
          ? Number.parseInt(rangeMatch[2], 10)
          : totalSize - 1;

        if (
          Number.isNaN(start) ||
          Number.isNaN(end) ||
          start < 0 ||
          end < start ||
          end >= totalSize
        ) {
          res
            .status(416)
            .setHeader("Content-Range", `bytes */${totalSize}`)
            .end();
          return;
        }

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${totalSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Type": descriptor.mimeType,
        });

        createReadStream(fullPath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        "Content-Length": totalSize,
        "Content-Type": descriptor.mimeType,
        "Accept-Ranges": "bytes",
      });

      createReadStream(fullPath).pipe(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .json({ error: "Failed to stream media file", details: message });
    }
  },
);

app.post(
  "/api/media/:fileName/tags",
  async (
    req: Request<ImageTagRouteParams, unknown, AddImageTagBody>,
    res: Response,
  ) => {
    try {
      const fileName = decodeURIComponent(req.params.fileName || "").trim();
      const tagName = (req.body.tag || "").trim();
      const rootDirectoryPath = resolveRootDirectoryPath(
        typeof req.query.root === "string" ? req.query.root : null,
      );

      if (!fileName || !tagName) {
        res.status(400).json({ error: "fileName and tag are required" });
        return;
      }

      // Prevent path traversal by requiring a bare filename within the selected root.
      const fullPath = resolveMediaFilePath(fileName, rootDirectoryPath);
      if (!fullPath) {
        res.status(400).json({ error: "Invalid fileName" });
        return;
      }

      const descriptorResult = getMediaDescriptor(fileName);
      if (!descriptorResult) {
        res.status(400).json({ error: "Unsupported file type" });
        return;
      }

      const stat = await statMediaFileForMetadataUpdate(fullPath);
      if (stat && !stat.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const metadata = await exiftool.read(fullPath);
      const existingTags = getTagsFromMetadata(metadata);
      const writableMediaFile = await prepareWritableMediaFile(
        fullPath,
        metadata,
      );

      if (existingTags.includes(tagName)) {
        updateCachedMediaTags(rootDirectoryPath, fileName, existingTags);
        res.json({ ok: true, tags: existingTags });
        return;
      }

      const updatedTags = [...existingTags, tagName];
      let didPersistUpdatedMedia = false;

      try {
        await writeTagsToFile(
          writableMediaFile.path,
          path.extname(writableMediaFile.path).toLowerCase(),
          updatedTags,
        );

        if (writableMediaFile.isTemporary) {
          await fs.copyFile(writableMediaFile.path, fullPath);
        }

        didPersistUpdatedMedia = true;
      } finally {
        if (writableMediaFile.isTemporary && didPersistUpdatedMedia) {
          await fs.unlink(writableMediaFile.path).catch(() => undefined);
        }
      }

      updateCachedMediaTags(rootDirectoryPath, fileName, updatedTags);

      res.json({ ok: true, tags: updatedTags });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .json({ error: "Failed to add tag to image", details: message });
    }
  },
);

app.delete(
  "/api/media/:fileName",
  async (req: Request<ImageTagRouteParams>, res: Response) => {
    try {
      const fileName = decodeURIComponent(req.params.fileName || "").trim();
      const rootDirectoryPath = resolveRootDirectoryPath(
        typeof req.query.root === "string" ? req.query.root : null,
      );

      if (!fileName) {
        res.status(400).json({ error: "fileName is required" });
        return;
      }

      const fullPath = resolveMediaFilePath(fileName, rootDirectoryPath);
      if (!fullPath) {
        res.status(400).json({ error: "Invalid fileName" });
        return;
      }

      const descriptorResult = getMediaDescriptor(fileName);
      if (!descriptorResult) {
        res.status(400).json({ error: "Unsupported file type" });
        return;
      }

      const stat = await fs.stat(fullPath).catch((err) => {
        const errorCode = (err as NodeJS.ErrnoException).code;
        if (errorCode === "ENOENT") {
          return null;
        }

        throw err;
      });

      if (!stat || !stat.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      await fs.unlink(fullPath);
      removeCachedMediaEntry(rootDirectoryPath, fileName);

      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .json({ error: "Failed to delete media file", details: message });
    }
  },
);

app.delete(
  "/api/media/:fileName/tags/:tagName",
  async (req: Request<DeleteImageTagRouteParams>, res: Response) => {
    try {
      const fileName = decodeURIComponent(req.params.fileName || "").trim();
      const tagName = decodeURIComponent(req.params.tagName || "").trim();
      const rootDirectoryPath = resolveRootDirectoryPath(
        typeof req.query.root === "string" ? req.query.root : null,
      );

      if (!fileName || !tagName) {
        res.status(400).json({ error: "fileName and tagName are required" });
        return;
      }

      const fullPath = resolveMediaFilePath(fileName, rootDirectoryPath);
      if (!fullPath) {
        res.status(400).json({ error: "Invalid fileName" });
        return;
      }

      const descriptorResult = getMediaDescriptor(fileName);
      if (!descriptorResult) {
        res.status(400).json({ error: "Unsupported file type" });
        return;
      }

      const { extension } = descriptorResult;

      const stat = await statMediaFileForMetadataUpdate(fullPath);
      if (stat && !stat.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const metadata = await exiftool.read(fullPath);
      const existingTags = getTagsFromMetadata(metadata);
      const writableMediaFile = await prepareWritableMediaFile(
        fullPath,
        metadata,
      );

      if (!existingTags.includes(tagName)) {
        updateCachedMediaTags(rootDirectoryPath, fileName, existingTags);
        res.json({ ok: true, tags: existingTags });
        return;
      }

      const updatedTags = existingTags.filter((tag) => tag !== tagName);
      const commentValue =
        typeof metadata.Comment === "string" ? metadata.Comment : "";
      const commentUpdate = removeTagFromComment(commentValue, tagName);
      let didPersistUpdatedMedia = false;
      try {
        await writeTagsToFile(
          writableMediaFile.path,
          path.extname(writableMediaFile.path).toLowerCase(),
          updatedTags,
          commentUpdate.changed ? { comment: commentUpdate.value } : undefined,
        );

        if (writableMediaFile.isTemporary) {
          await fs.copyFile(writableMediaFile.path, fullPath);
        }

        didPersistUpdatedMedia = true;
      } finally {
        if (writableMediaFile.isTemporary && didPersistUpdatedMedia) {
          await fs.unlink(writableMediaFile.path).catch(() => undefined);
        }
      }

      updateCachedMediaTags(rootDirectoryPath, fileName, updatedTags);

      res.json({ ok: true, tags: updatedTags });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .json({ error: "Failed to delete tag from image", details: message });
    }
  },
);

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

export default app;
