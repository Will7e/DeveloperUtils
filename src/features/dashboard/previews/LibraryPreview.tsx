import { useState, useRef } from "react";
import { Copy, Check, Search } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { renderHighlightedTs } from "./syntaxHighlight";
import { DemoControls, useAutopilot, type AutopilotStep } from "../autopilot";
import { requestHandoff } from "@/services/handoff.service";

interface ApiDefinition {
  id: string;
  name: string;
  scope: string;
  signature: string;
  snippet: string;
}

const APIS: ApiDefinition[] = [
  {
    id: "gliderecord",
    name: "GlideRecord",
    scope: "Scoped & Global",
    signature: "gr.addQuery(field, value)",
    snippet: `var gr = new GlideRecord('incident');\ngr.addQuery('active', true);\ngr.query();\nwhile (gr.next()) {\n  gs.info(gr.getValue('number'));\n}`,
  },
  {
    id: "restmessage",
    name: "RESTMessageV2",
    scope: "Scoped API",
    signature: "rm.execute()",
    snippet: `var rm = new sn_ws.RESTMessageV2();\nrm.setHttpMethod('GET');\nrm.setEndpoint('https://api.example.com');\nvar res = rm.execute();`,
  },
  {
    id: "gs",
    name: "GlideSystem (gs)",
    scope: "Global Utilities",
    signature: "gs.info(message, [parm1])",
    snippet: `gs.info('Execution completed: ' + id);\nvar user = gr.getValue('assigned_to');`,
  },
  {
    id: "glidedatetime",
    name: "GlideDateTime",
    scope: "Scoped & Global",
    signature: "gdt.addDaysUTC(days)",
    snippet: `var gdt = new GlideDateTime();\ngdt.addDaysUTC(7);\ngs.info(gdt.getValue());`,
  },
  {
    id: "xmldocument",
    name: "XMLDocument2",
    scope: "XML Parser",
    signature: "xml.parseXML(xmlString)",
    snippet: `var xml = new XMLDocument2();\nxml.parseXML('<root><item>val</item></root>');\nvar node = xml.getNode('//item');`,
  },
];

const FIRST_API = APIS[0]!;

export function LibraryPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedApiId, setSelectedApiId] = useState(FIRST_API.id);
  const [copied, setCopied] = useState(false);

  const filteredApis = APIS.filter(
    (a) =>
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.signature.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedApi: ApiDefinition =
    filteredApis.find((a) => a.id === selectedApiId) ?? (filteredApis[0] || FIRST_API);

  const copySnippet = () => {
    void navigator.clipboard.writeText(selectedApi.snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const handleCopy = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    copySnippet();
  };

  const steps: AutopilotStep[] = [
    {
      target: '[data-chip="restmessage"]',
      fallback: { x: 38, y: 33 },
      action: "RESTMessageV2",
      transition: 480,
      hover: "chip-restmessage",
      run: () => setSelectedApiId("restmessage"),
    },
    {
      target: '[data-action="copy"]',
      fallback: { x: 92, y: 78 },
      action: "Copy the snippet",
      transition: 520,
      hover: "copy",
      run: copySnippet,
    },
    {
      target: '[data-chip="glidedatetime"]',
      fallback: { x: 74, y: 33 },
      action: "GlideDateTime",
      transition: 500,
      hover: "chip-glidedatetime",
      run: () => setSelectedApiId("glidedatetime"),
    },
    {
      target: ".dash-lib-snippet-box",
      fallback: { x: 50, y: 68 },
      action: "Read the example",
      transition: 600,
    },
    {
      target: '[data-chip="gliderecord"]',
      fallback: { x: 12, y: 33 },
      action: "GlideRecord",
      transition: 500,
      hover: "chip-gliderecord",
      run: () => setSelectedApiId("gliderecord"),
    },
  ];

  const autopilot = useAutopilot(containerRef, steps, { stepMs: 1850 });

  return (
    <div
      ref={containerRef}
      className="dash-demo-box dash-demo-library"
      {...autopilot.containerProps}
    >
      <VirtualCursor {...autopilot.cursorProps} />

      <DemoControls
        autopilot={autopilot}
        openLabel="Open in Library"
        onOpen={() =>
          requestHandoff({
            target: "library",
            label: selectedApi.name,
            library: { tab: "servicenow", query: selectedApi.name },
          })
        }
      />

      {/* Search Input Bar */}
      <div className="dash-lib-search-bar">
        <Search className="h-3 w-3 text-[var(--ds-gray-700)]" />
        <input
          type="text"
          className="dash-lib-search-input"
          placeholder="Search ServiceNow classes and methods..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          spellCheck={false}
          aria-label="Search the reference"
        />
        <span className="dash-lib-count">
          {filteredApis.length} {filteredApis.length === 1 ? "match" : "matches"}
        </span>
      </div>

      {/* Filtered API Chips */}
      <div className="dash-lib-chips">
        {filteredApis.map((api) => (
          <button
            key={api.id}
            data-chip={api.id}
            type="button"
            className={`dash-lib-chip ${selectedApi.id === api.id ? "active" : ""} ${autopilot.hoverClass(`chip-${api.id}`)}`}
            onClick={() => setSelectedApiId(api.id)}
          >
            {api.name}
          </button>
        ))}
      </div>

      {/* Details Banner */}
      <div className="dash-lib-details">
        <div className="dash-lib-sig">
          <code>{selectedApi.signature}</code>
        </div>
        <span className="dash-lib-scope">{selectedApi.scope}</span>
      </div>

      {/* Code Snippet Box */}
      <div className="dash-lib-snippet-box">
        <pre className="dash-lib-snippet">
          <code>{renderHighlightedTs(selectedApi.snippet)}</code>
        </pre>

        <div className="dash-lib-actions">
          <button
            data-action="copy"
            type="button"
            className={`dash-lib-copy-btn ${autopilot.hoverClass("copy")}`}
            onClick={handleCopy}
            title="Copy snippet"
          >
            {copied ? (
              <Check className="h-3 w-3 text-emerald-400" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
