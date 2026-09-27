import { useEffect, useState } from "react";
import type { TagSuggestion, TagSuggestionsResponse } from "../types";
import "./TagSuggestionsPanel.less";

type TagSuggestionsPanelProps = {
  onFetchTagSuggestions: () => Promise<TagSuggestionsResponse>;
  onAcceptSuggestion: (tagName: string) => Promise<boolean>;
  isSubmitting: boolean;
};

// Mount with a `key` tied to the media name so each media item gets a fresh instance
// (and therefore fresh suggestion state) instead of manually resetting state in an effect.
function TagSuggestionsPanel({
  onFetchTagSuggestions,
  onAcceptSuggestion,
  isSubmitting,
}: TagSuggestionsPanelProps) {
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [dismissedTags, setDismissedTags] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isModelLoading, setIsModelLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let isCancelled = false;

    const fetchSuggestions = async () => {
      try {
        const response = await onFetchTagSuggestions();
        if (isCancelled) {
          return;
        }

        setIsModelLoading(Boolean(response.modelLoading));
        setSuggestions(response.suggestions ?? []);
      } catch (err) {
        if (isCancelled) {
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    void fetchSuggestions();

    return () => {
      isCancelled = true;
    };
  }, [onFetchTagSuggestions]);

  const visibleSuggestions = suggestions.filter(
    (suggestion) => !dismissedTags.includes(suggestion.tag),
  );

  const handleAccept = async (tagName: string) => {
    const wasAdded = await onAcceptSuggestion(tagName);
    if (wasAdded) {
      setSuggestions((current) =>
        current.filter((suggestion) => suggestion.tag !== tagName),
      );
    }
  };

  const handleDismiss = (tagName: string) => {
    setDismissedTags((current) => [...current, tagName]);
  };

  return (
    <div className="slideoutSuggestedTags" aria-live="polite">
      <p className="slideoutSuggestedTagsLabel">Suggested tags (local AI)</p>
      {isModelLoading && (
        <p className="slideoutSuggestedTagsStatus">
          Loading local suggestion model (first run only)...
        </p>
      )}
      {!isModelLoading && isLoading && (
        <p className="slideoutSuggestedTagsStatus">
          Analyzing media for tag suggestions...
        </p>
      )}
      {!isLoading && error && (
        <p className="slideoutSuggestedTagsStatus error">{error}</p>
      )}
      {!isLoading &&
        !isModelLoading &&
        !error &&
        visibleSuggestions.length === 0 && (
          <p className="slideoutSuggestedTagsStatus">
            No suggestions right now. Tag a few more items so the model has
            something to learn from.
          </p>
        )}
      <div className="slideoutSuggestedTagsList">
        {visibleSuggestions.map((suggestion) => (
          <span key={suggestion.tag} className="slideoutSuggestionPill">
            <button
              type="button"
              className="slideoutSuggestionAccept"
              onClick={() => void handleAccept(suggestion.tag)}
              disabled={isSubmitting}
              title={`Confidence: ${Math.round(suggestion.score * 100)}%`}
            >
              + {suggestion.tag}
            </button>
            <button
              type="button"
              className="slideoutSuggestionDismiss"
              onClick={() => handleDismiss(suggestion.tag)}
              aria-label={`Dismiss suggestion ${suggestion.tag}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

export default TagSuggestionsPanel;
