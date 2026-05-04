import React, { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface JsonTreeViewProps {
  data: any;
  label?: string;
  isLast?: boolean;
  depth?: number;
  initialExpanded?: boolean;
}

export function JsonTreeView({
  data,
  label,
  isLast = true,
  depth = 0,
  initialExpanded = true,
}: JsonTreeViewProps) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);

  const isObject = typeof data === "object" && data !== null;
  const isArray = Array.isArray(data);
  const isEmpty = isObject && (isArray ? data.length === 0 : Object.keys(data).length === 0);

  const toggleExpand = () => {
    if (isObject && !isEmpty) {
      setIsExpanded(!isExpanded);
    }
  };

  const renderValue = (val: any) => {
    if (typeof val === "string") return <span className="json-value-string">"{val}"</span>;
    if (typeof val === "number") return <span className="json-value-number">{val}</span>;
    if (typeof val === "boolean") return <span className="json-value-boolean">{val.toString()}</span>;
    if (val === null) return <span className="json-value-null">null</span>;
    return null;
  };

  const getPreview = () => {
    if (isArray) return `Array(${data.length})`;
    if (isObject) return `Object(${Object.keys(data).length})`;
    return "";
  };

  return (
    <div className="json-tree-node" style={{ paddingLeft: depth > 0 ? "20px" : "0" }}>
      <div 
        className={cn(
          "json-tree-header", 
          isObject && !isEmpty && "json-tree-clickable"
        )}
        onClick={toggleExpand}
      >
        {isObject && !isEmpty && (
          <span className="json-tree-toggle">
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        )}
        
        {label && (
          <span className="json-tree-label">
            {label}:
          </span>
        )}

        {!isExpanded && isObject && !isEmpty ? (
          <span className="json-tree-preview">
            {isArray ? "[...]" : "{...}"}
            <span className="json-tree-meta"> {getPreview()}</span>
          </span>
        ) : !isObject ? (
          <span className="json-tree-value">
            {renderValue(data)}
            {!isLast && <span className="json-tree-comma">,</span>}
          </span>
        ) : (
          <span className="json-tree-bracket">
            {isArray ? "[" : "{"}
            {isEmpty && (isArray ? "]" : "}")}
            {!isExpanded && isEmpty && !isLast && <span className="json-tree-comma">,</span>}
          </span>
        )}
      </div>

      {isExpanded && isObject && !isEmpty && (
        <div className="json-tree-children">
          {isArray ? (
            data.map((item: any, index: number) => (
              <JsonTreeView
                key={index}
                data={item}
                isLast={index === data.length - 1}
                depth={depth + 1}
                initialExpanded={depth < 2} // Auto-expand first few levels
              />
            ))
          ) : (
            Object.entries(data).map(([key, value], index, entries) => (
              <JsonTreeView
                key={key}
                label={key}
                data={value}
                isLast={index === entries.length - 1}
                depth={depth + 1}
                initialExpanded={depth < 2}
              />
            ))
          )}
        </div>
      )}

      {isExpanded && isObject && !isEmpty && (
        <div className="json-tree-footer">
          <span className="json-tree-bracket">
            {isArray ? "]" : "}"}
            {!isLast && <span className="json-tree-comma">,</span>}
          </span>
        </div>
      )}
    </div>
  );
}
