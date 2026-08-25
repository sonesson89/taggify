type ToggleSwitchProps = {
  options: string[];
  selectedOption: string;
  disabled: boolean;
  onChanged: (selectedOption: string) => void;
};

const ToggleSwitch = ({
  options,
  selectedOption,
  disabled,
  onChanged,
}: ToggleSwitchProps) => {
  if (options.length === 0) {
    return null;
  }

  return (
    <div className="modeSwitch" role="group" aria-label="Toggle options">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`modeOption ${selectedOption === option ? "active" : ""}`}
          onClick={() => {
            onChanged(option);
          }}
          disabled={disabled}
          aria-pressed={selectedOption === option}
        >
          {option}
        </button>
      ))}
    </div>
  );
};

export default ToggleSwitch;
