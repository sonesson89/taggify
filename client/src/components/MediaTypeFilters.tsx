type ContentType = "image" | "video" | "gif";

type MediaTypeFiltersProps = {
  selectedContentTypes: ContentType[];
  disabled?: boolean;
  onToggleContentType: (contentType: ContentType) => void;
};

const MediaTypeFilters = ({
  selectedContentTypes,
  disabled = false,
  onToggleContentType,
}: MediaTypeFiltersProps) => {
  return (
    <>
      <button
        type="button"
        className={`contentTypeOption ${selectedContentTypes.includes("image") ? "active" : ""}`}
        onClick={() => {
          onToggleContentType("image");
        }}
        disabled={disabled}
      >
        Image
      </button>
      <button
        type="button"
        className={`contentTypeOption ${selectedContentTypes.includes("video") ? "active" : ""}`}
        onClick={() => {
          onToggleContentType("video");
        }}
        disabled={disabled}
      >
        Video
      </button>
      <button
        type="button"
        className={`contentTypeOption ${selectedContentTypes.includes("gif") ? "active" : ""}`}
        onClick={() => {
          onToggleContentType("gif");
        }}
        disabled={disabled}
      >
        GIF
      </button>
    </>
  );
};

export default MediaTypeFilters;
export type { ContentType };
