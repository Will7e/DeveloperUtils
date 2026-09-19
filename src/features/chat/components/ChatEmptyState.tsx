// ============================================================
// ChatEmptyState — Enterprise Developer Onboarding Screen
// Ambient lighting, capabilities badges, categorized starter cards,
// and 1-click active skill toggles
// ============================================================

import {
  Layers,
  ShieldCheck,
  Zap,
  FlaskConical,
  Cpu,
  Eye,
  Lock,
  Sparkles,
} from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
import { useAppStore } from "@/stores/app.store";
import { PROVIDER_LABELS, CURATED_MODELS } from "../types";
import { ProviderIcon } from "./ProviderIcon";
import { executeChatStream } from "../services/chat-runner";

interface PromptStarter {
  id: string;
  category: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  prompt: string;
}

const PROMPT_STARTERS: PromptStarter[] = [
  {
    id: "architecture",
    category: "Architecture",
    title: "Modular TypeScript Service",
    description: "Design a type-safe caching service with TTL expiration and LRU eviction",
    icon: Layers,
    prompt:
      "Design a production-grade, modular caching service in TypeScript with TTL expiration, LRU eviction policy, and full type-safety. Include clean architecture patterns and unit test examples.",
  },
  {
    id: "security",
    category: "Security",
    title: "Security & Vulnerability Review",
    description: "Audit code for timing attacks, memory leaks, and unescaped inputs",
    icon: ShieldCheck,
    prompt:
      "Audit an authentication and authorization flow in TypeScript for critical security threats: check for timing attacks, token leakage, CSRF, and unescaped inputs with recommended mitigation strategies.",
  },
  {
    id: "performance",
    category: "Performance",
    title: "React Virtualization & Memo",
    description: "Profile and optimize an intensive UI list with virtualization and memoization",
    icon: Zap,
    prompt:
      "How do I optimize a complex React 19 dashboard with heavy re-renders? Provide a production example demonstrating useMemo, React.memo, virtual scrolling, and render isolation.",
  },
  {
    id: "testing",
    category: "Testing",
    title: "Vitest Unit Test Suite",
    description: "Generate thorough unit tests covering boundary edge cases and mocks",
    icon: FlaskConical,
    prompt:
      "Generate a complete Vitest unit test suite for an asynchronous service with realistic mock fixtures, covering boundary edge cases (null, empty, error states) and high assertion coverage.",
  },
];

export function ChatEmptyState() {
  const activeProvider = useChatStore((s) => s.settings.activeProvider);
  const activeModel = useChatStore((s) => s.settings.activeModel);
  const skills = useChatStore((s) => s.settings.skills || []);
  const toggleSkill = useChatStore((s) => s.toggleSkill);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const createConversation = useChatStore((s) => s.createConversation);
  const addMessage = useChatStore((s) => s.addMessage);

  const currentModelInfo = CURATED_MODELS.find((m) => m.id === activeModel);
  const providerLabel = PROVIDER_LABELS[activeProvider] || activeProvider;
  const contextWindow = currentModelInfo?.contextWindow || "128k context";

  const handleSelectStarter = (starter: PromptStarter) => {
    let convId = activeConversationId;
    if (!convId) {
      convId = createConversation(activeProvider, activeModel);
    }

    addMessage(convId, {
      role: "user",
      content: starter.prompt,
    });

    executeChatStream(convId);
  };

  const handleToggleSkill = (skillId: string, skillName: string) => {
    toggleSkill(skillId);
    useAppStore.getState().addToast({
      message: `Toggled persona: ${skillName}`,
      type: "info",
      duration: 2000,
    });
  };

  return (
    <div className="chat-empty-state">
      {/* Ambient background glow */}
      <div className="chat-empty-ambient-glow" />

      {/* Model & Provider Hero */}
      <div className="chat-empty-logo">
        <ProviderIcon
          provider={activeProvider}
          modelId={activeModel}
          className="w-14 h-14 text-accent drop-shadow-md"
        />
      </div>

      <div className="flex flex-col items-center gap-1">
        <h2 className="chat-empty-title">InTab AI Developer Workstation</h2>
        <p className="chat-empty-subtitle">
          Powered by {providerLabel} ({currentModelInfo?.name || activeModel}).
          Engineered for software architecture, code generation, debugging, and testing.
        </p>
      </div>

      {/* Capabilities Badges */}
      <div className="chat-empty-capabilities">
        <div className="chat-empty-capability-pill">
          <Cpu className="w-3 h-3 text-accent" />
          <span>{contextWindow.replace(" context", "")} Window</span>
        </div>
        <div className="chat-empty-capability-pill">
          <Eye className="w-3 h-3 text-emerald-400" />
          <span>Multimodal Vision</span>
        </div>
        <div className="chat-empty-capability-pill">
          <Lock className="w-3 h-3 text-cyan-400" />
          <span>AES-256 Vault Encrypted</span>
        </div>
        <div className="chat-empty-capability-pill">
          <Sparkles className="w-3 h-3 text-purple-400" />
          <span>Compiler Integration</span>
        </div>
      </div>

      {/* Categorized Prompt Starter Cards Grid */}
      <div className="chat-empty-grid">
        {PROMPT_STARTERS.map((starter) => {
          const IconComponent = starter.icon;
          return (
            <button
              key={starter.id}
              type="button"
              onClick={() => handleSelectStarter(starter)}
              className="chat-empty-card group"
            >
              <div className="chat-empty-card-icon">
                <IconComponent className="w-4 h-4" />
              </div>
              <div className="chat-empty-card-content">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-accent uppercase tracking-wider font-semibold">
                    {starter.category}
                  </span>
                </div>
                <span className="chat-empty-card-title">{starter.title}</span>
                <p className="chat-empty-card-desc">{starter.description}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Quick Personas / Skills Toggle Bar */}
      {skills.length > 0 && (
        <div className="chat-empty-skills-bar">
          <span className="text-text-3 text-[11px] font-medium mr-1">Personas:</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {skills.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleToggleSkill(s.id, s.name)}
                className={`chat-empty-skill-chip ${s.enabled ? "active" : ""}`}
                title={s.description}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    s.enabled ? "bg-accent" : "bg-text-3/40"
                  }`}
                />
                <span>{s.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
