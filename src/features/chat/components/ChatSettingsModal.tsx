// ============================================================
// AI Chat Settings Modal — Native Themed Settings Dialog
// Uses identical .settings-* layout and styles from SettingsPanel
// Supports modular SKILL.md skills management
// ============================================================

import { useState, useEffect, useRef } from "react";
import {
  X,
  Bot,
  MessageSquare,
  Sliders,
  ShieldCheck,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Trash2,
  AlertTriangle,
  ChevronDown,
  RotateCcw,
  Brain,
  Upload,
  Plus,
  Pencil,
  FileCode,
  Check,
} from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
import { testProviderConnection } from "../services/ai-client.service";
import {
  AIProvider,
  CURATED_MODELS,
  DEFAULT_SKILLS,
  DEFAULT_SYSTEM_PROMPT,
  PROVIDER_LABELS,
  PROVIDER_CONSOLE_URLS,
  ChatSkill,
} from "../types";
import { ProviderIcon } from "./ProviderIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

interface SettingsDropdownProps<T extends string | number> {
  value: T;
  options: { label: string; value: T }[];
  onChange: (value: T) => void;
  className?: string;
}

function SettingsDropdown<T extends string | number>({
  value,
  options,
  onChange,
  className = "w-[150px]",
}: SettingsDropdownProps<T>) {
  const selectedOption = options.find((o) => o.value === value) || options[0];

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button className={`settings-select flex items-center justify-between ${className}`}>
          <span className="truncate">{selectedOption?.label ?? "Select..."}</span>
          <ChevronDown className="h-3 w-3 opacity-50 ml-2 flex-shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={className}>
        {options.map((opt) => (
          <DropdownMenuItem
            key={String(opt.value)}
            onSelect={() => onChange(opt.value)}
            onClick={() => onChange(opt.value)}
            className="cursor-pointer text-xs"
          >
            {opt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ActionTooltipProps {
  children: React.ReactNode;
  content: string;
  side?: "top" | "bottom" | "left" | "right";
}

function ActionTooltip({ children, content, side = "top" }: ActionTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <p>{content}</p>
      </TooltipContent>
    </Tooltip>
  );
}

type SettingsTab = "general" | "skills" | "security";

export function ChatSettingsModal() {
  const settingsModalOpen = useChatStore((s) => s.settingsModalOpen);
  const setSettingsModalOpen = useChatStore((s) => s.setSettingsModalOpen);
  const settings = useChatStore((s) => s.settings);
  const updateSettings = useChatStore((s) => s.updateSettings);
  const setApiKey = useChatStore((s) => s.setApiKey);
  const setBaseUrl = useChatStore((s) => s.setBaseUrl);

  const toggleSkill = useChatStore((s) => s.toggleSkill);
  const addSkill = useChatStore((s) => s.addSkill);
  const updateSkill = useChatStore((s) => s.updateSkill);
  const deleteSkill = useChatStore((s) => s.deleteSkill);

  const activeProvider: AIProvider = settings?.activeProvider || "openai";
  const activeModel: string = settings?.activeModel || "gpt-4o";
  const apiKeys = settings?.apiKeys || { openai: "", anthropic: "", gemini: "" };
  const baseUrls = settings?.baseUrls || { openai: "", anthropic: "", gemini: "" };
  const skills = settings?.skills || DEFAULT_SKILLS;
  const temperature = typeof settings?.temperature === "number" ? settings.temperature : 0.7;
  const useProxy = Boolean(settings?.useProxy);

  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [showKeys, setShowKeys] = useState<{ [k in AIProvider]?: boolean }>({});
  const [testing, setTesting] = useState<{ [k in AIProvider]?: boolean }>({});
  const [testResults, setTestResults] = useState<{
    [k in AIProvider]?: { success: boolean; message: string };
  }>({});
  const [showConfirmWipe, setShowConfirmWipe] = useState(false);
  const [wipingState, setWipingState] = useState<"idle" | "wiping" | "done">("idle");

  // Skill editing state
  const [editingSkillId, setEditingSkillId] = useState<string | "new" | null>(null);
  const [editingSkillName, setEditingSkillName] = useState("");
  const [editingSkillDesc, setEditingSkillDesc] = useState("");
  const [editingSkillContent, setEditingSkillContent] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && settingsModalOpen) {
        if (editingSkillId !== null) {
          setEditingSkillId(null);
        } else {
          setSettingsModalOpen(false);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settingsModalOpen, setSettingsModalOpen, editingSkillId]);

  if (!settingsModalOpen) return null;

  const toggleShowKey = (provider: AIProvider) => {
    setShowKeys((prev) => ({ ...prev, [provider]: !prev[provider] }));
  };

  const handleTestKey = async (provider: AIProvider) => {
    const key = apiKeys[provider];
    const baseUrl = baseUrls[provider];
    if (!key) return;

    setTesting((prev) => ({ ...prev, [provider]: true }));
    setTestResults((prev) => ({ ...prev, [provider]: undefined }));

    try {
      const result = await testProviderConnection(
        provider,
        key,
        baseUrl,
        useProxy
      );
      setTestResults((prev) => ({ ...prev, [provider]: result }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [provider]: {
          success: false,
          message: err instanceof Error ? err.message : "Connection failed",
        },
      }));
    } finally {
      setTesting((prev) => ({ ...prev, [provider]: false }));
    }
  };

  const handleWipeKeys = () => {
    setWipingState("wiping");
    setTimeout(() => {
      setApiKey("openai", "");
      setApiKey("anthropic", "");
      setApiKey("gemini", "");
      setTestResults({});
      setWipingState("done");
      setTimeout(() => {
        setWipingState("idle");
        setShowConfirmWipe(false);
      }, 1000);
    }, 400);
  };

  // Skill management handlers
  const handleStartCreate = () => {
    setEditingSkillId("new");
    setEditingSkillName("");
    setEditingSkillDesc("");
    setEditingSkillContent(`---
name: custom-expert-skill
description: Custom instructions and domain expertise for this skill
---
# Custom Skill Guidelines
- Provide specific guidelines, rules, or system behavior here.
- Write clean and concise markdown instructions.
`);
  };

  const handleStartEdit = (skill: ChatSkill) => {
    setEditingSkillId(skill.id);
    setEditingSkillName(skill.name);
    setEditingSkillDesc(skill.description);
    setEditingSkillContent(skill.content);
  };

  const handleSaveSkill = () => {
    if (!editingSkillName.trim() || !editingSkillContent.trim()) return;

    if (editingSkillId === "new") {
      addSkill({
        name: editingSkillName.trim(),
        description: editingSkillDesc.trim() || "Custom user skill",
        content: editingSkillContent,
        enabled: true,
        isBuiltin: false,
      });
    } else if (editingSkillId) {
      updateSkill(editingSkillId, {
        name: editingSkillName.trim(),
        description: editingSkillDesc.trim(),
        content: editingSkillContent,
      });
    }
    setEditingSkillId(null);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const raw = (event.target?.result as string) || "";
      let name = file.name.replace(/\.md$/i, "");
      let description = "Imported SKILL.md document";

      const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
      if (frontmatterMatch && frontmatterMatch[1]) {
        const fm = frontmatterMatch[1];
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        if (nameMatch && nameMatch[1]) name = nameMatch[1].trim();
        if (descMatch && descMatch[1]) description = descMatch[1].trim();
      }

      addSkill({
        name,
        description,
        content: raw,
        enabled: true,
        isBuiltin: false,
      });

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };
    reader.readAsText(file);
  };

  const handleResetDefaultSkills = () => {
    updateSettings({ skills: DEFAULT_SKILLS });
  };

  // Filter models for active provider
  const availableModels = CURATED_MODELS.filter(
    (m) => m.provider === activeProvider
  );
  const currentModelInfo = CURATED_MODELS.find(
    (m) => m.id === activeModel
  ) || availableModels[0];

  const providerOptions: { label: string; value: AIProvider }[] = [
    { label: "OpenAI", value: "openai" },
    { label: "Anthropic Claude", value: "anthropic" },
    { label: "Google Gemini", value: "gemini" },
  ];

  const modelOptions = availableModels.map((m) => ({
    label: `${m.name} (${m.contextWindow})`,
    value: m.id,
  }));

  return (
    <div
      className="settings-overlay"
      onClick={() => setSettingsModalOpen(false)}
    >
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="settings-header">
          <div className="settings-header-info">
            <div className="settings-header-icon-box">
              <MessageSquare className="w-4 h-4" />
            </div>
            <div>
              <div className="settings-header-title-text">AI Chat Settings</div>
              <div className="settings-header-desc">
                Configure AI provider, model, SKILL.md instructions, and vault security
              </div>
            </div>
          </div>
          <ActionTooltip content="Close (Esc)" side="left">
            <button
              type="button"
              className="settings-close-btn"
              onClick={() => setSettingsModalOpen(false)}
              aria-label="Close Settings"
            >
              <X className="w-4 h-4" />
            </button>
          </ActionTooltip>
        </div>

        {/* Tabs Bar */}
        <div className="settings-tabs-bar">
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "general" ? "active" : ""}`}
            onClick={() => {
              setEditingSkillId(null);
              setActiveTab("general");
            }}
          >
            <Bot size={14} />
            <span>Model & Keys</span>
          </button>
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "skills" ? "active" : ""}`}
            onClick={() => setActiveTab("skills")}
          >
            <Brain size={14} />
            <span>Skills</span>
          </button>
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "security" ? "active" : ""}`}
            onClick={() => {
              setEditingSkillId(null);
              setActiveTab("security");
            }}
          >
            <ShieldCheck size={14} />
            <span>Security & Vault</span>
          </button>
        </div>

        {/* Body */}
        <div className="settings-body">
          {/* ── TAB 1: Model & Keys ── */}
          {activeTab === "general" && (
            <div className="settings-tab-content">
              {/* Active Provider & Model Section */}
              <div className="settings-section">
                <div className="settings-section-title">Active AI Model & Provider</div>

                {/* Active Provider Dropdown */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">AI Provider</label>
                    <span className="settings-sublabel">
                      Select primary provider for chat completions
                    </span>
                  </div>
                  <div className="settings-control">
                    <SettingsDropdown<AIProvider>
                      value={activeProvider}
                      options={providerOptions}
                      onChange={(provider) => {
                        const defaultModelId = CURATED_MODELS.find(
                          (m) => m.provider === provider && m.isDefault
                        )?.id || CURATED_MODELS.find((m) => m.provider === provider)?.id || "";
                        updateSettings({
                          activeProvider: provider,
                          activeModel: defaultModelId,
                          defaultProvider: provider,
                          defaultModel: defaultModelId,
                        });
                      }}
                      className="w-[160px]"
                    />
                  </div>
                </div>

                {/* Model Dropdown */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Model</label>
                    <span className="settings-sublabel truncate max-w-[280px]">
                      {currentModelInfo?.description || "Select completion model"}
                    </span>
                  </div>
                  <div className="settings-control">
                    <SettingsDropdown<string>
                      value={activeModel}
                      options={modelOptions}
                      onChange={(model) => {
                        const m = CURATED_MODELS.find((item) => item.id === model);
                        updateSettings({
                          activeModel: model,
                          defaultModel: model,
                          ...(m ? { activeProvider: m.provider, defaultProvider: m.provider } : {}),
                        });
                      }}
                      className="w-[200px]"
                    />
                  </div>
                </div>

                {/* Active Key Row */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <div className="flex items-center gap-2">
                      <ProviderIcon provider={activeProvider} className="w-4 h-4 shrink-0" />
                      <label className="settings-label">
                        {PROVIDER_LABELS[activeProvider]} API Key
                      </label>
                      <a
                        href={PROVIDER_CONSOLE_URLS[activeProvider]}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-accent hover:underline inline-flex items-center gap-0.5"
                      >
                        <span>Get Key</span>
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </div>
                    <span className="settings-sublabel">
                      {apiKeys[activeProvider]?.trim()
                        ? "Key saved securely in browser vault"
                        : "Required to send queries to " + PROVIDER_LABELS[activeProvider]}
                    </span>
                  </div>
                  <div className="settings-control">
                    <div className="relative flex items-center">
                      <input
                        type={showKeys[activeProvider] ? "text" : "password"}
                        className="settings-input w-[180px] pr-7"
                        placeholder="Paste API key..."
                        value={apiKeys[activeProvider] || ""}
                        onChange={(e) => setApiKey(activeProvider, e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="absolute right-1 text-text-3 hover:text-text-0 p-1 cursor-pointer"
                        onClick={() => toggleShowKey(activeProvider)}
                        aria-label={showKeys[activeProvider] ? "Hide Key" : "Show Key"}
                      >
                        {showKeys[activeProvider] ? (
                          <EyeOff className="w-3.5 h-3.5" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="settings-action-btn"
                      disabled={!apiKeys[activeProvider]?.trim() || testing[activeProvider]}
                      onClick={() => handleTestKey(activeProvider)}
                    >
                      {testing[activeProvider] ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <span>Test</span>
                      )}
                    </button>
                  </div>
                </div>

                {/* Test Feedback if present */}
                {testResults[activeProvider] && (
                  <div
                    className={`flex items-center gap-2 p-2 rounded text-xs border ${
                      testResults[activeProvider]?.success
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                        : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
                    }`}
                  >
                    {testResults[activeProvider]?.success ? (
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="truncate">
                      {testResults[activeProvider]?.message}
                    </span>
                  </div>
                )}
              </div>

              <div className="settings-divider" />

              {/* Inference Parameters */}
              <div className="settings-section">
                <div className="settings-section-title">Inference Parameters</div>

                {/* Temperature Slider */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Creativity & Temperature</label>
                    <span className="settings-sublabel">
                      Lower values produce deterministic code; higher values increase variety
                    </span>
                  </div>
                  <div className="settings-control">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={temperature}
                      onChange={(e) =>
                        updateSettings({ temperature: parseFloat(e.target.value) })
                      }
                      className="settings-slider"
                    />
                    <span className="settings-value">
                      {temperature.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="settings-divider" />

              {/* All Configured API Keys */}
              <div className="settings-section">
                <div className="settings-section-title">All Provider API Keys</div>

                {(["openai", "anthropic", "gemini"] as AIProvider[]).map((prov) => {
                  const isCurrent = prov === activeProvider;
                  const keyVal = apiKeys[prov] || "";
                  const isConfigured = Boolean(keyVal.trim());

                  return (
                    <div key={prov} className="settings-row">
                      <div className="settings-row-info">
                        <div className="flex items-center gap-2">
                          <ProviderIcon provider={prov} className="w-4 h-4 shrink-0" />
                          <label className="settings-label">
                            {PROVIDER_LABELS[prov]}
                          </label>
                          {isCurrent && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium">
                              Active
                            </span>
                          )}
                          <a
                            href={PROVIDER_CONSOLE_URLS[prov]}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] text-text-3 hover:text-accent inline-flex items-center gap-0.5 ml-1"
                          >
                            <span>Key ↗</span>
                          </a>
                        </div>
                        <span className="settings-sublabel">
                          {isConfigured ? "Configured in vault" : "Not configured"}
                        </span>
                      </div>
                      <div className="settings-control">
                        <div className="relative flex items-center">
                          <input
                            type={showKeys[prov] ? "text" : "password"}
                            className="settings-input w-[180px] pr-7"
                            placeholder="Enter API key..."
                            value={keyVal}
                            onChange={(e) => setApiKey(prov, e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            className="absolute right-1 text-text-3 hover:text-text-0 p-1 cursor-pointer"
                            onClick={() => toggleShowKey(prov)}
                            aria-label={showKeys[prov] ? "Hide Key" : "Show Key"}
                          >
                            {showKeys[prov] ? (
                              <EyeOff className="w-3.5 h-3.5" />
                            ) : (
                              <Eye className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                        <button
                          type="button"
                          className="settings-action-btn"
                          disabled={!isConfigured || testing[prov]}
                          onClick={() => handleTestKey(prov)}
                        >
                          {testing[prov] ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <span>Test</span>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="settings-divider" />

              {/* Network & Base URL Section */}
              <div className="settings-section">
                <div className="settings-section-title">Network & Connectivity</div>

                {/* Proxy Route Toggle */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Developer Proxy Route</label>
                    <span className="settings-sublabel">
                      Bypass browser CORS restrictions by routing via local /api/proxy
                    </span>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      className={`settings-toggle ${useProxy ? "active" : ""}`}
                      onClick={() => updateSettings({ useProxy: !useProxy })}
                    >
                      <span className="toggle-thumb" />
                    </button>
                  </div>
                </div>

                {/* Custom Base URL */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Custom Base URL — {PROVIDER_LABELS[activeProvider]}</label>
                    <span className="settings-sublabel">
                      Optional endpoint override for local LLM gateways or self-hosted servers
                    </span>
                  </div>
                  <div className="settings-control">
                    <input
                      type="text"
                      className="settings-input w-[220px]"
                      placeholder="Default official API URL"
                      value={baseUrls[activeProvider] || ""}
                      onChange={(e) => setBaseUrl(activeProvider, e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── TAB 2: Skills ── */}
          {activeTab === "skills" && (
            <div className="settings-tab-content">
              {/* Skills List Section */}
              <div className="settings-section">
                <div className="settings-section-title">Agent Skills</div>
                <span className="settings-sublabel">
                  Active markdown skills are dynamically composed into the system instructions
                </span>

                {/* Subform: Skill Editor / Creator */}
                {editingSkillId !== null && (
                  <div className="settings-vault-subform mt-1">
                    <div className="flex items-center justify-between">
                      <span className="settings-subform-title">
                        <FileCode className="w-3.5 h-3.5 text-accent" />
                        <span>
                          {editingSkillId === "new"
                            ? "New Agent Skill"
                            : `Edit Skill: ${editingSkillName || "Untitled"}`}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="text-text-3 hover:text-text-1 cursor-pointer"
                        onClick={() => setEditingSkillId(null)}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="flex flex-col gap-2 mt-1">
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          className="settings-input flex-1"
                          placeholder="Skill Name (e.g. React 19 Expert)"
                          value={editingSkillName}
                          onChange={(e) => setEditingSkillName(e.target.value)}
                        />
                        <input
                          type="text"
                          className="settings-input flex-1"
                          placeholder="Brief Description"
                          value={editingSkillDesc}
                          onChange={(e) => setEditingSkillDesc(e.target.value)}
                        />
                      </div>

                      <textarea
                        className="settings-textarea font-mono text-[11.5px]"
                        rows={8}
                        placeholder="Write markdown instructions or YAML frontmatter + markdown..."
                        value={editingSkillContent}
                        onChange={(e) => setEditingSkillContent(e.target.value)}
                        spellCheck={false}
                      />

                      <div className="settings-subform-btns justify-end">
                        <button
                          type="button"
                          className="settings-subform-cancel"
                          onClick={() => setEditingSkillId(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="settings-subform-action-btn max-w-[120px]"
                          onClick={handleSaveSkill}
                          disabled={!editingSkillName.trim() || !editingSkillContent.trim()}
                        >
                          Save Skill
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Clean Skills Rows */}
                {skills.map((skill) => (
                  <div key={skill.id} className="settings-row">
                    <div className="settings-row-info">
                      <div className="flex items-center gap-2">
                        <label
                          className="settings-label cursor-pointer hover:text-accent transition-colors flex items-center gap-1.5"
                          onClick={() => handleStartEdit(skill)}
                        >
                          <span>{skill.name}</span>
                          <Pencil className="w-3 h-3 text-text-3 opacity-60 hover:opacity-100 hover:text-accent" />
                        </label>
                        {!skill.isBuiltin && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-bg-3 text-text-3 font-mono">
                            Custom
                          </span>
                        )}
                      </div>
                      <span className="settings-sublabel">{skill.description}</span>
                    </div>

                    <div className="settings-control">
                      {!skill.isBuiltin && (
                        <button
                          type="button"
                          className="text-text-3 hover:text-red-400 p-1 rounded transition-colors cursor-pointer"
                          onClick={() => deleteSkill(skill.id)}
                          title="Delete custom skill"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        className={`settings-toggle ${skill.enabled ? "active" : ""}`}
                        onClick={() => toggleSkill(skill.id)}
                        aria-label={`Toggle ${skill.name}`}
                      >
                        <span className="toggle-thumb" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="settings-divider" />

              {/* Skill Actions Section */}
              <div className="settings-section">
                <div className="settings-section-title">Skill Actions</div>

                {/* Import File Row */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Import SKILL.md</label>
                    <span className="settings-sublabel">
                      Load a markdown skill document from your computer
                    </span>
                  </div>
                  <div className="settings-control">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleImportFile}
                      accept=".md,.markdown"
                      className="hidden"
                    />
                    <button
                      type="button"
                      className="settings-action-btn flex items-center gap-1.5"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>Import File</span>
                    </button>
                  </div>
                </div>

                {/* Create Custom Skill Row */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Create Custom Skill</label>
                    <span className="settings-sublabel">
                      Write markdown instructions and YAML frontmatter
                    </span>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      className="settings-action-btn flex items-center gap-1.5"
                      onClick={handleStartCreate}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>New Skill</span>
                    </button>
                  </div>
                </div>

                {/* Reset Built-in Skills Row */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Reset Built-in Skills</label>
                    <span className="settings-sublabel">
                      Restore default architect, reviewer, and QA skills
                    </span>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      className="settings-action-btn flex items-center gap-1.5"
                      onClick={handleResetDefaultSkills}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Reset Defaults</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── TAB 3: Security & Vault ── */}
          {activeTab === "security" && (
            <div className="settings-tab-content">
              {/* Security Reassurance Card */}
              <div className="settings-security-card">
                <div className="settings-security-badge-group">
                  <div className="settings-security-card-icon-wrap">
                    <ShieldCheck size={18} />
                  </div>
                  <div>
                    <div className="settings-security-card-title">Local Vault Security</div>
                    <div className="settings-security-card-desc">
                      API keys and skills are encrypted client-side and stored only in your browser. Nothing is sent to external servers or analytics.
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent font-mono">AES-256-GCM</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-divider" />

              {/* Vault Actions */}
              <div className="settings-section">
                <div className="settings-section-title">Data Management</div>

                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Clear Saved API Keys</label>
                    <span className="settings-sublabel">
                      Permanently wipe all stored OpenAI, Anthropic, and Gemini keys from this browser
                    </span>
                  </div>
                  <button
                    type="button"
                    className="settings-action-btn danger"
                    onClick={() => setShowConfirmWipe(true)}
                  >
                    <Trash2 size={12} />
                    <span>Clear Keys</span>
                  </button>
                </div>

                {/* Reset Confirmation Subform */}
                {showConfirmWipe && (
                  <div className="settings-vault-subform danger-box">
                    <div className="settings-subform-title danger">
                      <AlertTriangle size={14} />
                      <span>Confirm Key Removal</span>
                    </div>
                    <p className="settings-subform-warning">
                      This will erase all saved API tokens from your browser's local encrypted vault. You will need to re-enter them to continue chatting.
                    </p>
                    <div className="settings-subform-btns">
                      <button
                        type="button"
                        disabled={wipingState !== "idle"}
                        onClick={handleWipeKeys}
                        className="settings-subform-danger-btn flex items-center justify-center gap-1.5"
                      >
                        {wipingState === "wiping" ? (
                          <>
                            <Loader2 size={13} className="animate-spin" />
                            <span>Clearing Keys...</span>
                          </>
                        ) : wipingState === "done" ? (
                          <>
                            <CheckCircle2 size={13} />
                            <span>Keys Cleared!</span>
                          </>
                        ) : (
                          <span>Yes, Clear Stored Keys</span>
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={wipingState !== "idle"}
                        onClick={() => setShowConfirmWipe(false)}
                        className="settings-subform-cancel"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="settings-footer">
          <span className="settings-footer-hint">
            Esc or click outside to close
          </span>
        </div>
      </div>
    </div>
  );
}
