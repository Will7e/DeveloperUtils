import { useState, useCallback } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { METHODS } from "../../constants";
import type { HttpMethod } from "@/stores/api-tester.store";

export function MethodDropdown({
  value,
  onChange,
}: {
  value: HttpMethod;
  onChange: (val: HttpMethod) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const dropdownRef = useClickOutside<HTMLDivElement>(close, isOpen);

  const methodSelectClass = `api-method-select api-method-select-${value.toLowerCase()}`;

  return (
    <div className="api-method-dropdown-container" ref={dropdownRef}>
      <button
        type="button"
        className={methodSelectClass}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{value}</span>
        <ChevronDown
          className={`h-3 w-3 opacity-70 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {isOpen && (
        <div className="api-method-dropdown-menu">
          {METHODS.map((m) => (
            <button
              key={m}
              type="button"
              className={`api-method-option api-method-option-${m.toLowerCase()} ${
                m === value ? "api-method-option-active" : ""
              }`}
              onClick={() => {
                onChange(m);
                setIsOpen(false);
              }}
            >
              {m}
              {m === value && (
                <Check className="h-3 w-3 ml-auto opacity-70" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
