import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { scaleLog } from "@visx/scale";
import { Text } from "@visx/text";
import { Wordcloud } from "@visx/wordcloud";
import type { Tag } from "../types";
import "./AllTagsModal.less";

const MIN_FONT_SIZE = 14;
const MAX_FONT_SIZE = 96;
const FALLBACK_TAG_COLOR = "#2e6f40";

// Fixed "random" seed so the cloud layout is stable across re-renders instead of
// reshuffling every time (the layout algorithm otherwise re-randomizes placement order).
const fixedRandomSeed = () => 0.5;

type AllTagsModalProps = {
  tags: Tag[];
  selectedTagNames: string[];
  onClose: () => void;
  onSelectTag: (tagName: string) => void;
};

type WordDatum = {
  text: string;
  value: number;
};

function AllTagsModal({
  tags,
  selectedTagNames,
  onClose,
  onSelectTag,
}: AllTagsModalProps) {
  const cloudContainerRef = useRef<HTMLDivElement | null>(null);
  const [cloudSize, setCloudSize] = useState<{
    width: number;
    height: number;
  }>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const container = cloudContainerRef.current;
    if (!container) {
      return;
    }

    const updateSize = () => {
      setCloudSize({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };

    updateSize();

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const colorByTagName = useMemo(
    () => Object.fromEntries(tags.map((tag) => [tag.name, tag.color])),
    [tags],
  );

  const countByTagName = useMemo(
    () => Object.fromEntries(tags.map((tag) => [tag.name, tag.occurenceCount])),
    [tags],
  );

  const selectedTagNameSet = useMemo(
    () => new Set(selectedTagNames),
    [selectedTagNames],
  );

  const words: WordDatum[] = useMemo(
    () => tags.map((tag) => ({ text: tag.name, value: tag.occurenceCount })),
    [tags],
  );

  const fontScale = useMemo(() => {
    const values = words.map((word) => word.value);
    const minValue = values.length > 0 ? Math.min(...values) : 1;
    const maxValue = values.length > 0 ? Math.max(...values) : 1;

    return scaleLog({
      domain: [Math.max(1, minValue), Math.max(1, maxValue)],
      range: [MIN_FONT_SIZE, MAX_FONT_SIZE],
    });
  }, [words]);

  return (
    <>
      <button
        type="button"
        className="allTagsModalBackdrop"
        aria-label="Close all tags"
        onClick={onClose}
      />

      <div
        className="allTagsModalPanel"
        role="dialog"
        aria-modal="true"
        aria-label="All tags"
      >
        <div className="allTagsModalHeader">
          <h2>All tags</h2>
          <button
            type="button"
            className="allTagsModalCloseButton"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {words.length === 0 ? (
          <p className="allTagsModalEmptyStatus">No tags yet.</p>
        ) : (
          <div className="allTagsModalCloud">
            <div className="allTagsModalCloudInner" ref={cloudContainerRef}>
              {cloudSize.width > 0 && cloudSize.height > 0 && (
                <Wordcloud
                  words={words}
                  width={cloudSize.width}
                  height={cloudSize.height}
                  fontSize={(word) => fontScale(word.value ?? 1)}
                  padding={6}
                  spiral="archimedean"
                  rotate={0}
                  random={fixedRandomSeed}
                >
                  {(cloudWords) =>
                    cloudWords.map((word) => {
                      const tagName = word.text ?? "";
                      const isSelected = selectedTagNameSet.has(tagName);

                      return (
                        <g
                          key={word.text}
                          className={`allTagsModalWord${isSelected ? " isSelected" : ""}`}
                          transform={`translate(${word.x}, ${word.y}) rotate(${word.rotate})`}
                          onClick={() => onSelectTag(tagName)}
                        >
                          <title>
                            {`${tagName} — used ${countByTagName[tagName] ?? 0} time${countByTagName[tagName] === 1 ? "" : "s"}`}
                          </title>
                          <Text
                            className="allTagsModalWordText"
                            textAnchor="middle"
                            fontSize={word.size}
                            fontFamily={word.font}
                            fontWeight={600}
                            fill={colorByTagName[tagName] || FALLBACK_TAG_COLOR}
                          >
                            {tagName}
                          </Text>
                        </g>
                      );
                    })
                  }
                </Wordcloud>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default AllTagsModal;

