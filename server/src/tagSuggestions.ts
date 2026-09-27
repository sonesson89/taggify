import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { logProgress } from "./helpers.js";
import type {
  CachedMediaEntry,
  TagSuggestion,
  TagSuggestionModelStatus,
} from "./types";

// Local, offline tag suggestion engine built on CLIP (via @xenova/transformers).
// The model runs fully in-process on the CPU - no external API calls, no per-request cost.
// Model weights (~150MB) are downloaded once from Hugging Face on first use and cached
// locally afterwards (default cache dir: <server>/.cache or HF_HOME if set).
const CLIP_MODEL_ID = "Xenova/clip-vit-base-patch32";

// Tunables for the suggestion algorithm.
const NEIGHBOR_COUNT = 12;
const MAX_SUGGESTIONS = 8;
const MIN_SUGGESTION_SCORE = 0.12;
const NEIGHBOR_SIGNAL_WEIGHT = 0.7;
const ZERO_SHOT_SIGNAL_WEIGHT = 0.3;
// How many un-cached neighbor images to embed at once during background warm-up.
const WARM_EMBEDDING_CONCURRENCY = 4;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClipModels = {
  tokenizer: any;
  textModel: any;
  processor: any;
  visionModel: any;
};

let clipModels: ClipModels | null = null;
let clipModelsPromise: Promise<ClipModels> | null = null;
let modelStatus: TagSuggestionModelStatus = "idle";
let modelError: string | null = null;

const loadClipModels = async (): Promise<ClipModels> => {
  if (clipModels) {
    return clipModels;
  }

  if (!clipModelsPromise) {
    modelStatus = "loading";
    modelError = null;

    clipModelsPromise = (async () => {
      const {
        AutoTokenizer,
        AutoProcessor,
        CLIPTextModelWithProjection,
        CLIPVisionModelWithProjection,
      } = await import("@xenova/transformers");

      logProgress(
        "tag-suggestions",
        `Loading local CLIP model '${CLIP_MODEL_ID}' (first run downloads and caches weights locally)...`,
      );

      const [tokenizer, textModel, processor, visionModel] =
        await Promise.all([
          AutoTokenizer.from_pretrained(CLIP_MODEL_ID),
          CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL_ID),
          AutoProcessor.from_pretrained(CLIP_MODEL_ID),
          CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL_ID),
        ]);

      logProgress("tag-suggestions", "Local CLIP model ready.");

      return { tokenizer, textModel, processor, visionModel };
    })();

    clipModelsPromise
      .then((loadedModels) => {
        clipModels = loadedModels;
        modelStatus = "ready";
      })
      .catch((err: unknown) => {
        clipModelsPromise = null;
        modelStatus = "error";
        modelError = err instanceof Error ? err.message : String(err);
      });
  }

  return clipModelsPromise;
};

export const getTagSuggestionModelStatus = (): {
  status: TagSuggestionModelStatus;
  error: string | null;
} => ({ status: modelStatus, error: modelError });

const l2Normalize = (vector: Float32Array): Float32Array => {
  let sumOfSquares = 0;
  for (let index = 0; index < vector.length; index += 1) {
    sumOfSquares += vector[index] * vector[index];
  }

  const norm = Math.sqrt(sumOfSquares) || 1;
  const normalized = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    normalized[index] = vector[index] / norm;
  }

  return normalized;
};

const cosineSimilarityOfNormalizedVectors = (
  left: Float32Array,
  right: Float32Array,
): number => {
  let dotProduct = 0;
  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
  }

  return dotProduct;
};

const extractVideoFrameToTempFile = async (
  videoFullPath: string,
): Promise<string> => {
  if (!ffmpegPath) {
    throw new Error(
      "The bundled FFmpeg executable is unavailable for extracting a video frame.",
    );
  }

  const tempFramePath = path.join(
    os.tmpdir(),
    `taggify-suggestion-frame-${randomUUID()}.jpg`,
  );

  await new Promise<void>((resolve, reject) => {
    execFile(
      ffmpegPath as string,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "1",
        "-i",
        videoFullPath,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        "-y",
        tempFramePath,
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

  return tempFramePath;
};

const embedImageFromPath = async (
  imageFullPath: string,
  kind: CachedMediaEntry["kind"],
): Promise<Float32Array> => {
  const { RawImage } = await import("@xenova/transformers");
  const { processor, visionModel } = await loadClipModels();

  const isVideo = kind === "video";
  const framePath = isVideo
    ? await extractVideoFrameToTempFile(imageFullPath)
    : imageFullPath;

  try {
    const rawImage = await RawImage.read(framePath);
    const imageInputs = await processor(rawImage);
    const { image_embeds: imageEmbeds } = await visionModel(imageInputs);
    return l2Normalize(Float32Array.from(imageEmbeds.data as Float32Array));
  } finally {
    if (isVideo) {
      await fs.unlink(framePath).catch(() => undefined);
    }
  }
};

const embedTagNames = async (
  tagNames: string[],
): Promise<Map<string, Float32Array>> => {
  const embeddingByTagName = new Map<string, Float32Array>();
  if (tagNames.length === 0) {
    return embeddingByTagName;
  }

  const { tokenizer, textModel } = await loadClipModels();
  const prompts = tagNames.map((tagName) => `a photo of ${tagName}`);
  const textInputs = tokenizer(prompts, { padding: true, truncation: true });
  const { text_embeds: textEmbeds } = await textModel(textInputs);

  const embeddingDimensions = textEmbeds.dims[textEmbeds.dims.length - 1];
  const flatData = textEmbeds.data as Float32Array;

  tagNames.forEach((tagName, tagIndex) => {
    const start = tagIndex * embeddingDimensions;
    const row = flatData.slice(start, start + embeddingDimensions);
    embeddingByTagName.set(tagName, l2Normalize(row));
  });

  return embeddingByTagName;
};

type CachedEmbeddingEntry = {
  embedding: Float32Array;
  tags: string[];
};

const embeddingCacheByRoot = new Map<
  string,
  Map<string, CachedEmbeddingEntry>
>();

const getEmbeddingCacheForRoot = (
  rootDirectoryPath: string,
): Map<string, CachedEmbeddingEntry> => {
  let cache = embeddingCacheByRoot.get(rootDirectoryPath);
  if (!cache) {
    cache = new Map();
    embeddingCacheByRoot.set(rootDirectoryPath, cache);
  }
  return cache;
};

export const invalidateCachedMediaEmbedding = (
  rootDirectoryPath: string,
  relativePath: string,
): void => {
  embeddingCacheByRoot.get(rootDirectoryPath)?.delete(relativePath);
};

export const clearTagSuggestionCacheForRoot = (
  rootDirectoryPath: string,
): void => {
  embeddingCacheByRoot.delete(rootDirectoryPath);
};

// Tracks roots currently being warmed so overlapping requests don't start duplicate passes.
const rootsCurrentlyWarming = new Set<string>();

// Embeds any not-yet-cached entries in the background (bounded concurrency) so a single
// suggestion request never blocks on a potentially large batch of un-cached images.
// Neighbor quality simply improves on subsequent requests as the cache fills in.
const warmTagSuggestionEmbeddings = (
  rootDirectoryPath: string,
  entriesToEmbed: CachedMediaEntry[],
): void => {
  if (entriesToEmbed.length === 0 || rootsCurrentlyWarming.has(rootDirectoryPath)) {
    return;
  }

  rootsCurrentlyWarming.add(rootDirectoryPath);
  const embeddingCache = getEmbeddingCacheForRoot(rootDirectoryPath);

  void (async () => {
    try {
      let nextIndex = 0;
      const embedNext = async (): Promise<void> => {
        while (nextIndex < entriesToEmbed.length) {
          const entry = entriesToEmbed[nextIndex];
          nextIndex += 1;

          if (embeddingCache.has(entry.name)) {
            continue;
          }

          try {
            const embedding = await embedImageFromPath(entry.fullPath, entry.kind);
            embeddingCache.set(entry.name, { embedding, tags: entry.tags });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logProgress(
              "tag-suggestions",
              `Background warm-up: skipping '${entry.name}' - failed to embed. ${message}`,
            );
          }
        }
      };

      const workerCount = Math.min(
        WARM_EMBEDDING_CONCURRENCY,
        entriesToEmbed.length,
      );
      await Promise.all(Array.from({ length: workerCount }, () => embedNext()));

      logProgress(
        "tag-suggestions",
        `Finished background embedding warm-up for '${rootDirectoryPath}'. cachedEntries=${embeddingCache.size}`,
      );
    } finally {
      rootsCurrentlyWarming.delete(rootDirectoryPath);
    }
  })();
};

export const getTagSuggestionsForMedia = async (
  rootDirectoryPath: string,
  targetEntry: CachedMediaEntry,
  allTaggedEntries: CachedMediaEntry[],
): Promise<TagSuggestion[]> => {
  const embeddingCache = getEmbeddingCacheForRoot(rootDirectoryPath);

  const targetEmbedding = await embedImageFromPath(
    targetEntry.fullPath,
    targetEntry.kind,
  );

  const neighborCorpus = allTaggedEntries.filter(
    (entry) => entry.name !== targetEntry.name,
  );

  const neighborSimilarities: Array<{
    entry: CachedMediaEntry;
    similarity: number;
  }> = [];
  const notYetCachedEntries: CachedMediaEntry[] = [];

  for (const entry of neighborCorpus) {
    const cachedEntry = embeddingCache.get(entry.name);
    if (!cachedEntry) {
      notYetCachedEntries.push(entry);
      continue;
    }

    // Keep the cached embedding, but always use the latest tags.
    cachedEntry.tags = entry.tags;
    neighborSimilarities.push({
      entry,
      similarity: cosineSimilarityOfNormalizedVectors(
        targetEmbedding,
        cachedEntry.embedding,
      ),
    });
  }

  // Embed any not-yet-cached neighbors in the background rather than blocking this
  // request - suggestion quality improves on subsequent requests as the cache fills in.
  warmTagSuggestionEmbeddings(rootDirectoryPath, notYetCachedEntries);

  neighborSimilarities.sort((left, right) => right.similarity - left.similarity);
  const topNeighbors = neighborSimilarities.slice(0, NEIGHBOR_COUNT);

  const neighborTagScores = new Map<string, number>();
  let neighborWeightTotal = 0;

  topNeighbors.forEach(({ entry, similarity }) => {
    const weight = Math.max(0, similarity);
    neighborWeightTotal += weight;
    entry.tags.forEach((tag) => {
      neighborTagScores.set(tag, (neighborTagScores.get(tag) ?? 0) + weight);
    });
  });
  if (neighborWeightTotal > 0) {
    neighborTagScores.forEach((score, tag) => {
      neighborTagScores.set(tag, score / neighborWeightTotal);
    });
  }

  const candidateTagNames = Array.from(
    new Set(allTaggedEntries.flatMap((entry) => entry.tags)),
  ).filter((tag) => !targetEntry.tags.includes(tag));

  const zeroShotScores = new Map<string, number>();
  if (candidateTagNames.length > 0) {
    const tagEmbeddingByName = await embedTagNames(candidateTagNames);
    tagEmbeddingByName.forEach((embedding, tag) => {
      zeroShotScores.set(
        tag,
        Math.max(
          0,
          cosineSimilarityOfNormalizedVectors(targetEmbedding, embedding),
        ),
      );
    });
  }

  const hasNeighborSignal = neighborWeightTotal > 0;
  const combinedScoreByTag = new Map<string, number>();
  candidateTagNames.forEach((tag) => {
    const neighborScore = neighborTagScores.get(tag) ?? 0;
    const zeroShotScore = zeroShotScores.get(tag) ?? 0;
    const combinedScore = hasNeighborSignal
      ? NEIGHBOR_SIGNAL_WEIGHT * neighborScore +
        ZERO_SHOT_SIGNAL_WEIGHT * zeroShotScore
      : zeroShotScore;
    combinedScoreByTag.set(tag, combinedScore);
  });

  return Array.from(combinedScoreByTag.entries())
    .filter(([, score]) => score >= MIN_SUGGESTION_SCORE)
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_SUGGESTIONS)
    .map(([tag, score]) => ({ tag, score: Math.round(score * 1000) / 1000 }));
};
