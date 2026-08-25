import type { FolderNode } from "../types";

type FolderNavigationProps = {
  folderTree: FolderNode | null;
  isOpen: boolean;
  selectedFolderPath: string;
  showAllRecursively: boolean;
  onTogglePanel: () => void;
  onToggleShowAll: (nextValue: boolean) => void;
  onSelectFolder: (folderPath: string) => void;
  onSelectRootFolder: () => void;
  onForgetRootFolder: () => void;
};

function FolderNavigation({
  folderTree,
  isOpen,
  selectedFolderPath,
  showAllRecursively,
  onTogglePanel,
  onToggleShowAll,
  onSelectFolder,
  onSelectRootFolder,
  onForgetRootFolder,
}: FolderNavigationProps) {
  const selectedFolderLabel =
    showAllRecursively || !selectedFolderPath
      ? folderTree?.name ?? "outdir"
      : selectedFolderPath.split("/").filter(Boolean).at(-1) ?? folderTree?.name ?? "outdir";

  const ImageIcon = () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="2.2" />
      <path d="M5 16l4.2-4.2 3.1 3.1 3.8-4.9 3.9 6H5Z" />
    </svg>
  );

  const VideoIcon = () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="13" height="14" rx="2.5" />
      <path d="M16 10l5-3v10l-5-3v-4Z" />
    </svg>
  );

  const GifIcon = () => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M8.5 10.5h1.3v3.6H8.5v-1.3H7.2v-1h1.3v-1.3Zm3.2 0h3.2v1.2h-2v1h1.7v1.1h-1.7v1.2h-1.3v-4.5Zm5.1 0h1.6v1.1h-1.6v3.4h-1.3v-3.4h-1.6v-1.1h4.5Z" />
    </svg>
  );

  const renderFolderBranch = (node: FolderNode, depth = 0) => {
    const isSelected = showAllRecursively ? node.relativePath === "" : node.relativePath === selectedFolderPath;
    const isDisabled = showAllRecursively;
    const folderStats = [
      { key: "image", count: node.imageCount, label: "images", icon: ImageIcon },
      { key: "gif", count: node.gifCount, label: "gifs", icon: GifIcon },
      { key: "video", count: node.videoCount, label: "videos", icon: VideoIcon },
    ];

    return (
      <div key={node.relativePath || node.name} className="folderNode">
        <button
          type="button"
          className={`folderNodeButton ${isSelected ? "selected" : ""} ${isDisabled ? "disabled" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 12}px` }}
          onClick={() => {
            if (showAllRecursively) {
              return;
            }
            onSelectFolder(node.relativePath);
          }}
          disabled={isDisabled}
        >
          <span className="folderNameText">{node.name}</span>
          <span className="folderCountText" aria-label={`${node.imageCount} images, ${node.gifCount} gifs, ${node.videoCount} videos`}>
            {folderStats.map(({ key, count, label, icon: Icon }) => (
              <span key={key} className="folderStatItem" title={`${count} ${label}`}>
                <span className="folderStatIcon">
                  <Icon />
                </span>
                <span className="folderStatValue">{count}</span>
              </span>
            ))}
          </span>
        </button>
        {node.children.length > 0 && (
          <div className="folderChildren">
            {node.children.map((child) => renderFolderBranch(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className={`folderSidebar ${isOpen ? "open" : "collapsed"}`}>
      <div className="folderSidebarMain">
        <div className="folderSidebarHeader">
          <div className="folderSidebarHeaderActions">
            <button
              type="button"
              className="folderPanelToggle"
              onClick={onTogglePanel}
            >
              {isOpen ? "Hide folders" : "Show folders"}
            </button>

            {isOpen && (
              <label className="showAllToggle">
                <input
                  type="checkbox"
                  checked={showAllRecursively}
                  onChange={(event) => onToggleShowAll(event.target.checked)}
                />
                <span>show all recursively</span>
              </label>
            )}
          </div>
        </div>

        {isOpen && (
          <>
            <div className="selectedFolderLabel">Current: {selectedFolderLabel}</div>
            {folderTree ? (
              <div className="folderTree">{renderFolderBranch(folderTree)}</div>
            ) : (
              <p className="status">Loading folders...</p>
            )}
          </>
        )}
      </div>

      {isOpen && (
        <div className="folderSidebarFooter">
          <button
            type="button"
            className="selectRootFolderButton"
            onClick={onSelectRootFolder}
          >
            Select root folder
          </button>
          <button
            type="button"
            className="forgetRootFolderButton"
            onClick={onForgetRootFolder}
          >
            Forget folder
          </button>
        </div>
      )}
    </aside>
  );
}

export default FolderNavigation;
