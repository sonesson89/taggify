import { useId, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

type TagSuggestionInputProps = {
  suggestions: string[];
  onSubmit: (value: string) => boolean | Promise<boolean>;

  submitLabel?: string;
  placeholder?: string;
  isSubmitting?: boolean;
  disabled?: boolean;
  submitOnSuggestionSelect?: boolean;
  retainFocusAfterSubmit?: boolean;
};

const TagSuggestionInput = ({
  suggestions,
  onSubmit,
  submitLabel = "Add tag",
  placeholder = "Add a tag",
  isSubmitting = false,
  disabled = false,
  submitOnSuggestionSelect = false,
  retainFocusAfterSubmit = false,
}: TagSuggestionInputProps) => {
  const [value, setValue] = useState<string>("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generatedId = useId().replace(/:/g, "");
  const resolvedListId = `tag-suggestions-${generatedId}`;
  const isSubmitDisabled =
    disabled || isSubmitting || value.trim().length === 0;

  const handleSubmit = async (submittedValue?: string) => {
    if (isSubmitDisabled) {
      return;
    }

    const candidate = (submittedValue ?? value).trim();
    if (!candidate) {
      return;
    }

    try {
      const added = await onSubmit(candidate);
      if (added) {
        setValue("");
      }
    } finally {
      if (retainFocusAfterSubmit) {
        inputRef.current?.focus();
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void handleSubmit();
    }
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value;
    setValue(nextValue);

    const selectedFromSuggestions =
      submitOnSuggestionSelect &&
      event.nativeEvent instanceof InputEvent &&
      event.nativeEvent.inputType === "insertReplacementText";

    if (!selectedFromSuggestions) {
      return;
    }

    void handleSubmit(nextValue);
  };

  return (
    <div className="tagSuggestionInput">
      <input
        ref={inputRef}
        className={`tagSuggestionInputField ${disabled || isSubmitting ? "disabled" : ""}`}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        list={resolvedListId}
        disabled={disabled || (!retainFocusAfterSubmit && isSubmitting)}
        readOnly={retainFocusAfterSubmit && isSubmitting}
      />

      <datalist id={resolvedListId}>
        {suggestions.map((tagName) => (
          <option key={tagName} value={tagName} />
        ))}
      </datalist>

      <button
        type="button"
        className="tagSuggestionInputButton"
        onClick={() => {
          void handleSubmit();
        }}
        disabled={isSubmitDisabled}
      >
        {submitLabel}
      </button>
    </div>
  );
};

export default TagSuggestionInput;
