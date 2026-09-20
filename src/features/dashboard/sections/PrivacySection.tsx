// ============================================================
// Privacy & security — the promise, backed by what the code does
// ============================================================

import { Cpu, Lock, Server, ShieldCheck } from "lucide-react";
import { PRIVACY_POINTS } from "../tools";

const ICONS = [Cpu, Lock, Server, ShieldCheck];

export function PrivacySection() {
  return (
    <section className="dash-privacy" aria-labelledby="dash-privacy-title">
      <h2 className="dash-section-title" id="dash-privacy-title">
        Built so your data cannot leave
      </h2>

      <ul className="dash-privacy-grid">
        {PRIVACY_POINTS.map((point, index) => {
          const Icon = ICONS[index] ?? ShieldCheck;
          return (
            <li key={point.title} className="dash-privacy-card">
              <span className="dash-privacy-icon">
                <Icon className="h-4 w-4" />
              </span>
              <h3 className="dash-privacy-title">{point.title}</h3>
              <p className="dash-privacy-body">{point.body}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
