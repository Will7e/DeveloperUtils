// ============================================================
// Dashboard Footer — Legal & Navigation links
// ============================================================

import { Link } from "react-router-dom";
import { ShieldCheck, FileText, Coffee, ExternalLink } from "lucide-react";
import { InTabLogo } from "@/components/ui/intab-logo";

export function DashFooter() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="dash-footer" aria-label="Footer">
      <div className="dash-footer-inner">
        <div className="dash-footer-brand">
          <Link to="/" className="dash-footer-logo-link" aria-label="InTab Home">
            <InTabLogo size={20} />
            <span className="dash-footer-brand-name">InTab</span>
          </Link>
          <span className="dash-footer-tagline">
            Local-first developer utilities & AI coding environment.
          </span>
        </div>

        <nav className="dash-footer-nav" aria-label="Footer links">
          <Link to="/privacy" className="dash-footer-link">
            <ShieldCheck className="w-3.5 h-3.5 text-blue-400" />
            <span>Privacy Policy</span>
          </Link>

          <Link to="/terms" className="dash-footer-link">
            <FileText className="w-3.5 h-3.5" />
            <span>Terms of Service</span>
          </Link>

          <a
            href="https://github.com/Will7e/DeveloperUtils"
            target="_blank"
            rel="noopener noreferrer"
            className="dash-footer-link"
          >
            <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            <span>GitHub</span>
            <ExternalLink className="w-2.5 h-2.5 opacity-60" />
          </a>

          <a
            href="https://buymeacoffee.com/intab"
            target="_blank"
            rel="noopener noreferrer"
            className="dash-footer-link"
          >
            <Coffee className="w-3.5 h-3.5 text-amber-400" />
            <span>Support</span>
          </a>
        </nav>
      </div>

      <div className="dash-footer-bottom">
        <span className="dash-footer-copy">
          &copy; {currentYear} InTab. Zero tracking. Zero telemetry.
        </span>
      </div>
    </footer>
  );
}
