import { useState, useCallback } from "react";
import { useClickOutside } from "../hooks/useClickOutside";

export function AutocompleteInput({
  value,
  onChange,
  placeholder,
  options,
  className,
}: {
  value: string;
  onChange: (val: string) => void;
  placeholder: string;
  options: string[];
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const close = useCallback(() => setIsOpen(false), []);
  const containerRef = useClickOutside<HTMLDivElement>(close, isOpen);

  const filteredOptions = searchTerm
    ? options.filter((o) =>
        o.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : options;

  return (
    <div className="api-autocomplete-container" ref={containerRef}>
      <input
        type="text"
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setSearchTerm(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => {
          setSearchTerm("");
          setIsOpen(true);
        }}
      />
      {isOpen && filteredOptions.length > 0 && (
        <div className="api-autocomplete-menu">
          {filteredOptions.map((opt) => (
            <button
              key={opt}
              type="button"
              className="api-autocomplete-option"
              onClick={() => {
                onChange(opt);
                setIsOpen(false);
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
