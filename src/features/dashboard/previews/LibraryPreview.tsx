import { useState, useRef, useEffect } from "react";
import { Copy, Check, Search } from "lucide-react";
import { VirtualCursor } from "../components/VirtualCursor";
import { renderHighlightedTs } from "./syntaxHighlight";
import { getTargetCenter, type CursorPosition } from "../components/cursorUtils";

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
    snippet: `gs.info('Execution completed: ' + id);\nvar user = gs.getUserName();`,
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

export function LibraryPreview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedApiId, setSelectedApiId] = useState("gliderecord");
  const [copied, setCopied] = useState(false);

  // Virtual Cursor Autopilot State (Pixel-accurate coordinates)
  const [cursorPos, setCursorPos] = useState<CursorPosition>({ x: 35, y: 32, isPercent: true });
  const [cursorClicking, setCursorClicking] = useState(false);
  const [cursorAction, setCursorAction] = useState<string>("Ready");
  const [cursorDuration, setCursorDuration] = useState<number>(500);
  const [virtualHover, setVirtualHover] = useState<string | null>(null);
  const [isUserActive, setIsUserActive] = useState(false);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const filteredApis = APIS.filter(
    (a) =>
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.signature.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedApi: ApiDefinition =
    filteredApis.find((a) => a.id === selectedApiId) ?? (filteredApis[0] || APIS[0]!);

  const handleCopy = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    navigator.clipboard.writeText(selectedApi.snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  // Autonomous Lifelike Cursor Motion Loop for Library
  useEffect(() => {
    if (isUserActive) return;

    let step = 0;
    const timeouts: NodeJS.Timeout[] = [];

    const cycle = () => {
      if (isUserActive) return;

      if (step === 0) {
        // Glide to RESTMessageV2 chip with pixel accuracy
        setCursorDuration(480);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-chip="restmessage"]', { x: 38, y: 33 })
        );
        setCursorAction("RESTMessageV2");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("chip-restmessage");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setSelectedApiId("restmessage");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 500)
        );
      } else if (step === 1) {
        // Glide to Copy button with pixel accuracy
        setCursorDuration(520);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-action="copy"]', { x: 92, y: 78 })
        );
        setCursorAction("Copy Snippet");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("copy");
          }, 320)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 520)
        );
      } else if (step === 2) {
        // Glide to GlideDateTime chip with pixel accuracy
        setCursorDuration(500);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-chip="glidedatetime"]', { x: 74, y: 33 })
        );
        setCursorAction("GlideDateTime");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("chip-glidedatetime");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setSelectedApiId("glidedatetime");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 500)
        );
      } else if (step === 3) {
        // Drift over code snippet
        setCursorDuration(600);
        setCursorPos(
          getTargetCenter(containerRef.current, ".dash-lib-snippet-box", { x: 50, y: 68 })
        );
        setCursorAction("Reviewing Code");
      } else if (step === 4) {
        // Glide back to GlideRecord chip with pixel accuracy
        setCursorDuration(500);
        setCursorPos(
          getTargetCenter(containerRef.current, '[data-chip="gliderecord"]', { x: 12, y: 33 })
        );
        setCursorAction("GlideRecord");
        timeouts.push(
          setTimeout(() => {
            setVirtualHover("chip-gliderecord");
          }, 300)
        );
        timeouts.push(
          setTimeout(() => {
            setCursorClicking(true);
            setSelectedApiId("gliderecord");
            timeouts.push(
              setTimeout(() => {
                setCursorClicking(false);
                setVirtualHover(null);
              }, 180)
            );
          }, 500)
        );
      }

      step = (step + 1) % 5;
    };

    cycle();
    const interval = setInterval(cycle, 1850);

    return () => {
      clearInterval(interval);
      timeouts.forEach(clearTimeout);
      setVirtualHover(null);
    };
  }, [isUserActive]);

  const handleMouseEnter = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    setIsUserActive(true);
    setVirtualHover(null);
  };

  const handleMouseLeave = () => {
    idleTimerRef.current = setTimeout(() => {
      setIsUserActive(false);
    }, 2400);
  };

  return (
    <div
      ref={containerRef}
      className="dash-demo-box dash-demo-library"
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Animated Virtual Cursor with Pixel-Accurate Positioning */}
      <VirtualCursor
        x={cursorPos.x}
        y={cursorPos.y}
        isPercent={cursorPos.isPercent}
        isClicking={cursorClicking}
        visible={!isUserActive}
        actionText={cursorAction}
        transitionDuration={cursorDuration}
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
          onClick={(e) => e.stopPropagation()}
          spellCheck={false}
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
            className={`dash-lib-chip ${selectedApi.id === api.id ? "active" : ""} ${virtualHover === `chip-${api.id}` ? "is-virtual-hover" : ""}`}
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
        <button
          data-action="copy"
          type="button"
          className={`dash-lib-copy-btn ${virtualHover === "copy" ? "is-virtual-hover" : ""}`}
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
  );
}
