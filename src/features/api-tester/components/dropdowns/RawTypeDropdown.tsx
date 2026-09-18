import { useState, useCallback } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { RAW_TYPES } from "../../constants";

export function RawTypeDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (val: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const dropdownRef = useClickOutside<HTMLDivElement>(close, isOpen);

  const activeLabel = RAW_TYPES.find((t) => t.value === value)?.label || "Text";

  return (
    <div className="api-raw-dropdown-container" ref={dropdownRef}>
      <button
        type="button"
        className="api-raw-select"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{activeLabel}</span>
        <ChevronDown
          className={`h-3 w-3 opacity-70 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {isOpen && (
        <div className="api-raw-dropdown-menu">
          {RAW_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`api-raw-option ${
                t.value === value ? "api-raw-option-active" : ""
              }`}
              onClick={() => {
                onChange(t.value);
                setIsOpen(false);
              }}
            >
              {t.label}
              {t.value === value && (
                <Check className="h-3 w-3 ml-auto opacity-70" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
