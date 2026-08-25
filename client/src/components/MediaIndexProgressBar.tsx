type MediaIndexProgressValue = {
  status: string;
  current: number;
  total: number;
  percent: number;
  indexedFiles: number;
};

type MediaIndexProgressBarProps = {
  progress: MediaIndexProgressValue;
};

const MediaIndexProgressBar = ({ progress }: MediaIndexProgressBarProps) => {
  const total = Math.max(progress.total, progress.current, 1);
  const percent = Math.max(
    0,
    Math.min(
      100,
      progress.percent || Math.round((progress.current / total) * 100),
    ),
  );
  const label =
    progress.total > 0
      ? `Indexing media (${progress.current}/${progress.total})`
      : "Indexing media...";

  return (
    <div className="mediaIndexProgress" aria-live="polite">
      <div className="mediaIndexProgressHeader">
        <span>{label}</span>
        <span>{percent}%</span>
      </div>

      <div
        className="mediaIndexProgressBarTrack"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label}
      >
        <div
          className="mediaIndexProgressBarFill"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="mediaIndexProgressMeta">
        <span>{progress.indexedFiles} indexed</span>
        <span>{progress.status}</span>
      </div>
    </div>
  );
};

export default MediaIndexProgressBar;
