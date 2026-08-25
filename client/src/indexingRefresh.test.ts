import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { coalesceScheduledIndexRefresh } from "./indexingRefresh";

describe("coalesceScheduledIndexRefresh", () => {
  it("clears the prior timer before scheduling the next index refresh", () => {
    const clearedTimers: number[] = [];
    let nextTimerId = 100;

    const fakeSetTimeout = (_callback: () => void, _delayMs: number) => {
      nextTimerId += 1;
      return nextTimerId;
    };

    const fakeClearTimeout = (timerId: number) => {
      clearedTimers.push(timerId);
    };

    const timeoutRef = { current: 101 as number | null };

    const firstTimer = coalesceScheduledIndexRefresh({
      timeoutRef,
      delayMs: 750,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
      onTrigger: () => undefined,
    });

    const secondTimer = coalesceScheduledIndexRefresh({
      timeoutRef,
      delayMs: 750,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClearTimeout,
      onTrigger: () => undefined,
    });

    assert.equal(firstTimer, 101);
    assert.equal(secondTimer, 102);
    assert.deepEqual(clearedTimers, [101, 101]);
    assert.equal(timeoutRef.current, 102);
  });
});
