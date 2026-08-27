import cors from "cors";
import express, { Request, Response } from "express";
import { createReadStream, promises as fs } from "fs";
import { exiftool } from "exiftool-vendored";
import path from "path";
import { isTestModeEnabled, port } from "./constants";
import type {
  AddImageTagBody,
  ContentType,
  DeleteImageTagRouteParams,
  ForgetRootBody,
  ImageTagRouteParams,
  ResolvedMediaFile,
  TagFilterMode,
} from "./types";
import {
  classifyMediaContentType,
  createMediaIndexCacheKey,
  buildFolderTree,
  countFolderTreeNodes,
  getMediaForSelectedFolder,
  getMediaDescriptor,
  getTagsFromMetadata,
  normalizeTagToken,
  openMediaFileWithDefaultApplication,
  prepareWritableMediaFile,
  removeTagFromComment,
  resolveMediaFilePath,
  resolveMediaFolderPath,
  resolveRootDirectoryPath,
  resolveTestModeLimit,
  revealMediaFileInFileManager,
  selectRootFolderFromDialog,
  serializeMediaIndexProgress,
  statMediaFile,
  statMediaFileForMetadataUpdate,
  walkMediaFilesInFolder,
  writeTagsToFile,
  logProgress,
} from "./helpers.js";
import {
  clearMediaIndexCacheForRoot,
  ensureMediaIndex,
  getMediaIndexProgress,
  isMediaIndexBuildPending,
  isMediaIndexReady,
  removeCachedMediaEntry,
  updateCachedMediaTags,
} from "./mediaIndex.js";

const app = express();
let requestSequence = 0;

const createRequestLabel = (scope: string): string => {
  requestSequence += 1;
  return `${scope}#${requestSequence}`;
};

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

const resolveMediaRouteFile = (
  req: Request<ImageTagRouteParams>,
  res: Response,
): ResolvedMediaFile | null => {
  const fileName = decodeURIComponent(req.params.fileName || "").trim();
  if (!fileName) {
    res.status(400).json({ error: "fileName is required" });
    return null;
  }

  const rootDirectoryPath = resolveRootDirectoryPath(
    typeof req.query.root === "string" ? req.query.root : null,
  );
  const fullPath = resolveMediaFilePath(fileName, rootDirectoryPath);
  if (!fullPath) {
    res.status(400).json({ error: "Invalid fileName" });
    return null;
  }

  const descriptorResult = getMediaDescriptor(fileName);
  if (!descriptorResult) {
    res.status(400).json({ error: "Unsupported file type" });
    return null;
  }

  return {
    fileName,
    rootDirectoryPath,
    fullPath,
    ...descriptorResult,
  };
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

app.post(
  "/api/root/forget",
  (req: Request<unknown, unknown, ForgetRootBody>, res: Response) => {
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
      logProgress(
        requestLabel,
        `Failed clearing forgotten root cache: ${message}`,
      );
      res.status(500).json({
        error: "Failed to clear forgotten root cache",
        details: message,
      });
    }
  },
);

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
    const tagFilterMode: TagFilterMode =
      req.query.filterMode === "AND" ? "AND" : "OR";

    const indexCacheKey = createMediaIndexCacheKey(rootDirectoryPath, {
      maxSupportedFiles: testModeLimit,
    });

    const progressState = getMediaIndexProgress(indexCacheKey);
    const indexIsReady = isMediaIndexReady(indexCacheKey);
    const indexIsRunning = Boolean(
      isMediaIndexBuildPending(indexCacheKey) ||
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

    if (!indexIsReady && !isMediaIndexBuildPending(indexCacheKey)) {
      void ensureMediaIndex(rootDirectoryPath, requestLabel, {
        maxSupportedFiles: testModeLimit,
      }).catch(() => undefined);

      const initialProgress = getMediaIndexProgress(indexCacheKey) ?? {
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

    const filteredMedia = mediaAfterBaseFilters.filter((entry) => {
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
      const mediaFile = resolveMediaRouteFile(req, res);
      if (!mediaFile) {
        return;
      }

      const stat = await statMediaFile(mediaFile.fullPath);
      if (!stat?.isFile()) {
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
          "Content-Type": mediaFile.descriptor.mimeType,
        });

        createReadStream(mediaFile.fullPath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        "Content-Length": totalSize,
        "Content-Type": mediaFile.descriptor.mimeType,
        "Accept-Ranges": "bytes",
      });

      createReadStream(mediaFile.fullPath).pipe(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .json({ error: "Failed to stream media file", details: message });
    }
  },
);

app.post(
  "/api/media/:fileName/open",
  async (req: Request<ImageTagRouteParams>, res: Response) => {
    try {
      const mediaFile = resolveMediaRouteFile(req, res);
      if (!mediaFile) {
        return;
      }

      const stat = await statMediaFile(mediaFile.fullPath);
      if (!stat?.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      await openMediaFileWithDefaultApplication(mediaFile.fullPath);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: "Failed to open media file",
        details: message,
      });
    }
  },
);

app.post(
  "/api/media/:fileName/reveal",
  async (req: Request<ImageTagRouteParams>, res: Response) => {
    try {
      const mediaFile = resolveMediaRouteFile(req, res);
      if (!mediaFile) {
        return;
      }

      const stat = await statMediaFile(mediaFile.fullPath);
      if (!stat?.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      await revealMediaFileInFileManager(mediaFile.fullPath);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: "Failed to reveal media file",
        details: message,
      });
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
      const tagName = (req.body.tag || "").trim();
      if (!tagName) {
        res.status(400).json({ error: "tag is required" });
        return;
      }

      const mediaFile = resolveMediaRouteFile(req, res);
      if (!mediaFile) {
        return;
      }

      const stat = await statMediaFileForMetadataUpdate(mediaFile.fullPath);
      if (stat && !stat.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const metadata = await exiftool.read(mediaFile.fullPath);
      const existingTags = getTagsFromMetadata(metadata);
      const writableMediaFile = await prepareWritableMediaFile(
        mediaFile.fullPath,
        metadata,
      );

      if (existingTags.includes(tagName)) {
        updateCachedMediaTags(
          mediaFile.rootDirectoryPath,
          mediaFile.fileName,
          existingTags,
        );
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
          await fs.copyFile(writableMediaFile.path, mediaFile.fullPath);
        }

        didPersistUpdatedMedia = true;
      } finally {
        if (writableMediaFile.isTemporary && didPersistUpdatedMedia) {
          await fs.unlink(writableMediaFile.path).catch(() => undefined);
        }
      }

      updateCachedMediaTags(
        mediaFile.rootDirectoryPath,
        mediaFile.fileName,
        updatedTags,
      );

      res.json({ ok: true, tags: updatedTags });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .json({ error: "Failed to add tag to media file", details: message });
    }
  },
);

app.delete(
  "/api/media/:fileName",
  async (req: Request<ImageTagRouteParams>, res: Response) => {
    try {
      const mediaFile = resolveMediaRouteFile(req, res);
      if (!mediaFile) {
        return;
      }

      const stat = await statMediaFile(mediaFile.fullPath);
      if (!stat?.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      await fs.unlink(mediaFile.fullPath);
      removeCachedMediaEntry(mediaFile.rootDirectoryPath, mediaFile.fileName);

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
      const tagName = decodeURIComponent(req.params.tagName || "").trim();
      if (!tagName) {
        res.status(400).json({ error: "tagName is required" });
        return;
      }

      const mediaFile = resolveMediaRouteFile(req, res);
      if (!mediaFile) {
        return;
      }

      const stat = await statMediaFileForMetadataUpdate(mediaFile.fullPath);
      if (stat && !stat.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const metadata = await exiftool.read(mediaFile.fullPath);
      const existingTags = getTagsFromMetadata(metadata);
      const writableMediaFile = await prepareWritableMediaFile(
        mediaFile.fullPath,
        metadata,
      );

      if (!existingTags.includes(tagName)) {
        updateCachedMediaTags(
          mediaFile.rootDirectoryPath,
          mediaFile.fileName,
          existingTags,
        );
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
          await fs.copyFile(writableMediaFile.path, mediaFile.fullPath);
        }

        didPersistUpdatedMedia = true;
      } finally {
        if (writableMediaFile.isTemporary && didPersistUpdatedMedia) {
          await fs.unlink(writableMediaFile.path).catch(() => undefined);
        }
      }

      updateCachedMediaTags(
        mediaFile.rootDirectoryPath,
        mediaFile.fileName,
        updatedTags,
      );

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
