import { execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs, type Stats } from "fs";
import { exiftool } from "exiftool-vendored";
import ffmpegPath from "ffmpeg-static";
import path from "path";
import {
  isTestModeEnabled,
  mediaByExt,
  testDirPath,
  testModeMaxSupportedFiles,
} from "./constants";
import type {
  CachedMediaEntry,
  ContentType,
  FolderNode,
  MediaFile,
  MediaIndex,
  MediaIndexOptions,
  MediaIndexProgress,
  MediaIndexProgressResponse,
  MediaResult,
} from "./types";

export const logProgress = (label: string, message: string): void => {
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

export const selectRootFolderFromDialog = async (): Promise<string | null> => {
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
$dialog.SelectedPath = "C:\\Pics"

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

export const normalizeRootCacheKey = (rootDirectoryPath: string): string => {
  const normalizedRoot = path
    .normalize(rootDirectoryPath)
    .replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
};

export const resolveRootDirectoryPath = (
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

  const testDirName = path.basename(testDirPath).toLowerCase();
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

export const getMediaDescriptor = (fileName: string) => {
  const extension = path.extname(fileName).toLowerCase();
  const descriptor = mediaByExt[extension];
  return descriptor ? { extension, descriptor } : null;
};

export const classifyMediaContentType = (
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

export const toRelativeFolderPath = (
  rootDirectoryPath: string,
  selectedFolderPath: string,
): string => {
  const relativePath = path
    .relative(rootDirectoryPath, selectedFolderPath)
    .replace(/\\/g, "/");
  return relativePath === "." ? "" : relativePath;
};

export const getParentRelativePath = (relativePath: string): string => {
  const lastSeparatorIndex = relativePath.lastIndexOf("/");
  return lastSeparatorIndex === -1
    ? ""
    : relativePath.slice(0, lastSeparatorIndex);
};

export const createMediaStreamUrl = (
  relativePath: string,
  rootDirectoryPath: string,
): string => {
  const streamParams = new URLSearchParams();
  streamParams.set("root", rootDirectoryPath);
  return `/api/media/${encodeURIComponent(relativePath)}/stream?${streamParams.toString()}`;
};

export const resolveTestModeLimit = (): number | undefined =>
  isTestModeEnabled ? testModeMaxSupportedFiles : undefined;

export const createMediaIndexCacheKey = (
  rootDirectoryPath: string,
  options?: MediaIndexOptions,
): string => {
  const modeSuffix = options?.maxSupportedFiles
    ? `test:${options.maxSupportedFiles}`
    : "full";
  return `${normalizeRootCacheKey(rootDirectoryPath)}::${modeSuffix}`;
};

export const getMediaForSelectedFolder = (
  index: MediaIndex,
  rootDirectoryPath: string,
  selectedFolderPath: string,
  recursive: boolean,
): CachedMediaEntry[] => {
  const selectedFolderRelativePath = toRelativeFolderPath(
    rootDirectoryPath,
    selectedFolderPath,
  );

  if (recursive) {
    if (!selectedFolderRelativePath) {
      return index.sortedMedia;
    }

    const selectedFolderPrefix = `${selectedFolderRelativePath}/`;
    return index.sortedMedia.filter((entry) =>
      entry.name.startsWith(selectedFolderPrefix),
    );
  }

  return index.sortedMedia.filter(
    (entry) => getParentRelativePath(entry.name) === selectedFolderRelativePath,
  );
};

export const resolveMediaFilePath = (
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

const spawnDetachedProcess = async (
  command: string,
  args: string[],
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};

export const openMediaFileWithDefaultApplication = async (
  fullPath: string,
): Promise<void> => {
  const command =
    process.platform === "win32"
      ? "explorer.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";

  await spawnDetachedProcess(command, [fullPath]);
};

export const revealMediaFileInFileManager = async (
  fullPath: string,
): Promise<void> => {
  const command =
    process.platform === "win32"
      ? "explorer.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? [`/select,${fullPath}`]
      : process.platform === "darwin"
        ? ["-R", fullPath]
        : [path.dirname(fullPath)];

  await spawnDetachedProcess(command, args);
};

export const statMediaFileForMetadataUpdate = async (
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

export const statMediaFile = async (
  fullPath: string,
): Promise<Stats | null> =>
  fs.stat(fullPath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw err;
  });

const normalizeFileTypeExtension = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/^\./, "");
  return normalized || null;
};

export const prepareWritableMediaFile = async (
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

export const walkMediaFilesInFolder = async (
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

export const resolveMediaFolderPath = (
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

export const buildFolderTree = async (
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

export const countFolderTreeNodes = (node: FolderNode): number =>
  1 +
  node.children.reduce(
    (count, child) => count + countFolderTreeNodes(child),
    0,
  );

export const normalizeTagToken = (value: unknown): string => {
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

export const removeTagFromComment = (
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

export const getTagsFromMetadata = (
  metadata: Awaited<ReturnType<typeof exiftool.read>>,
): string[] => {
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
    await exiftool.write(repairPath, { "XMP:All": null } as any, writeArgs);
    await exiftool.write(repairPath, payload as any, writeArgs);
    await fs.copyFile(repairPath, fullPath);
    await cleanupExiftoolTempFile();
  } finally {
    await fs.unlink(repairPath).catch(() => undefined);
  }
};

const writeWebmTagsToFile = async (
  fullPath: string,
  tags: string[],
  comment: string,
): Promise<void> => {
  if (!ffmpegPath) {
    throw new Error("The bundled FFmpeg executable is unavailable.");
  }

  const executablePath = ffmpegPath;
  const extension = path.extname(fullPath);
  const temporaryWritePath = path.join(
    path.dirname(fullPath),
    `${path.basename(fullPath, extension)}.ffmpeg-write-${randomUUID()}${extension}`,
  );

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        executablePath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          fullPath,
          "-map",
          "0",
          "-c",
          "copy",
          "-map_metadata",
          "0",
          "-metadata",
          `keywords=${tags.join(", ")}`,
          "-metadata",
          `comment=${comment}`,
          "-y",
          temporaryWritePath,
        ],
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(stderr?.trim() || error.message));
            return;
          }

          resolve();
        },
      );
    });

    await fs.copyFile(temporaryWritePath, fullPath);
  } finally {
    await fs.unlink(temporaryWritePath).catch(() => undefined);
  }
};

export const writeTagsToFile = async (
  fullPath: string,
  extension: string,
  tags: string[],
  options?: { comment?: string },
): Promise<void> => {
  const isGif = extension === ".gif";
  const mediaDescriptor = mediaByExt[extension];
  const isVideo = mediaDescriptor?.kind === "video";

  if (extension === ".webm") {
    await writeWebmTagsToFile(
      fullPath,
      tags,
      options?.comment ?? tags.join(", "),
    );
    return;
  }

  if (isGif) {
    await writeMetadataWithXmpRepair(fullPath, {
      Comment: options?.comment ?? tags.join(", "),
    });
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
