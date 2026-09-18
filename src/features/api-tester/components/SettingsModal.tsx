import { useState, useEffect } from "react";
import {
  Globe,
  Database,
  Plus,
  Trash2,
  BookOpen,
  X,
} from "lucide-react";
import { useApiTesterStore } from "@/stores/api-tester.store";
import { SimpleTooltip } from "@/components/ui/tooltip";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [settingsEnvId, setSettingsEnvId] = useState<string>("global");

  const envVars = useApiTesterStore((s) => s.envVars);
  const setEnvVars = useApiTesterStore((s) => s.setEnvVars);
  const environments = useApiTesterStore((s) => s.environments);
  const addEnvironment = useApiTesterStore((s) => s.addEnvironment);
  const updateEnvironment = useApiTesterStore((s) => s.updateEnvironment);
  const removeEnvironment = useApiTesterStore((s) => s.removeEnvironment);
  const setEnvironmentVars = useApiTesterStore((s) => s.setEnvironmentVars);

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
                    effectiveEnvId === "global" ? "text-accent" : ""
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
                        isActive ? "text-accent" : ""
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
              }}
              className="api-settings-add-env-btn"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span>Add Environment</span>
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
              {effectiveEnvId === "global" ? (
                <div>
                  <h2 className="api-settings-title">Global Variables</h2>
                  <p className="api-settings-subtitle">
                    Variables available across all requests regardless of active environment.
                  </p>
                </div>
              ) : (
                <div>
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
              )}
            </div>

            <div className="api-settings-topbar-actions">
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

                      <div className="api-settings-cell-input">
                        <input
                          type="text"
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
          </div>
        </div>
      </div>
    </div>
  );
}

