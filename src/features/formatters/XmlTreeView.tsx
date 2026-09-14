import React, { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { XmlTreeNode } from "./xmlUtils";

interface XmlTreeViewProps {
  data: XmlTreeNode | string;
  depth?: number;
}

export function XmlTreeView({
  data,
  depth = 0,
}: XmlTreeViewProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (typeof data === "string") {
    return <span className="xml-text-node">{data}</span>;
  }

  const hasChildren = !!(data._children && data._children.length > 0);
  const hasValue = data._value !== undefined;
  const hasAttributes = !!(data._attributes && Object.keys(data._attributes).length > 0);
  const isExpandable = hasChildren;

  const toggleExpand = () => {
    if (isExpandable) setIsExpanded(!isExpanded);
  };

  return (
    <div className="xml-tree-node" style={{ paddingLeft: depth > 0 ? "20px" : "0" }}>
      <div 
        className={cn(
          "xml-tree-header", 
          isExpandable && "xml-tree-clickable"
        )}
        onClick={toggleExpand}
      >
        {isExpandable && (
          <span className="xml-tree-toggle">
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
        )}
        
        <span className="xml-tag-bracket">&lt;</span>
        <span className="xml-tag-name">{data._tag}</span>
        
        {hasAttributes && data._attributes && (
          <span className="xml-attributes">
            {Object.entries(data._attributes).map(([key, val]) => (
              <span key={key} className="xml-attribute">
                {" "}
                <span className="xml-attr-name">{key}</span>
                <span className="xml-attr-equal">=</span>
                <span className="xml-attr-value">"{val}"</span>
              </span>
            ))}
          </span>
        )}

        {(!hasChildren && !hasValue) ? (
          <span className="xml-tag-bracket"> /&gt;</span>
        ) : (
          <>
            <span className="xml-tag-bracket">&gt;</span>
            {!isExpanded && hasChildren && (
              <span className="xml-tree-preview"> ... </span>
            )}
            {hasValue && !hasChildren && (
              <span className="xml-text-node">{data._value}</span>
            )}
            {(!isExpanded || (!hasChildren && hasValue)) && (
              <>
                <span className="xml-tag-bracket">&lt;/</span>
                <span className="xml-tag-name">{data._tag}</span>
                <span className="xml-tag-bracket">&gt;</span>
              </>
            )}
          </>
        )}
      </div>

      {isExpanded && hasChildren && data._children && (
        <div className="xml-tree-children">
          {data._children.map((child, index) => (
            <XmlTreeView 
              key={index} 
              data={child} 
              depth={depth + 1} 
            />
          ))}
        </div>
      )}

      {isExpanded && hasChildren && (
        <div className="xml-tree-footer">
          <span className="xml-tag-bracket">&lt;/</span>
          <span className="xml-tag-name">{data._tag}</span>
          <span className="xml-tag-bracket">&gt;</span>
        </div>
      )}
    </div>
  );
}
