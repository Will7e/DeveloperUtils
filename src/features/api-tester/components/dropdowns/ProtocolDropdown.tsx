import { useState, useCallback } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { PROTOCOLS, type ApiProtocol } from "../../constants";

export function ProtocolDropdown({
  value,
  onChange,
}: {
  value: ApiProtocol;
  onChange: (val: ApiProtocol) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const dropdownRef = useClickOutside<HTMLDivElement>(close, isOpen);

  const activeProto = (PROTOCOLS.find((p) => p.id === value) || PROTOCOLS[0])!;
  const ActiveIcon = activeProto.icon;

  return (
    <div
      className="api-method-dropdown-container"
      ref={dropdownRef}
      style={{ width: "130px", flexShrink: 0 }}
    >
      <button
        type="button"
        className={`api-method-select ${isOpen ? "api-method-select-open" : ""}`}
        style={{ width: "100%" }}
        onClick={() => setIsOpen(!isOpen)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <ActiveIcon className="h-4 w-4" />
          <span style={{ fontWeight: 600 }}>{activeProto.label}</span>
        </div>
        <ChevronDown
          className={`h-3 w-3 opacity-70 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {isOpen && (
        <div className="api-method-dropdown-menu" style={{ width: "100%" }}>
          {PROTOCOLS.map((p) => {
            const Icon = p.icon;
            return (
              <button
                key={p.id}
                type="button"
                className={`api-method-option api-method-option-get ${
                  p.id === value ? "api-method-option-active" : ""
                }`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 12px",
                  color: "var(--text-1)",
                }}
                onClick={() => {
                  onChange(p.id);
                  setIsOpen(false);
                }}
              >
                <Icon className="h-4 w-4 opacity-70" />
                <span style={{ fontWeight: 500 }}>{p.label}</span>
                {p.id === value && (
                  <Check className="h-3 w-3 ml-auto text-accent" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
