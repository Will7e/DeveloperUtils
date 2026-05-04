import React, { useState, useEffect } from "react";
import { JsonTreeView } from "./JsonTreeView";
import { 
  FileJson, 
  Copy, 
  Trash2, 
  Check, 
  AlertCircle,
  Minimize2,
  Maximize2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";

export function JsonFormatter() {
  const [input, setInput] = useState("");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  useEffect(() => {
    if (!input.trim()) {
      setData(null);
      setError(null);
      return;
    }

    try {
      const parsed = JSON.parse(input);
      setData(parsed);
      setError(null);
    } catch (e: any) {
      setError(e.message);
      setData(null);
    }
  }, [input]);

  const handleCopy = () => {
    if (!data) return;
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    addToast({
      title: "Copied!",
      message: "JSON copied to clipboard",
      type: "success"
    });
  };

  const handleMinify = () => {
    if (!data) return;
    setInput(JSON.stringify(data));
  };

  const handleFormat = () => {
    if (!data) return;
    setInput(JSON.stringify(data, null, 2));
  };

  const handleClear = () => {
    setInput("");
  };

  const handleSample = () => {
    const sample = {
      id: "dev-utils-001",
      name: "Developer Utilities",
      version: "1.0.0",
      active: true,
      features: [
        { name: "Compiler", type: "IDE", status: "stable" },
        { name: "JSON Formatter", type: "Tool", status: "beta" },
        { name: "Unit Converter", type: "Tool", status: "planned" }
      ],
      config: {
        theme: "obsidian",
        fontSize: 14,
        autoSave: true,
        plugins: null
      },
      stats: {
        usage: 1250,
        rating: 4.8
      }
    };
    setInput(JSON.stringify(sample, null, 2));
  };

  return (
    <div className="json-formatter-container">
      {/* Header / Toolbar */}
      <div className="json-formatter-toolbar">
        <div className="toolbar-left">
          <FileJson className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">JSON Formatter</h2>
        </div>
        <div className="toolbar-right">
          <button 
            className="toolbar-btn" 
            onClick={handleSample}
            title="Load sample JSON"
          >
            Sample
          </button>
          <div className="toolbar-sep" />
          <button 
            className="toolbar-btn" 
            onClick={handleFormat}
            disabled={!data}
            title="Prettify JSON"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            Format
          </button>
          <button 
            className="toolbar-btn" 
            onClick={handleMinify}
            disabled={!data}
            title="Minify JSON"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            Minify
          </button>
          <button 
            className="toolbar-btn" 
            onClick={handleCopy}
            disabled={!data}
            title="Copy JSON"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green" /> : <Copy className="h-3.5 w-3.5" />}
            Copy
          </button>
          <button 
            className="toolbar-btn text-red hover:bg-red-dim" 
            onClick={handleClear}
            title="Clear all"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </button>
        </div>
      </div>

      <div className="json-formatter-content">
        {/* Input Section */}
        <div className="json-input-section">
          <div className="section-label">Input</div>
          <textarea
            className="json-textarea"
            placeholder="Paste your JSON here..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
          />
        </div>

        {/* Output Section */}
        <div className="json-output-section">
          <div className="section-label">Preview</div>
          <div className="json-tree-container">
            {error ? (
              <div className="json-error-state">
                <AlertCircle className="h-5 w-5 text-red" />
                <div className="json-error-message">
                  <div className="font-semibold mb-1">Invalid JSON</div>
                  <div className="text-xs opacity-70">{error}</div>
                </div>
              </div>
            ) : data ? (
              <div className="json-tree-scroll">
                <JsonTreeView data={data} />
              </div>
            ) : (
              <div className="json-empty-state">
                <FileJson className="h-10 w-10 opacity-10 mb-3" />
                <p>Paste JSON on the left to begin formatting</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
