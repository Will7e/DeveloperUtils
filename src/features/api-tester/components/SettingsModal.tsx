import { useState, useEffect } from "react";
import {
  Globe,
  Database,
  Plus,
  Trash2,
  BookOpen,
  X,
  Check,
  Shield,
  Server,
  Lock,
  FileText,
  Eye,
  EyeOff,
} from "lucide-react";
import { useApiTesterStore } from "@/stores/api-tester.store";
import { SimpleTooltip } from "@/components/ui/tooltip";
// One definition of "this value is a secret", shared with the agent's read
// tools (features/chat/lib/sensitivity.ts). It used to be an inline regex here:
// the same rule written twice is the same rule that drifts apart.
import { isSecretKey } from "@/features/chat/lib/sensitivity";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialEnvId?: string | null;
}

export function SettingsModal({ isOpen, onClose, initialEnvId }: SettingsModalProps) {
  const [settingsEnvId, setSettingsEnvId] = useState<string>("global");
  const [revealedVarIndices, setRevealedVarIndices] = useState<Set<number>>(new Set());

  const envVars = useApiTesterStore((s) => s.envVars);
  const setEnvVars = useApiTesterStore((s) => s.setEnvVars);
  const environments = useApiTesterStore((s) => s.environments);
  const activeEnvironmentId = useApiTesterStore((s) => s.activeEnvironmentId);
  const setActiveEnvironment = useApiTesterStore((s) => s.setActiveEnvironment);
  const addEnvironment = useApiTesterStore((s) => s.addEnvironment);
  const updateEnvironment = useApiTesterStore((s) => s.updateEnvironment);
  const removeEnvironment = useApiTesterStore((s) => s.removeEnvironment);
  const setEnvironmentVars = useApiTesterStore((s) => s.setEnvironmentVars);
  const customProxyUrl = useApiTesterStore((s) => s.customProxyUrl);
  const setCustomProxyUrl = useApiTesterStore((s) => s.setCustomProxyUrl);

  const [proxyUrlInput, setProxyUrlInput] = useState<string>(() => customProxyUrl || "");
  const [proxySavedMessage, setProxySavedMessage] = useState<boolean>(false);
  const [prevProxyUrl, setPrevProxyUrl] = useState<string | null>(customProxyUrl);

  if (prevProxyUrl !== customProxyUrl) {
    setPrevProxyUrl(customProxyUrl);
    setProxyUrlInput(customProxyUrl || "");
  }

  // Sync selected scope when modal opens
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (!prevIsOpen && isOpen) {
    setPrevIsOpen(true);
    if (initialEnvId && (initialEnvId === "global" || environments.some((e) => e.id === initialEnvId))) {
      setSettingsEnvId(initialEnvId);
    } else if (activeEnvironmentId && environments.some((e) => e.id === activeEnvironmentId)) {
      setSettingsEnvId(activeEnvironmentId);
    } else {
      setSettingsEnvId("global");
    }
  } else if (prevIsOpen && !isOpen) {
    setPrevIsOpen(false);
  }

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Fallback to global if active environment was deleted (derived state)
  const isEnvValid =
    settingsEnvId === "global" ||
    settingsEnvId === "network" ||
    environments.some((e) => e.id === settingsEnvId);
  const effectiveEnvId = isEnvValid ? settingsEnvId : "global";

  const currentEnv = environments.find((e) => e.id === effectiveEnvId);
  const currentVars =
    effectiveEnvId === "global"
      ? envVars
      : currentEnv?.variables || [];

  const updateVars = (newVars: typeof envVars) => {
    if (effectiveEnvId === "global") {
      setEnvVars(newVars);
    } else {
      setEnvironmentVars(effectiveEnvId, newVars);
    }
  };

  const handleAddVariable = () => {
    const newVars = [
      ...currentVars,
      {
        id: Math.random().toString(36).substring(2, 9),
        key: "",
        value: "",
        enabled: true,
      },
    ];
    updateVars(newVars);
  };

  const allChecked =
    currentVars.length > 0 && currentVars.every((v) => v.enabled);
  const activeVarsCount = currentVars.filter((v) => v.key.trim()).length;

  return (
    <div className="api-modal-overlay api-settings-modal-overlay" onClick={onClose}>
      <div
        className="api-modal-content api-settings-modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left Sidebar: Environments / Scopes */}
        <aside className="api-settings-sidebar">
          {/* Sidebar Header */}
          <div className="api-settings-sidebar-header">
            <div className="api-settings-header-brand">
              <div className="api-settings-header-icon">
                <Globe className="h-4 w-4" />
              </div>
              <div>
                <div className="api-settings-sidebar-title">Environments</div>
                <div className="api-settings-sidebar-subtitle">
                  Variables & Scopes
                </div>
              </div>
            </div>
            <span className="api-settings-badge-count">
              {environments.length + 1}
            </span>
          </div>

          {/* Scopes Nav List */}
          <div className="api-settings-sidebar-nav">
            <div className="api-settings-nav-label">Scopes</div>

            {/* Global Variables Item */}
            <button
              type="button"
              onClick={() => setSettingsEnvId("global")}
              className={`api-settings-env-btn ${
                effectiveEnvId === "global" ? "api-settings-env-btn-active" : ""
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <Globe
                  className={`h-4 w-4 shrink-0 api-settings-env-icon ${
                    activeEnvironmentId === null ? "api-settings-env-icon-active" : ""
                  }`}
                />
                <span className="truncate">Global Variables</span>
              </div>
              <span className="api-settings-count-pill">
                {envVars.filter((v) => v.key.trim()).length}
              </span>
            </button>

            {/* Environments List */}
            {environments.map((env) => {
              const isActive = effectiveEnvId === env.id;
              const isCurrentlyActive = activeEnvironmentId === env.id;
              const count =
                env.variables?.filter((v) => v.key.trim()).length || 0;
              return (
                <button
                  key={env.id}
                  type="button"
                  onClick={() => setSettingsEnvId(env.id)}
                  className={`api-settings-env-btn ${
                    isActive ? "api-settings-env-btn-active" : ""
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <Database
                      className={`h-4 w-4 shrink-0 api-settings-env-icon ${
                        isCurrentlyActive ? "api-settings-env-icon-active" : ""
                      }`}
                    />
                    <span className="truncate">{env.name}</span>
                  </div>
                  <span className="api-settings-count-pill">{count}</span>
                </button>
              );
            })}

            {/* Add Environment Button */}
            <button
              type="button"
              onClick={() => {
                const envCount = environments.length + 1;
                const newId = addEnvironment(`Environment ${envCount}`);
                setSettingsEnvId(newId);
                setActiveEnvironment(newId);
              }}
              className="api-settings-add-env-btn"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span>Add Environment</span>
            </button>

            {/* Network Section */}
            <div className="api-settings-nav-label" style={{ marginTop: "16px" }}>
              Network & Proxy
            </div>
            <button
              type="button"
              onClick={() => setSettingsEnvId("network")}
              className={`api-settings-env-btn ${
                effectiveEnvId === "network" ? "api-settings-env-btn-active" : ""
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <Shield
                  className={`h-4 w-4 shrink-0 api-settings-env-icon ${
                    effectiveEnvId === "network" ? "text-accent" : "api-settings-env-icon-active"
                  }`}
                />
                <span className="truncate">Proxy & CORS</span>
              </div>
            </button>
          </div>

          {/* Sidebar Footer */}
          <div className="api-settings-sidebar-footer">
            <div className="api-settings-sidebar-tip">
              <code className="api-settings-tip-code">&#123;&#123;var&#125;&#125;</code>
              <span>Syntax for variables</span>
            </div>
          </div>
        </aside>

        {/* Right Main Content Pane */}
        <div className="api-settings-main">
          {/* Top Bar Header */}
          <div className="api-settings-topbar">
            <div className="api-settings-topbar-info">
              {effectiveEnvId === "network" ? (
                <div className="flex items-center gap-2.5">
                  <Shield className="h-5 w-5 api-settings-env-icon-active shrink-0" />
                  <div>
                    <h2 className="api-settings-title">Proxy & CORS</h2>
                    <p className="api-settings-subtitle">
                      Manage network proxy routing to bypass browser CORS restrictions.
                    </p>
                  </div>
                </div>
              ) : effectiveEnvId === "global" ? (
                <div className="flex items-center gap-2.5">
                  <Globe
                    className={`h-5 w-5 shrink-0 ${
                      activeEnvironmentId === null ? "api-settings-env-icon-active" : "text-text-3"
                    }`}
                  />
                  <div>
                    <h2 className="api-settings-title">Global Variables</h2>
                    <p className="api-settings-subtitle">
                      Variables available across all requests regardless of active environment.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2.5 flex-1 min-w-0">
                  <Database
                    className={`h-5 w-5 shrink-0 ${
                      activeEnvironmentId === effectiveEnvId ? "api-settings-env-icon-active" : "text-text-3"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={currentEnv?.name || ""}
                      onChange={(e) =>
                        updateEnvironment(effectiveEnvId, e.target.value)
                      }
                      className="api-settings-title-input"
                      placeholder="Environment Name"
                      title="Click to rename environment"
                    />
                    <p className="api-settings-subtitle">
                      Environment-specific variables override Global variables.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="api-settings-topbar-actions" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {effectiveEnvId !== "network" && (
                <>
                  {/* Set as Active Button (only when not active) */}
                  {!(effectiveEnvId === "global" ? activeEnvironmentId === null : activeEnvironmentId === effectiveEnvId) && (
                    <button
                      type="button"
                      onClick={() => setActiveEnvironment(effectiveEnvId === "global" ? null : effectiveEnvId)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        padding: "4px 10px",
                        borderRadius: "4px",
                        fontSize: "12px",
                        fontWeight: 500,
                        background: "var(--bg-2)",
                        color: "var(--text-1)",
                        border: "1px solid var(--border-1)",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <Check className="h-3.5 w-3.5 text-accent" />
                      <span>Set as Active</span>
                    </button>
                  )}

                  {effectiveEnvId !== "global" && (
                    <SimpleTooltip content="Delete Environment">
                      <button
                        type="button"
                        onClick={() => {
                          removeEnvironment(effectiveEnvId);
                          setSettingsEnvId("global");
                        }}
                        className="api-settings-delete-btn"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Delete</span>
                      </button>
                    </SimpleTooltip>
                  )}
                </>
              )}
              <SimpleTooltip content="Close (Esc)">
                <button
                  type="button"
                  className="api-modal-close"
                  onClick={onClose}
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </SimpleTooltip>
            </div>
          </div>

          {/* Body */}
          <div className="api-settings-body">
            {effectiveEnvId === "network" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {/* Built-in Proxy Card */}
                <div className="api-settings-card" style={{ padding: "16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                    <div
                      style={{
                        width: "32px",
                        height: "32px",
                        borderRadius: "8px",
                        background: "rgba(34, 197, 94, 0.12)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#22c55e",
                      }}
                    >
                      <Server className="h-4 w-4" />
                    </div>
                    <div>
                      <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-1)" }}>
                        Built-in CORS Proxy
                      </div>
                      <div style={{ fontSize: "11px", color: "var(--text-3)", display: "flex", alignItems: "center", gap: "5px" }}>
                        <span>Endpoint:</span>
                        <code style={{ color: "var(--accent)", background: "var(--bg-2)", padding: "1px 5px", borderRadius: "3px" }}>
                          /api/proxy
                        </code>
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: "20px",
                      padding: "10px 12px",
                      background: "var(--bg-2)",
                      borderRadius: "6px",
                      border: "1px solid var(--border-1)",
                      fontSize: "11px",
                      color: "var(--text-2)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <Lock className="h-3.5 w-3.5 text-accent shrink-0" />
                      <span>Private & Local (no 3rd-party servers)</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <FileText className="h-3.5 w-3.5 text-accent shrink-0" />
                      <span>Full response headers & streaming</span>
                    </div>
                  </div>
                </div>

                {/* Custom Proxy URL Card */}
                <div className="api-settings-card" style={{ padding: "16px" }}>
                  <div style={{ marginBottom: "10px" }}>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-1)", marginBottom: "2px" }}>
                      Custom Proxy URL
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--text-3)", marginBottom: "8px" }}>
                      Optional override for static hosting (e.g. GitHub Pages) or custom workers.
                    </div>
                    <div
                      style={{
                        fontSize: "11px",
                        color: "#f59e0b",
                        background: "rgba(245, 158, 11, 0.08)",
                        border: "1px solid rgba(245, 158, 11, 0.25)",
                        borderRadius: "6px",
                        padding: "8px 10px",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "6px",
                        lineHeight: 1.4,
                      }}
                    >
                      <Shield className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow" />
                      <span>
                        <strong>Security Notice:</strong> All request URLs, payloads, and authorization headers (including bearer tokens & passwords) are routed through this proxy endpoint. Only configure servers you own or trust.
                      </span>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <input
                      type="text"
                      className="api-settings-input"
                      placeholder="https://my-proxy.workers.dev/?url="
                      value={proxyUrlInput}
                      onChange={(e) => setProxyUrlInput(e.target.value)}
                      style={{
                        flex: 1,
                        padding: "7px 10px",
                        fontSize: "12px",
                        background: "var(--bg-2)",
                        border: "1px solid var(--border-1)",
                        borderRadius: "6px",
                        color: "var(--text-1)",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setCustomProxyUrl(proxyUrlInput.trim() ? proxyUrlInput.trim() : null);
                        setProxySavedMessage(true);
                        setTimeout(() => setProxySavedMessage(false), 2000);
                      }}
                      style={{
                        padding: "7px 14px",
                        fontSize: "12px",
                        fontWeight: 600,
                        borderRadius: "6px",
                        background: "var(--accent)",
                        color: "#fff",
                        border: "none",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {proxySavedMessage ? "Saved" : "Save"}
                    </button>
                    {customProxyUrl && (
                      <button
                        type="button"
                        onClick={() => {
                          setProxyUrlInput("");
                          setCustomProxyUrl(null);
                          setProxySavedMessage(true);
                          setTimeout(() => setProxySavedMessage(false), 2000);
                        }}
                        style={{
                          padding: "7px 10px",
                          fontSize: "12px",
                          borderRadius: "6px",
                          background: "var(--bg-2)",
                          color: "var(--text-2)",
                          border: "1px solid var(--border-1)",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* Variables Table Card */}
                <div className="api-settings-card">
              {/* Table Column Headers */}
              <div className="api-settings-card-header">
                <div className="api-settings-cell-check">
                  <input
                    type="checkbox"
                    className="api-checkbox"
                    checked={allChecked}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      updateVars(
                        currentVars.map((v) => ({ ...v, enabled: checked }))
                      );
                    }}
                    title={allChecked ? "Disable all" : "Enable all"}
                  />
                </div>
                <div className="px-2">Variable Name</div>
                <div className="px-2">Value</div>
                <div className="api-settings-cell-actions">
                  <span className="sr-only">Actions</span>
                </div>
              </div>

              {/* Rows or Empty State */}
              <div className="api-settings-card-body">
                {currentVars.length === 0 ? (
                  <div className="api-settings-empty">
                    <p className="api-settings-empty-text">
                      No variables defined for this scope yet.
                    </p>
                    <button
                      type="button"
                      className="api-settings-add-var-btn"
                      onClick={handleAddVariable}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Add Variable</span>
                    </button>
                  </div>
                ) : (
                  currentVars.map((v, i) => (
                    <div
                      key={v.id}
                      className={`api-settings-row ${
                        !v.enabled ? "disabled" : ""
                      }`}
                    >
                      <div className="api-settings-cell-check">
                        <input
                          type="checkbox"
                          className="api-checkbox"
                          checked={v.enabled}
                          onChange={(e) => {
                            const newVars = currentVars.map((item, idx) =>
                              idx === i
                                ? { ...item, enabled: e.target.checked }
                                : item
                            );
                            updateVars(newVars);
                          }}
                          title={
                            v.enabled
                              ? "Disable Variable"
                              : "Enable Variable"
                          }
                        />
                      </div>

                      <div className="api-settings-cell-input">
                        <input
                          type="text"
                          className="api-settings-input api-settings-input-key"
                          placeholder="Variable name"
                          value={v.key}
                          onChange={(e) => {
                            const newVars = currentVars.map((item, idx) =>
                              idx === i
                                ? { ...item, key: e.target.value }
                                : item
                            );
                            updateVars(newVars);
                          }}
                        />
                      </div>

                      <div className="api-settings-cell-input" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <input
                          type={isSecretKey(v.key) && !revealedVarIndices.has(i) ? "password" : "text"}
                          className="api-settings-input"
                          placeholder="Value"
                          value={v.value}
                          onChange={(e) => {
                            const newVars = currentVars.map((item, idx) =>
                              idx === i
                                ? { ...item, value: e.target.value }
                                : item
                            );
                            updateVars(newVars);
                          }}
                        />
                        {isSecretKey(v.key) && (
                          <SimpleTooltip content={revealedVarIndices.has(i) ? "Mask secret" : "Reveal secret"}>
                            <button
                              type="button"
                              className="api-delete-row-btn"
                              style={{ flexShrink: 0 }}
                              onClick={() => {
                                setRevealedVarIndices((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(i)) next.delete(i);
                                  else next.add(i);
                                  return next;
                                });
                              }}
                            >
                              {revealedVarIndices.has(i) ? (
                                <EyeOff className="h-3.5 w-3.5" />
                              ) : (
                                <Eye className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </SimpleTooltip>
                        )}
                      </div>

                      <div className="api-settings-cell-actions">
                        <SimpleTooltip content="Remove Variable">
                          <button
                            type="button"
                            className="api-delete-row-btn"
                            onClick={() => {
                              const newVars = currentVars.filter(
                                (_, idx) => idx !== i
                              );
                              updateVars(newVars);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </SimpleTooltip>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Table Footer */}
              <div className="api-settings-card-footer">
                <button
                  type="button"
                  onClick={handleAddVariable}
                  className="api-settings-add-var-btn"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Variable</span>
                </button>
                <span className="api-settings-stat-text">
                  {activeVarsCount} active{" "}
                  {activeVarsCount === 1 ? "var" : "vars"}
                </span>
              </div>
            </div>

                {/* How to use Environment Variables Callout */}
                <div className="api-settings-callout">
                  <div className="api-settings-callout-icon">
                    <BookOpen className="h-4 w-4" />
                  </div>
                  <div className="api-settings-callout-content">
                    <div className="api-settings-callout-title">
                      Using Environment Variables
                    </div>
                    <div className="api-settings-callout-desc">
                      Insert{" "}
                      <code className="api-settings-callout-code">
                        &#123;&#123;variable_name&#125;&#125;
                      </code>{" "}
                      anywhere in the URL bar, Headers, Query Parameters, or Body. The variable value will be automatically substituted when sending the request.
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

