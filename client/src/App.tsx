import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FilterMode,
  FolderNode,
  FoldersResponse,
  ImageDto,
  ImagesResponse,
  Tag,
} from "./types";
import {
  addTagToImage,
  deleteMediaFile,
  deleteTagFromImage,
  openMediaFile,
  revealMediaFile,
} from "./api/imageTags";
import FolderNavigation from "./components/FolderNavigation.tsx";
import ImageCard from "./components/ImageCard.tsx";
import ImageSlideout from "./components/ImageSlideout.tsx";
import Pagination from "./components/Pagination.tsx";
import "./App.less";
import Pill from "./components/Pill.tsx";
import MediaIndexProgressBar from "./components/MediaIndexProgressBar.tsx";
import MediaTypeFilters from "./components/MediaTypeFilters.tsx";
import TagSuggestionInput from "./components/TagSuggestionInput.tsx";
import ToggleSwitch from "./components/ToggleSwitch.tsx";
import { coalesceScheduledIndexRefresh } from "./indexingRefresh";

type ContentType = "image" | "video" | "gif";
type SlideoutBoundaryDirection = "next" | "previous";

const DEFAULT_ITEMS_PER_PAGE = 50;
const PAGE_SIZE_OPTIONS = [15, 30, 50, 75, 100];
const ROOT_FOLDER_STORAGE_KEY = "taggify:selectedRootFolder";
const LEGACY_ROOT_FOLDER_STORAGE_KEY = "tagger:selectedRootFolder";

const colorFromTagName = (tagName: string): string => {
  // Deterministic hash so the same tag name always maps to the same color.
  let hash = 0;
  for (let index = 0; index < tagName.length; index += 1) {
    hash = (hash * 31 + tagName.charCodeAt(index)) | 0;
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 50%)`;
};

const mergeKnownTagNames = (
  currentTagNames: string[],
  incomingTagNames: string[],
): string[] => {
  if (incomingTagNames.length === 0) {
    return currentTagNames;
  }

  const canonicalNameByLower = new Map<string, string>();

  currentTagNames.forEach((tagName) => {
    canonicalNameByLower.set(tagName.toLowerCase(), tagName);
  });

  incomingTagNames.forEach((tagName) => {
    const normalizedTagName = tagName.trim();
    if (!normalizedTagName) {
      return;
    }

    const normalizedKey = normalizedTagName.toLowerCase();
    if (!canonicalNameByLower.has(normalizedKey)) {
      canonicalNameByLower.set(normalizedKey, normalizedTagName);
    }
  });

  return Array.from(canonicalNameByLower.values()).sort((left, right) =>
    left.localeCompare(right),
  );
};

const addTagToRecentHistory = (
  currentRecentTags: string[],
  tagName: string,
): string[] => {
  const normalizedTagName = tagName.trim();
  if (!normalizedTagName) {
    return currentRecentTags;
  }

  return [
    normalizedTagName,
    ...currentRecentTags.filter(
      (entry) => entry.toLowerCase() !== normalizedTagName.toLowerCase(),
    ),
  ].slice(0, 20);
};

function App() {
  const [tagsFilter, setTagsFilter] = useState<string[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [knownTagNames, setKnownTagNames] = useState<string[]>([]);
  const [images, setImages] = useState<ImageDto[]>([]);
  const [selectedImage, setSelectedImage] = useState<ImageDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [folderTree, setFolderTree] = useState<FolderNode | null>(null);
  const [selectedRootFolder, setSelectedRootFolder] = useState<string | null>(
    () => {
      try {
        const storedRoot =
          window.localStorage.getItem(ROOT_FOLDER_STORAGE_KEY) ??
          window.localStorage.getItem(LEGACY_ROOT_FOLDER_STORAGE_KEY);
        return storedRoot && storedRoot.trim() ? storedRoot : null;
      } catch {
        return null;
      }
    },
  );
  const [selectedFolderPath, setSelectedFolderPath] = useState<string>("");
  const [showAllRecursively, setShowAllRecursively] = useState<boolean>(false);
  const [isFolderPanelOpen, setIsFolderPanelOpen] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [filterMode, setFilterMode] = useState<FilterMode>("OR");
  const [showOnlyUntaggedMedia, setShowOnlyUntaggedMedia] =
    useState<boolean>(false);
  const [showOnlyTaggedMedia, setShowOnlyTaggedMedia] =
    useState<boolean>(false);
  const [selectedContentTypes, setSelectedContentTypes] = useState<
    ContentType[]
  >(["image", "video", "gif"]);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [itemsPerPage, setItemsPerPage] = useState<number>(
    DEFAULT_ITEMS_PER_PAGE,
  );
  const [totalMediaCount, setTotalMediaCount] = useState<number>(0);
  const [taggedMediaCount, setTaggedMediaCount] = useState<number>(0);
  const [untaggedMediaCount, setUntaggedMediaCount] = useState<number>(0);
  const [mediaRefreshVersion, setMediaRefreshVersion] = useState<number>(0);
  const [mediaIndexProgress, setMediaIndexProgress] = useState<{
    status: string;
    current: number;
    total: number;
    percent: number;
    indexedFiles: number;
  } | null>(null);
  const indexRefreshTimeoutRef = useRef<number | null>(null);
  const [selectedMediaNames, setSelectedMediaNames] = useState<string[]>([]);
  const [isDeletingTagsFromSelectedMedia, setIsDeletingTagsFromSelectedMedia] =
    useState<boolean>(false);
  const [isDeletingSelectedMedia, setIsDeletingSelectedMedia] =
    useState<boolean>(false);
  const [recentlyAddedTags, setRecentlyAddedTags] = useState<string[]>([]);

  useEffect(() => {
    return () => {
      if (indexRefreshTimeoutRef.current !== null) {
        window.clearTimeout(indexRefreshTimeoutRef.current);
      }
    };
  }, []);
  const [
    pendingSlideoutBoundaryDirection,
    setPendingSlideoutBoundaryDirection,
  ] = useState<SlideoutBoundaryDirection | null>(null);

  useEffect(() => {
    try {
      if (!selectedRootFolder) {
        window.localStorage.removeItem(ROOT_FOLDER_STORAGE_KEY);
        return;
      }

      window.localStorage.setItem(ROOT_FOLDER_STORAGE_KEY, selectedRootFolder);
      window.localStorage.removeItem(LEGACY_ROOT_FOLDER_STORAGE_KEY);
    } catch {
      // Ignore localStorage failures and continue without persistence.
    }
  }, [selectedRootFolder]);

  useEffect(() => {
    if (!selectedRootFolder) {
      return;
    }

    let isCancelled = false;

    const loadInitialRootData = async () => {
      setError("");

      try {
        const params = new URLSearchParams();
        params.set("root", selectedRootFolder);

        const loadFolders = async () => {
          const foldersResponse = await fetch(
            `/api/folders?${params.toString()}`,
          );
          if (!foldersResponse.ok) {
            throw new Error(
              `Request failed with status ${foldersResponse.status}`,
            );
          }

          const folderPayload: FoldersResponse = await foldersResponse.json();
          return folderPayload;
        };

        const folderPayload = await loadFolders();

        if (isCancelled) {
          return;
        }

        setFolderTree(folderPayload.root);
      } catch (err) {
        if (isCancelled) {
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    };

    loadInitialRootData();

    return () => {
      isCancelled = true;
    };
  }, [selectedRootFolder]);

  useEffect(() => {
    if (!folderTree || !selectedRootFolder) {
      return;
    }

    const controller = new AbortController();

    const loadImages = async () => {
      setError("");

      /* if (isLoading || mediaIndexProgress) {
        return;
      } */

      setIsLoading(true);

      try {
        const params = new URLSearchParams();
        params.set("root", selectedRootFolder);
        params.set("page", String(currentPage));
        params.set("limit", String(itemsPerPage));
        params.set("contentTypes", selectedContentTypes.join(","));
        params.set("showOnlyUntagged", String(showOnlyUntaggedMedia));
        params.set("showOnlyTagged", String(showOnlyTaggedMedia));
        params.set("useTagFilters", String(tagsFilter.length > 0));
        params.set("filterMode", filterMode);

        if (tagsFilter.length > 0) {
          params.set("tags", tagsFilter.join(","));
        }

        if (showAllRecursively) {
          params.set("recursive", "true");
        } else if (selectedFolderPath) {
          params.set("folder", selectedFolderPath);
        }

        const requestUrl =
          params.size > 0 ? `/api/media?${params.toString()}` : "/api/media";
        const response = await fetch(requestUrl, { signal: controller.signal });
        if (!response.ok) {
          const errorPayload = (await response.json().catch(() => ({}))) as {
            error?: string;
            details?: string;
          };
          throw new Error(
            errorPayload.details ||
              errorPayload.error ||
              `Request failed with status ${response.status}`,
          );
        }

        const payload = (await response.json()) as ImagesResponse & {
          indexing?: boolean;
          progress?: {
            status: string;
            current: number;
            total: number;
            percent: number;
            indexedFiles: number;
          };
        };

        if (payload.indexing === true) {
          setIsLoading(false);
          setMediaIndexProgress(
            payload.progress ?? {
              status: "indexing",
              current: 0,
              total: 0,
              percent: 0,
              indexedFiles: 0,
            },
          );
          setImages([]);
          setTags([]);
          setTotalMediaCount(0);
          setTaggedMediaCount(0);
          setUntaggedMediaCount(0);
          setSelectedImage(null);
          setSelectedMediaNames([]);
          coalesceScheduledIndexRefresh({
            timeoutRef: indexRefreshTimeoutRef,
            delayMs: 1500,
            onTrigger: () => {
              setMediaRefreshVersion((current) => current + 1);
            },
          });
          return;
        }

        setMediaIndexProgress(null);

        const tagFacets = payload.availableTags ?? [];
        setTags(
          tagFacets.map((tagFacet) => ({
            name: tagFacet.name,
            color: colorFromTagName(tagFacet.name),
            occurenceCount: tagFacet.occurenceCount,
          })),
        );
        setKnownTagNames((currentTagNames) =>
          mergeKnownTagNames(
            currentTagNames,
            tagFacets.map((tagFacet) => tagFacet.name),
          ),
        );

        const validTagNames = new Set(
          tagFacets.map((tagFacet) => tagFacet.name),
        );
        setTagsFilter((currentFilters) => {
          const nextFilters = currentFilters.filter((selectedTag) =>
            validTagNames.has(selectedTag),
          );

          if (
            nextFilters.length === currentFilters.length &&
            nextFilters.every(
              (tagName, index) => tagName === currentFilters[index],
            )
          ) {
            return currentFilters;
          }

          return nextFilters;
        });
        setImages(payload.images);
        setTotalMediaCount(
          payload.totalCount ?? payload.count ?? payload.images.length,
        );
        setTaggedMediaCount(payload.taggedCount ?? 0);
        setUntaggedMediaCount(payload.untaggedCount ?? 0);

        if (pendingSlideoutBoundaryDirection && payload.images.length > 0) {
          setSelectedImage(
            pendingSlideoutBoundaryDirection === "next"
              ? payload.images[0]
              : payload.images[payload.images.length - 1],
          );
          setPendingSlideoutBoundaryDirection(null);
        }
      } catch (err) {
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        setMediaIndexProgress(null);
        setError(message);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    loadImages();

    return () => {
      controller.abort();
    };
  }, [
    folderTree,
    selectedRootFolder,
    selectedFolderPath,
    showAllRecursively,
    currentPage,
    itemsPerPage,
    selectedContentTypes,
    showOnlyUntaggedMedia,
    showOnlyTaggedMedia,
    filterMode,
    tagsFilter,
    mediaRefreshVersion,
    pendingSlideoutBoundaryDirection,
  ]);

  const filteredImages = useMemo(
    () =>
      [...images].sort((left, right) => left.name.localeCompare(right.name)),
    [images],
  );
  const totalPages = Math.max(1, Math.ceil(totalMediaCount / itemsPerPage));
  const safeCurrentPage = Math.min(currentPage, totalPages);

  const handlePageChange = (nextPage: number) => {
    setSelectedMediaNames([]);
    setCurrentPage(Math.max(1, Math.min(nextPage, totalPages)));
  };

  const canNavigateToPreviousInSlideout = useMemo(() => {
    if (!selectedImage) {
      return false;
    }

    const currentIndex = filteredImages.findIndex(
      (image) => image.name === selectedImage.name,
    );
    if (currentIndex === -1) {
      return (
        filteredImages.some(
          (image) => image.name.localeCompare(selectedImage.name) < 0,
        ) || safeCurrentPage > 1
      );
    }

    return currentIndex > 0 || safeCurrentPage > 1;
  }, [filteredImages, selectedImage, safeCurrentPage]);

  const canNavigateToNextInSlideout = useMemo(() => {
    if (!selectedImage) {
      return false;
    }

    const currentIndex = filteredImages.findIndex(
      (image) => image.name === selectedImage.name,
    );
    if (currentIndex === -1) {
      return (
        filteredImages.some(
          (image) => image.name.localeCompare(selectedImage.name) > 0,
        ) || safeCurrentPage < totalPages
      );
    }

    return (
      currentIndex < filteredImages.length - 1 || safeCurrentPage < totalPages
    );
  }, [filteredImages, selectedImage, safeCurrentPage, totalPages]);

  const handleOpenPreviousInSlideout = () => {
    if (!selectedImage || isLoading) {
      return;
    }

    const currentIndex = filteredImages.findIndex(
      (image) => image.name === selectedImage.name,
    );

    if (currentIndex > 0) {
      setSelectedImage(filteredImages[currentIndex - 1]);
      return;
    }

    if (currentIndex === -1) {
      const previousImage = filteredImages.findLast(
        (image) => image.name.localeCompare(selectedImage.name) < 0,
      );
      if (previousImage) {
        setSelectedImage(previousImage);
        return;
      }
    }

    if (safeCurrentPage <= 1) {
      return;
    }

    setPendingSlideoutBoundaryDirection("previous");
    setCurrentPage(safeCurrentPage - 1);
  };

  const handleOpenNextInSlideout = () => {
    if (!selectedImage || isLoading) {
      return;
    }

    const currentIndex = filteredImages.findIndex(
      (image) => image.name === selectedImage.name,
    );

    if (currentIndex >= 0 && currentIndex < filteredImages.length - 1) {
      setSelectedImage(filteredImages[currentIndex + 1]);
      return;
    }

    if (currentIndex === -1) {
      const nextImage = filteredImages.find(
        (image) => image.name.localeCompare(selectedImage.name) > 0,
      );
      if (nextImage) {
        setSelectedImage(nextImage);
        return;
      }
    }

    if (safeCurrentPage >= totalPages) {
      return;
    }

    setPendingSlideoutBoundaryDirection("next");
    setCurrentPage(safeCurrentPage + 1);
  };

  const handleToggleSelectedMedia = (mediaName: string) => {
    setSelectedMediaNames((currentSelection) =>
      currentSelection.includes(mediaName)
        ? currentSelection.filter((name) => name !== mediaName)
        : [...currentSelection, mediaName],
    );
  };

  const handleDeleteTagsFromSelectedMedia = async () => {
    if (isDeletingTagsFromSelectedMedia || selectedMediaNames.length === 0) {
      return;
    }

    setIsDeletingTagsFromSelectedMedia(true);

    try {
      const selectedImages = images.filter((image) =>
        selectedMediaNames.includes(image.name),
      );

      await Promise.all(
        selectedImages.map(async (image) => {
          for (const tagName of image.tags) {
            await deleteTagFromImage(
              image.name,
              tagName,
              selectedRootFolder ?? undefined,
            );
          }
        }),
      );

      setError("");

      setImages((currentImages) =>
        currentImages.map((image) =>
          selectedMediaNames.includes(image.name)
            ? {
                ...image,
                tags: [],
              }
            : image,
        ),
      );

      setSelectedImage((currentSelectedImage) =>
        currentSelectedImage &&
        selectedMediaNames.includes(currentSelectedImage.name)
          ? { ...currentSelectedImage, tags: [] }
          : currentSelectedImage,
      );

      setTagsFilter((currentFilters) => currentFilters.filter(Boolean));

      setMediaRefreshVersion((current) => current + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsDeletingTagsFromSelectedMedia(false);
    }
  };

  const handleAddTagToSelectedMedia = async (
    tagName: string,
  ): Promise<boolean> => {
    const normalizedTag = tagName.trim();
    if (!normalizedTag || selectedMediaNames.length === 0) {
      return false;
    }

    const selectedImages = images.filter((image) =>
      selectedMediaNames.includes(image.name),
    );
    const imagesMissingTag = selectedImages.filter(
      (image) => !image.tags.includes(normalizedTag),
    );

    if (imagesMissingTag.length === 0) {
      return false;
    }

    try {
      const results = await Promise.allSettled(
        imagesMissingTag.map(async (image) => {
          await addTagToImage(
            image.name,
            normalizedTag,
            selectedRootFolder ?? undefined,
          );
          return image.name;
        }),
      );

      const succeededMediaNames = results
        .filter(
          (result): result is PromiseFulfilledResult<string> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);

      const failedResults = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      if (succeededMediaNames.length === 0) {
        const firstError = failedResults[0]?.reason;
        const message =
          firstError instanceof Error
            ? firstError.message
            : "Failed to add tag to selected media.";
        setError(message);
        return false;
      }

      if (failedResults.length > 0) {
        const firstError = failedResults[0]?.reason;
        const firstMessage =
          firstError instanceof Error ? firstError.message : "Unknown error.";
        setError(
          `Added tag to ${succeededMediaNames.length}/${imagesMissingTag.length} media. ${failedResults.length} failed. First error: ${firstMessage}`,
        );
      } else {
        setError("");
      }

      setImages((currentImages) =>
        currentImages.map((image) => {
          if (!succeededMediaNames.includes(image.name)) {
            return image;
          }

          if (image.tags.includes(normalizedTag)) {
            return image;
          }

          return {
            ...image,
            tags: [...image.tags, normalizedTag],
          };
        }),
      );

      setSelectedImage((currentSelectedImage) => {
        if (!currentSelectedImage) {
          return currentSelectedImage;
        }

        if (!succeededMediaNames.includes(currentSelectedImage.name)) {
          return currentSelectedImage;
        }

        if (currentSelectedImage.tags.includes(normalizedTag)) {
          return currentSelectedImage;
        }

        return {
          ...currentSelectedImage,
          tags: [...currentSelectedImage.tags, normalizedTag],
        };
      });

      setTags((currentTags) => {
        const existingTag = currentTags.find(
          (tag) => tag.name === normalizedTag,
        );
        const delta = succeededMediaNames.length;

        if (existingTag) {
          return currentTags.map((tag) =>
            tag.name === normalizedTag
              ? { ...tag, occurenceCount: tag.occurenceCount + delta }
              : tag,
          );
        }

        return [
          ...currentTags,
          {
            name: normalizedTag,
            color: colorFromTagName(normalizedTag),
            occurenceCount: delta,
          },
        ];
      });
      setKnownTagNames((currentTagNames) =>
        mergeKnownTagNames(currentTagNames, [normalizedTag]),
      );
      setRecentlyAddedTags((currentRecentTags) =>
        addTagToRecentHistory(currentRecentTags, normalizedTag),
      );

      setMediaRefreshVersion((current) => current + 1);
      return succeededMediaNames.length > 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return false;
    }
  };

  const visibleMediaNames = filteredImages.map((image) => image.name);

  const tagColorByName = useMemo(
    () => Object.fromEntries(tags.map((tag) => [tag.name, tag.color])),
    [tags],
  );

  const tagNameSuggestions = useMemo(() => knownTagNames, [knownTagNames]);

  const resolveKnownTagName = (candidate: string): string | null => {
    const normalizedCandidate = candidate.trim();
    if (!normalizedCandidate) {
      return null;
    }

    const exactMatch = knownTagNames.find(
      (tagName) => tagName === normalizedCandidate,
    );
    if (exactMatch) {
      return exactMatch;
    }

    const caseInsensitiveMatch = knownTagNames.find(
      (tagName) => tagName.toLowerCase() === normalizedCandidate.toLowerCase(),
    );
    return caseInsensitiveMatch ?? null;
  };

  const handleAddTagToFilter = (candidateTagName: string): boolean => {
    const resolvedTagName = resolveKnownTagName(candidateTagName);
    if (!resolvedTagName || tagsFilter.includes(resolvedTagName)) {
      return false;
    }

    setCurrentPage(1);
    setTagsFilter((current) => [...current, resolvedTagName]);
    return true;
  };

  const handleDeleteTagFromFilter = (tagName: string) => {
    setCurrentPage(1);
    setTagsFilter((current) => current.filter((entry) => entry !== tagName));
  };

  const handleSelectRootFolder = async () => {
    try {
      setError("");

      const response = await fetch("/api/root/select", {
        method: "POST",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          details?: string;
        };
        throw new Error(
          payload.details ||
            payload.error ||
            `Request failed with status ${response.status}`,
        );
      }

      const payload = (await response.json()) as {
        root?: string;
        cancelled?: boolean;
      };

      if (!payload.root || payload.cancelled) {
        return;
      }

      setFolderTree(null);
      setTags([]);
      setKnownTagNames([]);
      setTagsFilter([]);
      setImages([]);
      setTotalMediaCount(0);
      setTaggedMediaCount(0);
      setUntaggedMediaCount(0);
      setMediaIndexProgress(null);
      setSelectedImage(null);
      setSelectedMediaNames([]);
      setSelectedRootFolder(payload.root);
      setSelectedFolderPath("");
      setShowAllRecursively(false);
      setShowOnlyUntaggedMedia(false);
      setShowOnlyTaggedMedia(false);
      setCurrentPage(1);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to choose root folder.";
      setError(message);
    }
  };

  const handleForgetRootFolder = () => {
    const rootToForget = selectedRootFolder;
    if (rootToForget) {
      void fetch("/api/root/forget", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ root: rootToForget }),
      });
    }

    setSelectedRootFolder(null);
    setFolderTree(null);
    setTags([]);
    setKnownTagNames([]);
    setTagsFilter([]);
    setImages([]);
    setTotalMediaCount(0);
    setTaggedMediaCount(0);
    setUntaggedMediaCount(0);
    setMediaIndexProgress(null);
    setSelectedImage(null);
    setSelectedMediaNames([]);
    setSelectedFolderPath("");
    setShowAllRecursively(false);
    setShowOnlyUntaggedMedia(false);
    setShowOnlyTaggedMedia(false);
    setCurrentPage(1);
    setError("");
  };

  const handleAddTagToSelectedImage = async (
    tagName: string,
  ): Promise<boolean> => {
    const normalizedTag = tagName.trim();

    if (!normalizedTag || !selectedImage) {
      return false;
    }

    if (selectedImage.tags.includes(normalizedTag)) {
      return true;
    }

    try {
      await addTagToImage(
        selectedImage.name,
        normalizedTag,
        selectedRootFolder ?? undefined,
      );

      setError("");

      setImages((currentImages) =>
        currentImages.map((image) => {
          if (
            image.name !== selectedImage.name ||
            image.tags.includes(normalizedTag)
          ) {
            return image;
          }

          return {
            ...image,
            tags: [...image.tags, normalizedTag],
          };
        }),
      );

      setSelectedImage((currentSelectedImage) =>
        currentSelectedImage && currentSelectedImage.name === selectedImage.name
          ? {
              ...currentSelectedImage,
              tags: currentSelectedImage.tags.includes(normalizedTag)
                ? currentSelectedImage.tags
                : [...currentSelectedImage.tags, normalizedTag],
            }
          : currentSelectedImage,
      );

      setTags((currentTags) => {
        const existingTag = currentTags.find(
          (tag) => tag.name === normalizedTag,
        );

        if (existingTag) {
          return currentTags.map((tag) =>
            tag.name === normalizedTag
              ? { ...tag, occurenceCount: tag.occurenceCount + 1 }
              : tag,
          );
        }

        return [
          ...currentTags,
          {
            name: normalizedTag,
            color: colorFromTagName(normalizedTag),
            occurenceCount: 1,
          },
        ];
      });
      setKnownTagNames((currentTagNames) =>
        mergeKnownTagNames(currentTagNames, [normalizedTag]),
      );
      setRecentlyAddedTags((currentRecentTags) =>
        addTagToRecentHistory(currentRecentTags, normalizedTag),
      );

      setMediaRefreshVersion((current) => current + 1);

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return false;
    }
  };

  const handleDeleteTagFromSelectedImage = async (
    tagName: string,
  ): Promise<boolean> => {
    const normalizedTag = tagName.trim();

    if (!normalizedTag || !selectedImage) {
      return false;
    }

    if (!selectedImage.tags.includes(normalizedTag)) {
      return true;
    }

    try {
      await deleteTagFromImage(
        selectedImage.name,
        normalizedTag,
        selectedRootFolder ?? undefined,
      );

      setError("");

      setImages((currentImages) =>
        currentImages.map((image) =>
          image.name === selectedImage.name
            ? {
                ...image,
                tags: image.tags.filter((tag) => tag !== normalizedTag),
              }
            : image,
        ),
      );

      setSelectedImage((currentSelectedImage) =>
        currentSelectedImage && currentSelectedImage.name === selectedImage.name
          ? {
              ...currentSelectedImage,
              tags: currentSelectedImage.tags.filter(
                (tag) => tag !== normalizedTag,
              ),
            }
          : currentSelectedImage,
      );

      setTags((currentTags) => {
        const existingTag = currentTags.find(
          (tag) => tag.name === normalizedTag,
        );
        if (!existingTag) {
          return currentTags;
        }

        if (existingTag.occurenceCount <= 1) {
          setTagsFilter((currentFilters) =>
            currentFilters.filter((filterTag) => filterTag !== normalizedTag),
          );
          return currentTags.filter((tag) => tag.name !== normalizedTag);
        }

        return currentTags.map((tag) =>
          tag.name === normalizedTag
            ? { ...tag, occurenceCount: tag.occurenceCount - 1 }
            : tag,
        );
      });

      setMediaRefreshVersion((current) => current + 1);

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return false;
    }
  };

  const handleDeleteSelectedImage = async (): Promise<boolean> => {
    if (!selectedImage || isDeletingSelectedMedia) {
      return false;
    }

    const mediaToDelete = selectedImage;
    const currentIndex = filteredImages.findIndex(
      (image) => image.name === mediaToDelete.name,
    );

    let nextSelectedImage: ImageDto | null = null;
    if (currentIndex > 0) {
      nextSelectedImage = filteredImages[currentIndex - 1];
    } else if (currentIndex >= 0 && currentIndex < filteredImages.length - 1) {
      nextSelectedImage = filteredImages[currentIndex + 1];
    } else if (currentIndex === -1) {
      nextSelectedImage =
        filteredImages.findLast(
          (image) => image.name.localeCompare(mediaToDelete.name) < 0,
        ) ??
        filteredImages.find(
          (image) => image.name.localeCompare(mediaToDelete.name) > 0,
        ) ??
        null;
    }

    setIsDeletingSelectedMedia(true);
    try {
      await deleteMediaFile(
        mediaToDelete.name,
        selectedRootFolder ?? undefined,
      );

      setError("");
      setImages((currentImages) =>
        currentImages.filter((image) => image.name !== mediaToDelete.name),
      );
      setSelectedMediaNames((currentSelection) =>
        currentSelection.filter((name) => name !== mediaToDelete.name),
      );
      setSelectedImage(nextSelectedImage);
      setTotalMediaCount((currentTotal) => Math.max(0, currentTotal - 1));
      if (mediaToDelete.tags.length === 0) {
        setUntaggedMediaCount((currentTotal) => Math.max(0, currentTotal - 1));
      } else {
        setTaggedMediaCount((currentTotal) => Math.max(0, currentTotal - 1));
      }
      setMediaRefreshVersion((current) => current + 1);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return false;
    } finally {
      setIsDeletingSelectedMedia(false);
    }
  };

  const handleOpenSelectedImage = async (): Promise<boolean> => {
    if (!selectedImage) {
      return false;
    }

    try {
      await openMediaFile(selectedImage.name, selectedRootFolder ?? undefined);
      setError("");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return false;
    }
  };

  const handleRevealSelectedImage = async (): Promise<boolean> => {
    if (!selectedImage) {
      return false;
    }

    try {
      await revealMediaFile(
        selectedImage.name,
        selectedRootFolder ?? undefined,
      );
      setError("");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return false;
    }
  };

  return (
    <main className="app-shell">
      {!selectedRootFolder ? (
        <div className="rootFolderPrompt">
          <button
            type="button"
            className="rootFolderButton"
            onClick={handleSelectRootFolder}
          >
            Choose root folder
          </button>
        </div>
      ) : (
        <div className="app-layout">
          <FolderNavigation
            folderTree={folderTree}
            isOpen={isFolderPanelOpen}
            selectedFolderPath={selectedFolderPath}
            showAllRecursively={showAllRecursively}
            onTogglePanel={() => setIsFolderPanelOpen((current) => !current)}
            onToggleShowAll={(nextValue) => {
              setSelectedMediaNames([]);
              setShowAllRecursively(nextValue);
              setCurrentPage(1);
              if (nextValue) {
                setSelectedFolderPath("");
              }
            }}
            onSelectFolder={(folderPath) => {
              setSelectedMediaNames([]);
              setSelectedFolderPath(folderPath);
              setCurrentPage(1);
            }}
            onSelectRootFolder={handleSelectRootFolder}
            onForgetRootFolder={handleForgetRootFolder}
          />

          <div className="contentPane">
            <header className="hero">
              <div>
                <p className="eyebrow">Organize your stuff</p>
                <h1>Tagify media browser</h1>
                <p className="subtitle">
                  Server reads media files from outdir and streams content on
                  demand.
                </p>
              </div>
              <div className="paginationControls">
                <label className="itemsPerPageControl">
                  <span>Items per page</span>
                  <select
                    value={itemsPerPage}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setSelectedMediaNames([]);
                      setItemsPerPage(nextValue);
                      setCurrentPage(1);
                    }}
                  >
                    {PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </header>

            {error && (
              <p className="status error">Failed to load images: {error}</p>
            )}

            {mediaIndexProgress && (
              <MediaIndexProgressBar progress={mediaIndexProgress} />
            )}

            {isLoading && !mediaIndexProgress && (
              <div className="grid loadingGrid" aria-live="polite">
                <p className="status">Loading folder contents...</p>
              </div>
            )}

            {!mediaIndexProgress && (
              <>
                {!isLoading && !error && images.length === 0 && (
                  <p className="status">
                    No images found in {folderTree?.name ?? "outdir"}.
                  </p>
                )}

                <p className="taggingSummaryLabel" aria-live="polite">
                  Tagged media: {taggedMediaCount} | Untagged media:{" "}
                  {untaggedMediaCount}
                </p>

                <div
                  className="contentTypeFilter"
                  role="group"
                  aria-label="Content type"
                >
                  <MediaTypeFilters
                    selectedContentTypes={selectedContentTypes}
                    onToggleContentType={(contentType) => {
                      setCurrentPage(1);
                      setSelectedContentTypes((current) =>
                        current.includes(contentType)
                          ? current.filter((type) => type !== contentType)
                          : [...current, contentType],
                      );
                    }}
                  />
                  <button
                    type="button"
                    className={`untaggedButton ${showOnlyUntaggedMedia ? "active" : ""}`}
                    onClick={() => {
                      setCurrentPage(1);
                      setShowOnlyUntaggedMedia((current) => !current);
                      setShowOnlyTaggedMedia(false);
                    }}
                    aria-pressed={showOnlyUntaggedMedia}
                  >
                    Show only untagged media
                  </button>
                  <button
                    type="button"
                    className={`untaggedButton ${showOnlyTaggedMedia ? "active" : ""}`}
                    onClick={() => {
                      setCurrentPage(1);
                      setShowOnlyTaggedMedia((current) => !current);
                      setShowOnlyUntaggedMedia(false);
                    }}
                    aria-pressed={showOnlyTaggedMedia}
                  >
                    Show only tagged media
                  </button>
                </div>

                <div className="multiselectContainer m-b-20 m-t-20">
                  <h3 className="multiselectTitle">Multiselect</h3>
                  <div className="multiselectActions">
                    <button
                      type="button"
                      className="selectButton"
                      onClick={() => setSelectedMediaNames(visibleMediaNames)}
                      disabled={visibleMediaNames.length === 0}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="deselectButton"
                      onClick={() => setSelectedMediaNames([])}
                      disabled={selectedMediaNames.length === 0}
                    >
                      Deselect all
                    </button>
                    <button
                      type="button"
                      className="deselectButton"
                      onClick={() => {
                        handleDeleteTagsFromSelectedMedia();
                      }}
                      disabled={
                        selectedMediaNames.length === 0 ||
                        isDeletingTagsFromSelectedMedia
                      }
                    >
                      {isDeletingTagsFromSelectedMedia
                        ? "Deleting tags..."
                        : "Delete tags from selected media"}
                    </button>
                    <TagSuggestionInput
                      suggestions={tagNameSuggestions}
                      placeholder="Add a tag to selected media"
                      disabled={selectedMediaNames.length === 0}
                      onSubmit={handleAddTagToSelectedMedia}
                    />
                  </div>
                </div>

                <div className="tagFilterSelectionContainer m-b-20">
                  <div className="tagFilterComposer">
                    <label className="tagFilterComposerLabel">
                      Filter tags
                    </label>
                    <div className="tagFilterComposerForm">
                      <TagSuggestionInput
                        suggestions={tagNameSuggestions}
                        placeholder="Add a tag to filter"
                        onSubmit={handleAddTagToFilter}
                        submitLabel="Add tag"
                        submitOnSuggestionSelect
                      />

                      <div className="tagFilterMatchMode">
                        <span className="filterLabel">Match mode</span>
                        <ToggleSwitch
                          options={["AND", "OR"]}
                          selectedOption={filterMode}
                          disabled={tagsFilter.length === 0}
                          onChanged={(selectedOption) => {
                            setCurrentPage(1);
                            setFilterMode(selectedOption as FilterMode);
                          }}
                        />
                      </div>

                      <button
                        type="button"
                        className="deselectButton"
                        onClick={() => {
                          setCurrentPage(1);
                          setTagsFilter([]);
                        }}
                        disabled={tagsFilter.length === 0}
                      >
                        Clear selected tags
                      </button>
                    </div>

                    <div className="pillsContainer tagFilterSelectedPills">
                      {tagsFilter.map((tagName) => (
                        <Pill
                          key={tagName}
                          text={tagName}
                          color={tagColorByName[tagName] || "#ccc"}
                          onClick={() => {
                            handleDeleteTagFromFilter(tagName);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <section className="grid" aria-live="polite">
                  {filteredImages.map((image) => (
                    <ImageCard
                      key={image.name}
                      image={image}
                      onClick={setSelectedImage}
                      tagColorByName={tagColorByName}
                      isSelected={selectedMediaNames.includes(image.name)}
                      onToggleSelected={() =>
                        handleToggleSelectedMedia(image.name)
                      }
                      onPillClick={(tagName) => {
                        if (!tagsFilter.includes(tagName)) {
                          setCurrentPage(1);
                          setTagsFilter((current) => [...current, tagName]);
                        }
                      }}
                    />
                  ))}
                </section>

                {totalMediaCount > itemsPerPage && (
                  <Pagination
                    currentPage={safeCurrentPage}
                    totalPages={totalPages}
                    onPageChange={handlePageChange}
                  />
                )}

                {filteredImages.length === 0 && (
                  <p className="status">
                    No media matches the selected filters.
                  </p>
                )}
              </>
            )}

            <ImageSlideout
              image={selectedImage}
              tags={tags}
              recentAddedTags={recentlyAddedTags}
              onAddTag={handleAddTagToSelectedImage}
              onDeleteTag={handleDeleteTagFromSelectedImage}
              onDeleteMedia={handleDeleteSelectedImage}
              onOpenMedia={handleOpenSelectedImage}
              onRevealMedia={handleRevealSelectedImage}
              onPrevious={handleOpenPreviousInSlideout}
              onNext={handleOpenNextInSlideout}
              canNavigatePrevious={canNavigateToPreviousInSlideout}
              canNavigateNext={canNavigateToNextInSlideout}
              isDeletingMedia={isDeletingSelectedMedia}
              isNavigating={
                isLoading && pendingSlideoutBoundaryDirection !== null
              }
              onClose={() => setSelectedImage(null)}
            />
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
