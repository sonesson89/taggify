export type IndexRefreshTimerRef = {
  current: number | null | undefined;
};

export type CoalesceScheduledIndexRefreshOptions = {
  timeoutRef: IndexRefreshTimerRef;
  delayMs: number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => number;
  clearTimeoutFn?: (timerId: number) => void;
  onTrigger: () => void;
};

export const coalesceScheduledIndexRefresh = ({
  timeoutRef,
  delayMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onTrigger,
}: CoalesceScheduledIndexRefreshOptions): number => {
  if (typeof timeoutRef.current === "number") {
    clearTimeoutFn(timeoutRef.current);
  }

  const nextTimerId = setTimeoutFn(() => {
    timeoutRef.current = null;
    onTrigger();
  }, delayMs);

  timeoutRef.current = nextTimerId;
  return nextTimerId;
};
