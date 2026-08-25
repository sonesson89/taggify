import { useMemo } from "react";

type PaginationProps = {
  currentPage: number;
  totalPages: number;
  onPageChange: (nextPage: number) => void;
};

function Pagination({
  currentPage,
  totalPages,
  onPageChange,
}: PaginationProps) {
  const pageOptions = useMemo(
    () => Array.from({ length: totalPages }, (_, index) => index + 1),
    [totalPages],
  );

  const paginationPages = useMemo(() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    const pages = new Set<number>([1, totalPages]);
    [
      currentPage - 2,
      currentPage - 1,
      currentPage,
      currentPage + 1,
      currentPage + 2,
    ].forEach((page) => {
      if (page > 1 && page < totalPages) {
        pages.add(page);
      }
    });

    const pageList = Array.from(pages).sort((left, right) => left - right);
    const compactPages: Array<number | "ellipsis"> = [];
    let previousPage: number | null = null;

    pageList.forEach((page) => {
      if (previousPage !== null && page - previousPage > 1) {
        compactPages.push("ellipsis");
      }
      compactPages.push(page);
      previousPage = page;
    });

    return compactPages;
  }, [currentPage, totalPages]);

  if (totalPages <= 1) {
    return null;
  }

  return (
    <div className="pagination" aria-label="Media pagination">
      <button
        type="button"
        className="paginationButton"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
      >
        Previous
      </button>

      <div className="paginationNumbers" role="group" aria-label="Page numbers">
        {paginationPages.map((page, index) => {
          if (page === "ellipsis") {
            return (
              <span
                key={`ellipsis-${index}`}
                className="paginationEllipsis"
                aria-hidden="true"
              >
                ...
              </span>
            );
          }

          const pageNumber = page;
          const isCurrentPage = pageNumber === currentPage;

          return (
            <button
              key={pageNumber}
              type="button"
              className={`paginationNumberButton ${isCurrentPage ? "active" : ""}`}
              onClick={() => onPageChange(pageNumber)}
              aria-label={`Go to page ${pageNumber}`}
              aria-current={isCurrentPage ? "page" : undefined}
            >
              {pageNumber}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="paginationButton"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
      >
        Next
      </button>

      <label className="paginationJumpTo" aria-label="Jump to specific page">
        <span>Jump to</span>
        <select
          value={currentPage}
          onChange={(event) => {
            onPageChange(Number(event.target.value));
          }}
        >
          {pageOptions.map((pageNumber) => (
            <option key={pageNumber} value={pageNumber}>
              {pageNumber}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export default Pagination;
