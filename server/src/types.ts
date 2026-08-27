export type MediaKind = "image" | "video";
export type ContentType = "image" | "video" | "gif";
export type TagFilterMode = "AND" | "OR";

export type MediaResult = {
  name: string;
  mimeType: string;
  kind: MediaKind;
  sizeBytes: number;
  streamUrl: string;
  tags: string[];
};

export type AddImageTagBody = {
  tag?: string;
};

export type ForgetRootBody = {
  root?: string | null;
};

export type ImageTagRouteParams = {
  fileName: string;
};

export type DeleteImageTagRouteParams = {
  fileName: string;
  tagName: string;
};

export type MediaFile = {
  relativePath: string;
  fullPath: string;
  sizeBytes: number;
};

export type FolderNode = {
  name: string;
  path: string;
  relativePath: string;
  imageCount: number;
  gifCount: number;
  videoCount: number;
  children: FolderNode[];
};

export type CachedMediaEntry = MediaResult & {
  fullPath: string;
};

export type MediaIndex = {
  rootDirectoryPath: string;
  mediaByRelativePath: Map<string, CachedMediaEntry>;
  sortedMedia: CachedMediaEntry[];
  scannedFiles: number;
  supportedFiles: number;
  builtAtMs: number;
  maxSupportedFiles?: number;
};

export type MediaIndexOptions = {
  maxSupportedFiles?: number;
};

export type MediaIndexProgress = {
  status: "idle" | "enumerating" | "indexing" | "complete" | "error";
  scannedFiles: number;
  totalFiles: number;
  indexedFiles: number;
  startedAtMs: number;
  updatedAtMs: number;
  error?: string;
};

export type MediaIndexProgressResponse = {
  status: MediaIndexProgress["status"];
  current: number;
  total: number;
  percent: number;
  indexedFiles: number;
  startedAtMs: number;
  updatedAtMs: number;
  error?: string;
};

export type MediaDescriptor = {
  mimeType: string;
  kind: MediaKind;
};

export type ResolvedMediaFile = {
  fileName: string;
  rootDirectoryPath: string;
  fullPath: string;
  extension: string;
  descriptor: MediaDescriptor;
};
