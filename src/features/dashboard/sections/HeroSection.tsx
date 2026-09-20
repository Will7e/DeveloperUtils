// ============================================================
// Dashboard hero — what InTab is, in one screen
// ============================================================

import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { InTabLogo } from "@/components/ui/intab-logo";
import { HERO } from "../tools";

export function HeroSection() {
  return (
    <header className="dash-hero">
      <div className="dash-hero-logo-wrap">
        <div className="dash-hero-logo-glow" aria-hidden="true" />
        <InTabLogo size={40} className="dash-hero-icon" />
      </div>

      <h1 className="dash-hero-title">
        {HERO.titleLead}
        <span className="dash-hero-accent">{HERO.titleAccent}</span>
      </h1>

      <p className="dash-hero-subtitle">{HERO.subtitle}</p>

      <Link to={HERO.primaryCta.to} className="dash-cta-primary">
        {HERO.primaryCta.label}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>

      <p className="dash-hero-trust">
        {HERO.trust.map((fact, index) => (
          <span key={fact}>
            {index > 0 && <span className="dash-hero-trust-dot">·</span>}
            {fact}
          </span>
        ))}
      </p>
    </header>
  );
}
