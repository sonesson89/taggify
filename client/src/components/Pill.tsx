const Pill = ({
  text,
  onClick,
  color,
  showRemoveIcon = true,
  title = "Delete tag",
  style,
}: {
  text: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  color: string;
  showRemoveIcon?: boolean;
  title?: string;
  style?: React.CSSProperties;
}) => {
  return (
    <button
      type="button"
      className="imagePill clickable imagePillDelete"
      style={{
        backgroundColor: color,
        ...style,
      }}
      onClick={onClick}
      title={title}
    >
      <span>{text}</span>
      {showRemoveIcon && (
        <span className="trashIcon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
            <path
              d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 7h2v8h-2v-8Zm4 0h2v8h-2v-8ZM7 10h2v8H7v-8Z"
              fill="currentColor"
            />
          </svg>
        </span>
      )}
    </button>
  );
};

export default Pill;

