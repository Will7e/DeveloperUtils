import React, { useState } from "react";
import {
  Globe,
  Database,
  Plus,
  Trash2,
  Check,
  BookOpen,
} from "lucide-react";
import { useApiTesterStore } from "@/stores/api-tester.store";

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

  if (!isOpen) return null;

  const currentVars =
    settingsEnvId === "global"
      ? envVars
      : environments.find((e) => e.id === settingsEnvId)?.variables || [];

  const updateVars = (
    newVars: typeof envVars
  ) => {
    if (settingsEnvId === "global") {
      setEnvVars(newVars);
    } else {
      setEnvironmentVars(settingsEnvId, newVars);
    }
  };

  return (
    <div className="api-modal-overlay">
      <div
        className="api-modal-content"
        style={{
          maxWidth: "850px",
          width: "95vw",
          height: "600px",
          flexDirection: "row",
          overflow: "hidden",
          padding: 0,
        }}
      >
        {/* Sidebar */}
        <div
          style={{
            width: "240px",
            background: "var(--bg-0)",
            borderRight: "1px solid var(--border-1)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ padding: "24px 24px 16px" }}>
            <h3
              style={{
                margin: 0,
                fontSize: "18px",
                fontWeight: 600,
                color: "var(--text-1)",
                letterSpacing: "-0.4px",
              }}
            >
              Settings
            </h3>
          </div>
          <div
            style={{
              padding: "8px 12px",
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            }}
          >
            <h4
              style={{
                fontSize: "11px",
                textTransform: "uppercase",
                color: "var(--text-3)",
                padding: "8px 12px",
                margin: 0,
                fontWeight: 600,
                letterSpacing: "0.5px",
              }}
            >
              Environments
            </h4>
            <button
              onClick={() => setSettingsEnvId("global")}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                padding: "8px 14px",
                background:
                  settingsEnvId === "global" ? "var(--bg-2)" : "transparent",
                color:
                  settingsEnvId === "global"
                    ? "var(--text-1)"
                    : "var(--text-2)",
                border: "none",
                borderRadius: "8px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: settingsEnvId === "global" ? 600 : 500,
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => {
                if (settingsEnvId !== "global")
                  e.currentTarget.style.background = "var(--bg-1)";
              }}
              onMouseLeave={(e) => {
                if (settingsEnvId !== "global")
                  e.currentTarget.style.background = "transparent";
              }}
            >
              <Globe
                className="h-4 w-4"
                style={{
                  marginRight: "10px",
                  opacity: settingsEnvId === "global" ? 1 : 0.6,
                }}
              />
              Global Variables
            </button>
            {environments.map((env) => (
              <button
                key={env.id}
                onClick={() => setSettingsEnvId(env.id)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  padding: "8px 14px",
                  background:
                    settingsEnvId === env.id ? "var(--bg-2)" : "transparent",
                  color:
                    settingsEnvId === env.id
                      ? "var(--text-1)"
                      : "var(--text-2)",
                  border: "none",
                  borderRadius: "8px",
                  cursor: "pointer",
                  fontSize: "13px",
                  fontWeight: settingsEnvId === env.id ? 600 : 500,
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  if (settingsEnvId !== env.id)
                    e.currentTarget.style.background = "var(--bg-1)";
                }}
                onMouseLeave={(e) => {
                  if (settingsEnvId !== env.id)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                <Database
                  className="h-4 w-4"
                  style={{
                    marginRight: "10px",
                    opacity: settingsEnvId === env.id ? 1 : 0.6,
                  }}
                />
                {env.name}
              </button>
            ))}

            <button
              onClick={() => {
                const envCount = environments.length + 1;
                const newId = addEnvironment(`Environment ${envCount}`);
                setSettingsEnvId(newId);
              }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                padding: "8px 14px",
                background: "transparent",
                color: "var(--text-3)",
                border: "none",
                borderRadius: "8px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: 500,
                marginTop: "8px",
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text-1)";
                e.currentTarget.style.background = "var(--bg-1)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-3)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              <Plus className="h-4 w-4" style={{ marginRight: "10px" }} />
              Add Environment
            </button>
          </div>
          <div style={{ padding: "16px" }}>
            <button
              style={{
                width: "100%",
                justifyContent: "center",
                padding: "8px",
                borderRadius: "6px",
                background: "var(--bg-1)",
                border: "1px solid var(--border-1)",
                color: "var(--text-1)",
                fontSize: "12px",
                fontWeight: 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.borderColor = "var(--border-2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-1)";
                e.currentTarget.style.borderColor = "var(--border-1)";
              }}
              onClick={onClose}
            >
              Close Settings
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-1)",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "32px 36px 24px",
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              background: "var(--bg-1)",
            }}
          >
            <div>
              {settingsEnvId === "global" ? (
                <>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: "22px",
                      fontWeight: 600,
                      color: "var(--text-1)",
                      letterSpacing: "-0.5px",
                    }}
                  >
                    Global Variables
                  </h2>
                  <p
                    style={{
                      margin: "8px 0 0",
                      fontSize: "14px",
                      color: "var(--text-3)",
                    }}
                  >
                    Define key-value pairs to reuse across your API requests.
                  </p>
                </>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  <input
                    type="text"
                    value={
                      environments.find((e) => e.id === settingsEnvId)?.name ||
                      ""
                    }
                    onChange={(e) =>
                      updateEnvironment(settingsEnvId, e.target.value)
                    }
                    style={{
                      margin: 0,
                      fontSize: "22px",
                      fontWeight: 600,
                      color: "var(--text-1)",
                      letterSpacing: "-0.5px",
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--border-2)",
                      outline: "none",
                      padding: "0 0 4px 0",
                    }}
                  />
                  <p
                    style={{
                      margin: 0,
                      fontSize: "14px",
                      color: "var(--text-3)",
                    }}
                  >
                    Environment-specific variables override Global variables.
                  </p>
                </div>
              )}
            </div>
            {settingsEnvId !== "global" && (
              <button
                onClick={() => {
                  removeEnvironment(settingsEnvId);
                  setSettingsEnvId("global");
                }}
                style={{
                  padding: "6px 12px",
                  background: "var(--red-dim)",
                  border: "1px solid var(--red)",
                  borderRadius: "6px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                  color: "var(--red)",
                }}
              >
                <Trash2 className="h-4 w-4" />
                <span style={{ fontSize: "12px", fontWeight: 500 }}>Delete</span>
              </button>
            )}
          </div>

          {/* Body */}
          <div
            style={{
              flex: 1,
              padding: "0 36px 36px",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--border-1)",
                borderRadius: "12px",
                overflow: "hidden",
              }}
            >
              <div className="api-kv-editor" style={{ gap: 0 }}>
                {currentVars.map((v, i) => (
                  <div
                    key={v.id}
                    className="api-kv-row"
                    style={{
                      padding: "8px 12px",
                      borderBottom: "1px solid var(--border-1)",
                      borderRadius: 0,
                      gap: "12px",
                      background: "transparent",
                    }}
                  >
                    <button
                      onClick={() => {
                        const newVars = currentVars.map((item, idx) =>
                          idx === i ? { ...item, enabled: !item.enabled } : item
                        );
                        updateVars(newVars);
                      }}
                      style={{
                        width: "18px",
                        height: "18px",
                        minWidth: "18px",
                        borderRadius: "4px",
                        border: v.enabled
                          ? "none"
                          : "1px solid var(--border-2)",
                        background: v.enabled
                          ? "var(--accent)"
                          : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        padding: 0,
                        transition: "all 0.1s",
                      }}
                      title={v.enabled ? "Disable Variable" : "Enable Variable"}
                    >
                      {v.enabled && <Check className="h-3 w-3 text-white" />}
                    </button>
                    <input
                      type="text"
                      className="api-kv-input"
                      placeholder="Variable Name"
                      value={v.key}
                      style={{
                        fontWeight: 500,
                        color: "var(--accent)",
                        background: "transparent",
                        border: "1px solid transparent",
                        padding: "4px 8px",
                        boxShadow: "none",
                        transition: "all 0.15s ease",
                      }}
                      onFocus={(e) => {
                        e.currentTarget.style.background = "var(--bg-2)";
                        e.currentTarget.style.borderColor = "var(--border-2)";
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.borderColor = "transparent";
                      }}
                      onChange={(e) => {
                        const newVars = currentVars.map((item, idx) =>
                          idx === i ? { ...item, key: e.target.value } : item
                        );
                        updateVars(newVars);
                      }}
                    />

                    <div
                      style={{
                        width: "1px",
                        alignSelf: "stretch",
                        background: "var(--border-2)",
                        margin: "0 4px",
                      }}
                    />

                    <input
                      type="text"
                      className="api-kv-input"
                      placeholder="Value"
                      value={v.value}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        background: "transparent",
                        border: "1px solid transparent",
                        padding: "4px 8px",
                        boxShadow: "none",
                        transition: "all 0.15s ease",
                      }}
                      onFocus={(e) => {
                        e.currentTarget.style.background = "var(--bg-2)";
                        e.currentTarget.style.borderColor = "var(--border-2)";
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.borderColor = "transparent";
                      }}
                      onChange={(e) => {
                        const newVars = currentVars.map((item, idx) =>
                          idx === i ? { ...item, value: e.target.value } : item
                        );
                        updateVars(newVars);
                      }}
                    />
                    <button
                      className="api-kv-remove"
                      style={{
                        width: "28px",
                        height: "28px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: "6px",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "var(--text-3)",
                      }}
                      onClick={() => {
                        if (currentVars.length > 1) {
                          const newVars = currentVars.filter(
                            (_, idx) => idx !== i
                          );
                          updateVars(newVars);
                        } else {
                          const newVars = currentVars.map((item, idx) =>
                            idx === i ? { ...item, key: "", value: "" } : item
                          );
                          updateVars(newVars);
                        }
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--red)";
                        e.currentTarget.style.background = "var(--red-dim)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--text-3)";
                        e.currentTarget.style.background = "transparent";
                      }}
                      title="Remove Variable"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}

                <div
                  style={{
                    padding: "8px 12px",
                    background: "var(--bg-1)",
                  }}
                >
                  <button
                    onClick={() => {
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
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "6px 12px",
                      background: "transparent",
                      border: "none",
                      borderRadius: "6px",
                      color: "var(--text-3)",
                      fontSize: "12px",
                      fontWeight: 500,
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "var(--text-1)";
                      e.currentTarget.style.background = "var(--bg-1)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "var(--text-3)";
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Variable
                  </button>
                </div>
              </div>
            </div>

            <div
              style={{
                marginTop: "24px",
                padding: "16px 20px",
                background: "var(--bg-2)",
                borderRadius: "12px",
                border: "1px solid var(--border-1)",
                display: "flex",
                gap: "14px",
                alignItems: "flex-start",
              }}
            >
              <div
                style={{
                  color: "var(--text-2)",
                  marginTop: "2px",
                  background: "var(--bg-1)",
                  padding: "6px",
                  borderRadius: "8px",
                  border: "1px solid var(--border-1)",
                }}
              >
                <BookOpen className="h-4 w-4" />
              </div>
              <div>
                <h5
                  style={{
                    margin: "0 0 4px 0",
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "var(--text-1)",
                  }}
                >
                  How to use Environment Variables
                </h5>
                <p
                  style={{
                    margin: 0,
                    fontSize: "13px",
                    color: "var(--text-2)",
                    lineHeight: 1.5,
                  }}
                >
                  Type{" "}
                  <code
                    style={{
                      background: "var(--bg-1)",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      border: "1px solid var(--border-1)",
                      color: "var(--text-1)",
                      fontSize: "12px",
                    }}
                  >
                    &#123;&#123;variable_name&#125;&#125;
                  </code>{" "}
                  anywhere in the URL, Headers, Params, or JSON body. The
                  placeholder will be automatically substituted when the
                  request is sent.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
