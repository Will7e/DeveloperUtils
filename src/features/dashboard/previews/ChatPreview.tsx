// ============================================================
// ChatPreview — Interactive Bento Card Preview for Dashboard
// ============================================================

import { MessageSquare, Sparkles, Send, Check } from "lucide-react";

export function ChatPreview() {
  return (
    <div
      className="dash-demo-box flex flex-col h-full bg-bg-2/50 border border-border-1 rounded-xl p-3.5 text-xs select-none overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-border-1/60">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-md bg-accent/15 border border-accent/20 flex items-center justify-center text-accent">
            <MessageSquare className="w-3 h-3" />
          </div>
          <span className="font-semibold text-text-0 text-[11.5px]">InTab AI</span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded bg-bg-1 border border-border-1 text-[10px] font-mono text-text-2">
            GPT-4o & Claude
          </span>
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        </div>
      </div>

      {/* Mini Message Thread */}
      <div className="flex flex-col gap-2 flex-1 justify-center">
        {/* User Message */}
        <div className="flex justify-end">
          <div className="bg-bg-3 text-text-1 px-2.5 py-1.5 rounded-lg rounded-tr-none text-[11px] max-w-[85%]">
            How do I debounce an async search in TypeScript?
          </div>
        </div>

        {/* Assistant Response */}
        <div className="flex items-start gap-1.5">
          <div className="w-4 h-4 rounded bg-accent/20 text-accent flex items-center justify-center shrink-0 mt-0.5">
            <Sparkles className="w-2.5 h-2.5" />
          </div>
          <div className="bg-bg-1 border border-border-1 p-2 rounded-lg rounded-tl-none text-[11px] text-text-0 flex-1">
            <p className="text-text-2 mb-1.5 text-[10.5px]">
              Use a generic timer closure with cancellation:
            </p>
            <div className="bg-bg-0 rounded p-1.5 font-mono text-[10px] text-text-1 border border-border-1/80 overflow-x-hidden">
              <span className="text-purple-400">function</span>{" "}
              <span className="text-blue-400">debounce</span>(fn, ms) &#123;
              <br />
              &nbsp;&nbsp;<span className="text-purple-400">let</span> timer;
              <br />
              &nbsp;&nbsp;<span className="text-purple-400">return</span> (...args) =&gt; &#123;
              <br />
              &nbsp;&nbsp;&nbsp;&nbsp;clearTimeout(timer);
              <br />
              &nbsp;&nbsp;&nbsp;&nbsp;timer = setTimeout(() =&gt; fn(...args), ms);
              <br />
              &nbsp;&nbsp;&#125;;
              <br />
              &#125;
            </div>
          </div>
        </div>
      </div>

      {/* Mini Mock Input */}
      <div className="mt-2 pt-2 border-t border-border-1/60 flex items-center gap-1.5">
        <div className="flex-1 bg-bg-1 border border-border-1 rounded-md px-2 py-1 text-[10.5px] text-text-3">
          Ask code, architecture, or debug...
        </div>
        <div className="w-6 h-6 rounded bg-accent text-[#0b0f19] flex items-center justify-center shrink-0">
          <Send className="w-3 h-3" />
        </div>
      </div>
    </div>
  );
}
