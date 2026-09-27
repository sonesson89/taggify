import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ImageDto, Tag, TagSuggestionsResponse } from "../types";
import "./ImageSlideout.less";
import Pill from "./Pill";
import TagSuggestionInput from "./TagSuggestionInput";
import TagSuggestionsPanel from "./TagSuggestionsPanel";
import Settings from "../Settings";

const DEFAULT_PANEL_WIDTH = 672;
const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_VIEWPORT_RATIO = 0.95;
const KEYBOARD_RESIZE_STEP = 32;

type ImageSlideoutProps = {
  image: ImageDto | null;
  tags: Tag[];
  tagNameSuggestions: string[];
  recentAddedTags: string[];
  onAddTag: (tagName: string) => Promise<boolean>;
  onDeleteTag: (tagName: string) => Promise<boolean>;
  onDeleteMedia: () => Promise<boolean>;
  onOpenMedia: () => Promise<boolean>;
  onRevealMedia: () => Promise<boolean>;
  onPrevious: () => void;
  onNext: () => void;
  canNavigatePrevious: boolean;
  canNavigateNext: boolean;
  isDeletingMedia: boolean;
  isNavigating: boolean;
  onClose: () => void;
  onFetchTagSuggestions: () => Promise<TagSuggestionsResponse>;
};

function ImageSlideout({
  image,
  tags,
  tagNameSuggestions,
  recentAddedTags,
  onAddTag,
  onDeleteTag,
  onDeleteMedia,
  onOpenMedia,
  onRevealMedia,
  onPrevious,
  onNext,
  canNavigatePrevious,
  canNavigateNext,
  isDeletingMedia,
  isNavigating,
  onClose,
  onFetchTagSuggestions,
}: ImageSlideoutProps) {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isDeletingTag, setIsDeletingTag] = useState<string | null>(null);
  const [isOpeningMedia, setIsOpeningMedia] = useState<boolean>(false);
  const [isRevealingMedia, setIsRevealingMedia] = useState<boolean>(false);
  const [isCopyingImage, setIsCopyingImage] = useState<boolean>(false);
  const [copyImageStatusMessage, setCopyImageStatusMessage] =
    useState<string>("");
  const clampPanelWidth = (nextWidth: number): number => {
    const maxWidth = Math.floor(window.innerWidth * MAX_PANEL_VIEWPORT_RATIO);
    const minWidth = Math.min(MIN_PANEL_WIDTH, maxWidth);
    return Math.min(maxWidth, Math.max(minWidth, nextWidth));
  };

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_PANEL_WIDTH;
    }

    const maxWidth = Math.floor(window.innerWidth * MAX_PANEL_VIEWPORT_RATIO);
    const minWidth = Math.min(MIN_PANEL_WIDTH, maxWidth);
    return Math.min(maxWidth, Math.max(minWidth, DEFAULT_PANEL_WIDTH));
  });
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const resizeStartXRef = useRef<number>(0);
  const resizeStartWidthRef = useRef<number>(panelWidth);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const handleAddTag = async (tagName: string): Promise<boolean> => {
    if (isSubmitting) {
      return false;
    }

    setIsSubmitting(true);
    try {
      return await onAddTag(tagName);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResizePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    resizeStartXRef.current = event.clientX;
    resizeStartWidthRef.current = panelWidth;
    setIsResizing(true);
  };

  const handleResizeHandleKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPanelWidth((current) =>
        clampPanelWidth(current + KEYBOARD_RESIZE_STEP),
      );
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      setPanelWidth((current) =>
        clampPanelWidth(current - KEYBOARD_RESIZE_STEP),
      );
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      setPanelWidth(clampPanelWidth(0));
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      setPanelWidth(clampPanelWidth(Number.MAX_SAFE_INTEGER));
    }
  };

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const deltaX = resizeStartXRef.current - event.clientX;
      setPanelWidth(clampPanelWidth(resizeStartWidthRef.current + deltaX));
    };

    const handlePointerUp = () => {
      setIsResizing(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isResizing]);

  useEffect(() => {
    if (!image || image.kind !== "video") {
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (!Settings.autoPlayVideos) {
      return;
    }

    video.currentTime = 0;
    void video.play().catch(() => {
      // Browser autoplay policy may block playback without explicit interaction.
    });
  }, [image]);

  useEffect(() => {
    const handleWindowResize = () => {
      setPanelWidth((current) => clampPanelWidth(current));
    };

    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizing]);

  const handleDeleteTag = async (tagName: string) => {
    if (isDeletingTag) {
      return;
    }

    setIsDeletingTag(tagName);
    try {
      await onDeleteTag(tagName);
    } finally {
      setIsDeletingTag(null);
    }
  };

  const handleDeleteMediaClick = () => {
    if (isDeletingMedia || !image) {
      return;
    }

    const confirmed = window.confirm(
      `Are you sure you want to delete "${image.name}"? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    void onDeleteMedia();
  };

  const handleOpenMediaClick = async () => {
    if (isOpeningMedia) {
      return;
    }

    setIsOpeningMedia(true);
    try {
      await onOpenMedia();
    } finally {
      setIsOpeningMedia(false);
    }
  };

  const handleRevealMediaClick = async () => {
    if (isRevealingMedia) {
      return;
    }

    setIsRevealingMedia(true);
    try {
      await onRevealMedia();
    } finally {
      setIsRevealingMedia(false);
    }
  };

  const handleCopyImageToClipboard = async () => {
    if (!image || isCopyingImage) {
      return;
    }

    setIsCopyingImage(true);
    setCopyImageStatusMessage("");

    try {
      if (!navigator.clipboard || !("write" in navigator.clipboard)) {
        throw new Error("Copying images isn't supported in this browser.");
      }

      const response = await fetch(image.streamUrl);
      if (!response.ok) {
        throw new Error(`Failed to load image (status ${response.status}).`);
      }

      const sourceBlob = await response.blob();
      const bitmap = await createImageBitmap(sourceBlob);

      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas rendering isn't supported in this browser.");
      }
      context.drawImage(bitmap, 0, 0);

      // The Clipboard API only reliably accepts PNG for images, regardless of source format.
      const pngBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/png");
      });
      if (!pngBlob) {
        throw new Error("Failed to convert the image to PNG.");
      }

      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlob }),
      ]);

      setCopyImageStatusMessage("Copied!");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCopyImageStatusMessage(`Copy failed: ${message}`);
    } finally {
      setIsCopyingImage(false);
      window.setTimeout(() => setCopyImageStatusMessage(""), 2500);
    }
  };

  if (!image) {
    return null;
  }

  const isGifMedia =
    image.mimeType.toLowerCase() === "image/gif" ||
    image.name.toLowerCase().endsWith(".gif");
  const isCopyableImage = image.kind !== "video" && !isGifMedia;

  return (
    <>
      <button
        type="button"
        className="slideoutBackdrop"
        aria-label="Close image preview"
        onClick={onClose}
      />

      <aside
        className="slideoutPanel"
        aria-label="Image preview"
        aria-modal="true"
        style={{ width: `${panelWidth}px` }}
      >
        <button
          type="button"
          className="slideoutResizeHandle"
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeHandleKeyDown}
          aria-label="Resize preview panel"
          title="Drag to resize preview"
        >
          <span className="slideoutResizeHandleGrip" aria-hidden="true" />
        </button>

        <button
          type="button"
          className="slideoutCloseButton"
          onClick={onClose}
          disabled={isDeletingMedia}
          aria-label="Close image preview"
          title="Close"
        >
          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <div className="slideoutPanelContent">
          <div className="slideoutHeader">
            <div>
              <h2 title={image.name}>{image.name}</h2>
            </div>
            <div className="slideoutHeaderActions">
              <button
                type="button"
                className="slideoutOpenButton"
                onClick={() => handleOpenMediaClick()}
                disabled={isOpeningMedia || isRevealingMedia || isDeletingMedia}
              >
                {isOpeningMedia ? "Opening..." : "Open file"}
              </button>
              <button
                type="button"
                className="slideoutRevealButton"
                onClick={() => handleRevealMediaClick()}
                disabled={isRevealingMedia || isOpeningMedia || isDeletingMedia}
              >
                {isRevealingMedia ? "Revealing..." : "Reveal in Explorer"}
              </button>
              {isCopyableImage && (
                <button
                  type="button"
                  className="slideoutCopyButton"
                  onClick={() => handleCopyImageToClipboard()}
                  disabled={
                    isCopyingImage ||
                    isOpeningMedia ||
                    isRevealingMedia ||
                    isDeletingMedia
                  }
                  title="Copy image to clipboard"
                >
                  <span className="copyIcon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                      <path
                        d="M9 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1v-2h1V5H9v1H7V5a2 2 0 0 1 2-2Zm-3 6h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm0 2v9h9v-9H6Z"
                        fill="currentColor"
                      />
                    </svg>
                  </span>
                  <span>
                    {isCopyingImage
                      ? "Copying..."
                      : copyImageStatusMessage || "Copy"}
                  </span>
                </button>
              )}
              <button
                type="button"
                className="slideoutDeleteButton"
                onClick={handleDeleteMediaClick}
                disabled={isDeletingMedia}
              >
                <span className="trashIcon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                    <path
                      d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 7h2v8h-2v-8Zm4 0h2v8h-2v-8ZM7 10h2v8H7v-8Z"
                      fill="currentColor"
                    />
                  </svg>
                </span>
                <span>{isDeletingMedia ? "Deleting..." : "Delete media"}</span>
              </button>
            </div>
          </div>

          <div className="slideoutImageWrap">
            {image.kind === "video" ? (
              <video
                ref={videoRef}
                className="slideoutImage"
                src={image.streamUrl}
                controls
                autoPlay
                playsInline
                preload="metadata"
              />
            ) : (
              <img
                className="slideoutImage"
                src={image.streamUrl}
                alt={image.name}
              />
            )}

            <button
              type="button"
              className="slideoutImageNavButton slideoutImageNavButtonPrevious"
              onClick={onPrevious}
              disabled={!canNavigatePrevious || isNavigating}
              aria-label="Previous media"
              title="Previous"
            >
              <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                <path
                  d="M15 5l-7 7 7 7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className="slideoutImageNavButton slideoutImageNavButtonNext"
              onClick={onNext}
              disabled={!canNavigateNext || isNavigating}
              aria-label="Next media"
              title="Next"
            >
              <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                <path
                  d="M9 5l7 7-7 7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          <div className="slideoutMeta">
            <p className="slideoutCurrentTagsLabel">
              Current tags on this media
            </p>
            <div className="pillsContainer slideoutTags">
              {image.tags.map((tag) => (
                <Pill
                  key={tag}
                  text={tag}
                  color={
                    tags.find((entry) => entry.name === tag)?.color || "#ccc"
                  }
                  onClick={() => {
                    handleDeleteTag(tag);
                  }}
                />
              ))}
            </div>

            <TagSuggestionInput
              suggestions={tagNameSuggestions}
              onSubmit={handleAddTag}
              submitLabel="Add tag"
              isSubmitting={isSubmitting}
              retainFocusAfterSubmit
            />
            <TagSuggestionsPanel
              key={image.name}
              onFetchTagSuggestions={onFetchTagSuggestions}
              onAcceptSuggestion={handleAddTag}
              isSubmitting={isSubmitting}
            />
            {recentAddedTags.length > 0 && (
              <div className="slideoutRecentTags" aria-label="Recent tags">
                <p className="slideoutRecentTagsLabel">Recently added</p>
                <div className="slideoutRecentTagsList">
                  {recentAddedTags.map((tagName) => (
                    <button
                      key={tagName}
                      type="button"
                      className={`slideoutRecentTagButton ${image.tags.includes(tagName) ? "alreadyAdded" : ""}`}
                      onClick={() => {
                        void handleAddTag(tagName);
                      }}
                      disabled={isSubmitting || image.tags.includes(tagName)}
                      aria-disabled={
                        isSubmitting || image.tags.includes(tagName)
                      }
                    >
                      {tagName}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

export default ImageSlideout;
