export type ImageDto = {
  name: string;
  mimeType: string;
  kind: "image" | "video";
  streamUrl: string;
  sizeBytes: number;
  tags: string[];
};

export type ImagesResponse = {
  count: number;
  totalCount: number;
  page: number;
  limit: number;
  images: ImageDto[];
  taggedCount?: number;
  untaggedCount?: number;
  availableTags?: Array<{
    name: string;
    occurenceCount: number;
  }>;
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

export type FoldersResponse = {
  root: FolderNode;
};

export type Tag = {
  name: string;
  color: string;
  occurenceCount: number;
};

export type FilterMode = "AND" | "OR";
