import type { ImageDto } from "../types";
import Pill from "./Pill";

type ImageCardProps = {
  image: ImageDto;
  onClick: (image: ImageDto) => void;
  tagColorByName: Record<string, string>;
  isSelected: boolean;
  onToggleSelected: () => void;
  onPillClick?: (tagName: string) => void;
};

function ImageCard({
  image,
  onClick,
  tagColorByName,
  isSelected,
  onToggleSelected,
  onPillClick,
}: ImageCardProps) {
  const isGif =
    image.mimeType.toLowerCase() === "image/gif" ||
    image.name.toLowerCase().endsWith(".gif");
  const showVideoBadge = image.kind === "video" && !isGif;
  const hasTags = image.tags.length > 0;

  return (
    <article
      className="card cardClickable"
      onClick={() => onClick(image)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick(image);
        }
      }}
    >
      <div className="pillsContainer">
        {hasTags ? (
          image.tags.map((tag) => (
            <Pill
              key={tag}
              text={tag}
              color={tagColorByName[tag] || "#ccc"}
              onClick={(event) => {
                event.stopPropagation();
                if (onPillClick) {
                  onPillClick(tag);
                }
              }}
              showRemoveIcon={false}
            />
          ))
        ) : (
          <span className="imagePill untaggedPill" aria-label="Untagged media">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="warningIcon">
              <path
                d="M12 3.5 21 19a1.5 1.5 0 0 1-1.3 2.2H4.3A1.5 1.5 0 0 1 3 19L12 3.5Zm0 6.2v4.6m0 3.5h.01"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Untagged media
          </span>
        )}
      </div>
      <div className="mediaWrap">
        <label
          className="mediaSelectOverlay"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            className="mediaSelectCheckbox"
            checked={isSelected}
            onChange={onToggleSelected}
            aria-label={`Select ${image.name}`}
          />
        </label>
        {image.kind === "video" ? (
          <video src={image.streamUrl} preload="metadata" muted playsInline />
        ) : (
          <img src={image.streamUrl} alt={image.name} loading="lazy" />
        )}
        {showVideoBadge && (
          <span className="videoBadge" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false" role="presentation">
              <path d="M8 6.5v11l9-5.5-9-5.5z" />
            </svg>
          </span>
        )}
      </div>
      <footer>
        <p>{image.name}</p>
      </footer>
    </article>
  );
}

export default ImageCard;
