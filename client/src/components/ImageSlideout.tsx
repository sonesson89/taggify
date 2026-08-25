import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ImageDto, Tag } from "../types";
import "./ImageSlideout.less";
import Pill from "./Pill";
import TagSuggestionInput from "./TagSuggestionInput";
import Settings from "../Settings";

const DEFAULT_PANEL_WIDTH = 672;
const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_VIEWPORT_RATIO = 0.95;
const KEYBOARD_RESIZE_STEP = 32;

type ImageSlideoutProps = {
  image: ImageDto | null;
  tags: Tag[];
  recentAddedTags: string[];
  onAddTag: (tagName: string) => Promise<boolean>;
  onDeleteTag: (tagName: string) => Promise<boolean>;
  onDeleteMedia: () => Promise<boolean>;
  onPrevious: () => void;
  onNext: () => void;
  canNavigatePrevious: boolean;
  canNavigateNext: boolean;
  isDeletingMedia: boolean;
  isNavigating: boolean;
  onClose: () => void;
};

function ImageSlideout({
  image,
  tags,
  recentAddedTags,
  onAddTag,
  onDeleteTag,
  onDeleteMedia,
  onPrevious,
  onNext,
  canNavigatePrevious,
  canNavigateNext,
  isDeletingMedia,
  isNavigating,
  onClose,
}: ImageSlideoutProps) {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isDeletingTag, setIsDeletingTag] = useState<string | null>(null);
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

  const suggestionNames = useMemo(
    () =>
      tags
        .map((tag) => tag.name)
        .sort((left, right) => left.localeCompare(right)),
    [tags],
  );

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

  if (!image) {
    return null;
  }

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

        <div className="slideoutPanelContent">
          <div className="slideoutHeader">
            <div>
              <p className="slideoutEyebrow">Preview</p>
              <h2>{image.name}</h2>
            </div>
            <div className="slideoutHeaderActions">
              <button
                type="button"
                className="slideoutNavButton"
                onClick={onPrevious}
                disabled={!canNavigatePrevious || isNavigating}
              >
                Previous
              </button>
              <button
                type="button"
                className="slideoutNavButton"
                onClick={onNext}
                disabled={!canNavigateNext || isNavigating}
              >
                Next
              </button>
              <button
                type="button"
                className="slideoutCloseButton"
                onClick={onClose}
                disabled={isDeletingMedia}
              >
                Close
              </button>
              <button
                type="button"
                className="slideoutDeleteButton"
                onClick={handleDeleteMediaClick}
                disabled={isDeletingMedia}
              >
                {isDeletingMedia ? "Deleting..." : "Delete media"}
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
          </div>

          <div className="slideoutMeta">
            <h3>Tags</h3>
            <p className="slideoutCurrentTagsLabel">Current tags on this media</p>
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
              suggestions={suggestionNames}
              onSubmit={handleAddTag}
              submitLabel="Add tag"
              isSubmitting={isSubmitting}
              retainFocusAfterSubmit
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
                      aria-disabled={isSubmitting || image.tags.includes(tagName)}
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
