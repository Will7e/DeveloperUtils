// ============================================================
// Dashboard Page — landing surface for every InTab tool
// ============================================================
// Deliberately short, and each section exists once: hero → the one live demo
// stage that carries every tool → privacy, keyboard and FAQ. Copy and tool
// metadata live in features/dashboard/tools.ts, so this page can never
// advertise something the app does not ship.

import { DemoStage } from "@/features/dashboard/sections/DemoStage";
import { FaqSection } from "@/features/dashboard/sections/FaqSection";
import { HeroSection } from "@/features/dashboard/sections/HeroSection";
import { PrivacySection } from "@/features/dashboard/sections/PrivacySection";
import { ShortcutsSection } from "@/features/dashboard/sections/ShortcutsSection";
import { DashFooter } from "@/features/dashboard/sections/DashFooter";

export function DashboardPage() {
  return (
    <div className="dash-page">
      <div className="dash-container">
        <HeroSection />
        <DemoStage />
        <PrivacySection />
        <ShortcutsSection />
        <FaqSection />
        <DashFooter />
      </div>
    </div>
  );
}
