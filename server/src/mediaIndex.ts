import { exiftool } from "exiftool-vendored";
import { scanProgressInterval } from "./constants";
import {
  createMediaIndexCacheKey,
  createMediaStreamUrl,
  getMediaDescriptor,
  getTagsFromMetadata,
  logProgress,
  normalizeRootCacheKey,
  normalizeTagToken,
  walkMediaFilesInFolder,
} from "./helpers.js";
import type {
  CachedMediaEntry,
  MediaIndex,
  MediaIndexOptions,
  MediaIndexProgress,
} from "./types";

const mediaIndexByCacheKey = new Map<string, MediaIndex>();
const mediaIndexBuildsByCacheKey = new Map<string, Promise<MediaIndex>>();
const mediaIndexProgressByCacheKey = new Map<string, MediaIndexProgress>();

const setMediaIndexProgress = (
  indexCacheKey: string,
  status: MediaIndexProgress["status"],
  scannedFiles: number,
  totalFiles: number,
  indexedFiles: number,
  startedAtMs: number,
): void => {
  mediaIndexProgressByCacheKey.set(indexCacheKey, {
    status,
    scannedFiles,
    totalFiles,
    indexedFiles,
    startedAtMs,
    updatedAtMs: Date.now(),
  });
};

const buildMediaIndex = async (
  rootDirectoryPath: string,
  requestLabel: string,
  indexCacheKey: string,
  options?: MediaIndexOptions,
): Promise<MediaIndex> => {
  const startedAtMs = Date.now();
  setMediaIndexProgress(indexCacheKey, "enumerating", 0, 0, 0, startedAtMs);

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

  setMediaIndexProgress(
    indexCacheKey,
    "indexing",
    0,
    mediaFiles.length,
    0,
    startedAtMs,
  );

  let scannedFiles = 0;
  let supportedFiles = 0;

  logProgress(
    requestLabel,
    `Building media index. discoveredFiles=${mediaFiles.length}`,
  );

  for (const mediaFile of mediaFiles) {
    scannedFiles += 1;

    const descriptorResult = getMediaDescriptor(mediaFile.relativePath);
    if (!descriptorResult) {
      setMediaIndexProgress(
        indexCacheKey,
        "indexing",
        scannedFiles,
        mediaFiles.length,
        supportedFiles,
        startedAtMs,
      );

      if (scannedFiles % scanProgressInterval === 0) {
        logProgress(
          requestLabel,
          `Index progress: scanned=${scannedFiles}/${mediaFiles.length}, supported=${supportedFiles}`,
        );
      }
      continue;
    }

    if (
      typeof maxSupportedFiles === "number" &&
      supportedFiles >= maxSupportedFiles
    ) {
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
      mimeType: descriptorResult.descriptor.mimeType,
      kind: descriptorResult.descriptor.kind,
      sizeBytes: mediaFile.sizeBytes,
      streamUrl: createMediaStreamUrl(
        mediaFile.relativePath,
        rootDirectoryPath,
      ),
      tags,
    };

    mediaByRelativePath.set(mediaFile.relativePath, indexedEntry);
    sortedMedia.push(indexedEntry);
    setMediaIndexProgress(
      indexCacheKey,
      "indexing",
      scannedFiles,
      mediaFiles.length,
      supportedFiles,
      startedAtMs,
    );

    if (scannedFiles % scanProgressInterval === 0) {
      logProgress(
        requestLabel,
        `Index progress: scanned=${scannedFiles}/${mediaFiles.length}, supported=${supportedFiles}, indexed=${sortedMedia.length}`,
      );
    }
  }

  sortedMedia.sort((left, right) => left.name.localeCompare(right.name));
  setMediaIndexProgress(
    indexCacheKey,
    "complete",
    scannedFiles,
    mediaFiles.length,
    supportedFiles,
    startedAtMs,
  );

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

export const ensureMediaIndex = async (
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
    { maxSupportedFiles: options?.maxSupportedFiles },
  )
    .then((index) => {
      mediaIndexByCacheKey.set(indexCacheKey, index);
      return index;
    })
    .catch((err: unknown) => {
      const previousProgress = mediaIndexProgressByCacheKey.get(indexCacheKey);
      mediaIndexProgressByCacheKey.set(indexCacheKey, {
        status: "error",
        scannedFiles: previousProgress?.scannedFiles ?? 0,
        totalFiles: previousProgress?.totalFiles ?? 0,
        indexedFiles: previousProgress?.indexedFiles ?? 0,
        startedAtMs: previousProgress?.startedAtMs ?? Date.now(),
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

const clearMapByKeyPrefix = <Value>(
  map: Map<string, Value>,
  keyPrefix: string,
): number => {
  let clearedEntries = 0;
  map.forEach((_value, key) => {
    if (key.startsWith(keyPrefix)) {
      map.delete(key);
      clearedEntries += 1;
    }
  });
  return clearedEntries;
};

export const clearMediaIndexCacheForRoot = (rootDirectoryPath: string) => {
  const cacheKeyPrefix = `${normalizeRootCacheKey(rootDirectoryPath)}::`;
  return {
    clearedIndexes: clearMapByKeyPrefix(mediaIndexByCacheKey, cacheKeyPrefix),
    clearedBuilds: clearMapByKeyPrefix(
      mediaIndexBuildsByCacheKey,
      cacheKeyPrefix,
    ),
    clearedProgress: clearMapByKeyPrefix(
      mediaIndexProgressByCacheKey,
      cacheKeyPrefix,
    ),
  };
};

export const updateCachedMediaTags = (
  rootDirectoryPath: string,
  relativePath: string,
  tags: string[],
): void => {
  const normalizedTags = Array.from(
    new Set(tags.map((tag) => normalizeTagToken(tag))),
  ).filter(Boolean);

  mediaIndexByCacheKey.forEach((index) => {
    if (index.rootDirectoryPath === rootDirectoryPath) {
      const entry = index.mediaByRelativePath.get(relativePath);
      if (entry) {
        entry.tags = normalizedTags;
      }
    }
  });
};

export const removeCachedMediaEntry = (
  rootDirectoryPath: string,
  relativePath: string,
): void => {
  mediaIndexByCacheKey.forEach((index) => {
    if (
      index.rootDirectoryPath === rootDirectoryPath &&
      index.mediaByRelativePath.delete(relativePath)
    ) {
      index.sortedMedia = index.sortedMedia.filter(
        (entry) => entry.name !== relativePath,
      );
    }
  });
};

export const getMediaIndexProgress = (
  indexCacheKey: string,
): MediaIndexProgress | undefined =>
  mediaIndexProgressByCacheKey.get(indexCacheKey);

export const isMediaIndexReady = (indexCacheKey: string): boolean =>
  mediaIndexByCacheKey.has(indexCacheKey);

export const isMediaIndexBuildPending = (indexCacheKey: string): boolean =>
  mediaIndexBuildsByCacheKey.has(indexCacheKey);
