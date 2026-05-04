import React, { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface XmlTreeViewProps {
  data: any;
  isLast?: boolean;
  depth?: number;
}

export function XmlTreeView({
  data,
  isLast = true,
  depth = 0,
}: XmlTreeViewProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (typeof data === "string") {
    return <span className="xml-text-node">{data}</span>;
  }

  const hasChildren = data._children && data._children.length > 0;
  const hasValue = data._value !== undefined;
  const hasAttributes = data._attributes && Object.keys(data._attributes).length > 0;
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
        
        {hasAttributes && (
          <span className="xml-attributes">
            {Object.entries(data._attributes).map(([key, val]) => (
              <span key={key} className="xml-attribute">
                {" "}
                <span className="xml-attr-name">{key}</span>
                <span className="xml-attr-equal">=</span>
                <span className="xml-attr-value">"{val as string}"</span>
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

      {isExpanded && hasChildren && (
        <div className="xml-tree-children">
          {data._children.map((child: any, index: number) => (
            <XmlTreeView 
              key={index} 
              data={child} 
              depth={depth + 1} 
              isLast={index === data._children.length - 1} 
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
