// ============================================================
// Terms of Service — InTab Developer Tools (in-tab.se)
// ============================================================
// Clear, developer-friendly terms establishing 100% user code
// ownership, local execution guarantees, and transparent policies.

import { useEffect } from "react";
import { Link } from "react-router-dom";
import {
  FileText,
  ShieldCheck,
  CheckCircle,
  AlertCircle,
  ExternalLink,
  ArrowLeft,
  Mail,
  Scale,
  Sparkles,
  Lock,
} from "lucide-react";
import { InTabLogo } from "@/components/ui/intab-logo";

export function TermsPage() {
  useEffect(() => {
    document.title = "Terms of Service — InTab";
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  return (
    <div className="legal-page" id="terms-of-service-page">
      {/* Sticky Geist Navigation Header */}
      <header className="legal-header">
        <div className="legal-header-inner">
          <Link to="/" className="legal-brand-link" aria-label="InTab Home">
            <InTabLogo size={24} />
            <span>InTab</span>
            <span className="legal-brand-badge">Legal</span>
          </Link>

          <nav className="legal-nav-tabs" aria-label="Legal navigation">
            <Link to="/privacy" className="legal-nav-tab">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Privacy Policy</span>
            </Link>
            <Link to="/terms" className="legal-nav-tab active">
              <FileText className="w-3.5 h-3.5" />
              <span>Terms of Service</span>
            </Link>
          </nav>

          <div className="legal-header-actions">
            <Link to="/" className="legal-header-btn">
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to App</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="legal-container">
        {/* Hero Section */}
        <section className="legal-hero">
          <div className="legal-status-pill">
            <span className="legal-status-dot" />
            <span>Effective Date: September 2026 · Version 2.0</span>
          </div>

          <h1 className="legal-title">Terms of Service</h1>

          <p className="legal-subtitle">
            Welcome to InTab (<a href="https://www.in-tab.se">in-tab.se</a>). These terms outline your rights
            and responsibilities when using our suite of developer utilities and AI coding assistant.
            The core principle is simple: <strong>your code and your data belong 100% to you</strong>.
          </p>

          {/* Highlights Matrix */}
          <div className="legal-highlights-grid">
            <div className="legal-highlight-card">
              <div className="legal-highlight-icon">
                <Scale className="w-4 h-4" />
              </div>
              <div className="legal-highlight-title">Your Code is Yours</div>
              <div className="legal-highlight-desc">
                You retain 100% exclusive intellectual property rights to all code and outputs.
              </div>
            </div>

            <div className="legal-highlight-card">
              <div className="legal-highlight-icon">
                <Lock className="w-4 h-4" />
              </div>
              <div className="legal-highlight-title">No Lock-in</div>
              <div className="legal-highlight-desc">
                Export your conversations, files, and diffs anytime in standard formats.
              </div>
            </div>

            <div className="legal-highlight-card">
              <div className="legal-highlight-icon">
                <Sparkles className="w-4 h-4" />
              </div>
              <div className="legal-highlight-title">BYOK Transparency</div>
              <div className="legal-highlight-desc">
                Connect your own OpenRouter and cloud keys with zero hidden subscription markups.
              </div>
            </div>

            <div className="legal-highlight-card">
              <div className="legal-highlight-icon">
                <CheckCircle className="w-4 h-4" />
              </div>
              <div className="legal-highlight-title">Free & Open Core</div>
              <div className="legal-highlight-desc">
                Essential utilities run freely and offline right in your browser tab.
              </div>
            </div>
          </div>
        </section>

        {/* Quick Jump Bar */}
        <nav className="legal-toc-bar" aria-label="Table of contents">
          <span className="legal-toc-label">Jump to:</span>
          <a href="#acceptance" className="legal-toc-link">1. Acceptance</a>
          <a href="#services" className="legal-toc-link">2. Description</a>
          <a href="#ownership" className="legal-toc-link">3. IP & Ownership</a>
          <a href="#acceptable-use" className="legal-toc-link">4. Acceptable Use</a>
          <a href="#third-parties" className="legal-toc-link">5. Third Parties</a>
          <a href="#disclaimers" className="legal-toc-link">6. Disclaimers</a>
          <a href="#liability" className="legal-toc-link">7. Liability</a>
          <a href="#contact" className="legal-toc-link">8. Contact</a>
        </nav>

        {/* Terms Sections */}
        <div className="legal-section-list">
          {/* Section 1 */}
          <article className="legal-section" id="acceptance">
            <div className="legal-section-header">
              <span className="legal-section-number">01</span>
              <h2 className="legal-section-title">Acceptance of Terms</h2>
            </div>
            <div className="legal-prose">
              <p>
                By visiting, accessing, or using InTab (&ldquo;the Service&rdquo;), accessible at{" "}
                <a href="https://www.in-tab.se">https://www.in-tab.se</a>, you acknowledge that you have read,
                understood, and agree to be bound by these Terms of Service and our{" "}
                <Link to="/privacy">Privacy Policy</Link>. If you do not agree to these terms, please do not use
                the Service.
              </p>
            </div>
          </article>

          {/* Section 2 */}
          <article className="legal-section" id="services">
            <div className="legal-section-header">
              <span className="legal-section-number">02</span>
              <h2 className="legal-section-title">Description of the Service</h2>
            </div>
            <div className="legal-prose">
              <p>
                InTab provides browser-based development tools designed for software engineers, developers, and technical professionals. Features include:
              </p>
              <ul>
                <li><strong>Development Utilities:</strong> Client-side code compiler, formatters, schema diffing, JSON/YAML tools, and API test client.</li>
                <li><strong>Interactive Diagrams:</strong> Architectural diagramming and visual flow designer (DrawFlows).</li>
                <li><strong>AI Coding Workspace:</strong> Multi-model coding agent powered by user-provided OpenRouter credentials, with live code preview and sandbox environments.</li>
                <li><strong>Cloud Synchronization:</strong> Optional client-encrypted state backup via Google Drive and Microsoft OneDrive.</li>
              </ul>
            </div>
          </article>

          {/* Section 3 - OWNERSHIP */}
          <article className="legal-section" id="ownership">
            <div className="legal-section-header">
              <span className="legal-section-number">03</span>
              <h2 className="legal-section-title">User Ownership & Intellectual Property</h2>
            </div>
            <div className="legal-prose">
              <div className="legal-callout highlight-blue">
                <div className="legal-callout-title">
                  <CheckCircle className="w-4 h-4 text-blue-500" />
                  <span>Your Intellectual Property Rights</span>
                </div>
                <p className="legal-callout-text">
                  InTab claims <strong>zero ownership, copyright, or intellectual property rights</strong> over any code, text, diagrams, configurations, or data that you create, import, compile, format, or receive from AI models within the application. Everything you create belongs exclusively to you.
                </p>
              </div>

              <p>
                We do not license, sub-license, publish, or use your code for any purpose. Because the application runs locally in your browser, your code never enters an InTab training pipeline or database.
              </p>
            </div>
          </article>

          {/* Section 4 */}
          <article className="legal-section" id="acceptable-use">
            <div className="legal-section-header">
              <span className="legal-section-number">04</span>
              <h2 className="legal-section-title">Acceptable Use Policy</h2>
            </div>
            <div className="legal-prose">
              <p>
                You agree to use InTab only for lawful purposes and in accordance with these Terms. You agree not to:
              </p>
              <ul>
                <li>Use the API tester or preview sandbox to launch Denial of Service (DoS) attacks, port scans, or unauthorized intrusions against third-party systems.</li>
                <li>Transmit, store, or process malicious payloads designed to infect or compromise systems.</li>
                <li>Attempt to bypass, disable, or tamper with the application's Content Security Policy, isolation headers, or sandbox security controls.</li>
                <li>Use the service in violation of any applicable local, national, or international laws or regulations.</li>
              </ul>
            </div>
          </article>

          {/* Section 5 */}
          <article className="legal-section" id="third-parties">
            <div className="legal-section-header">
              <span className="legal-section-number">05</span>
              <h2 className="legal-section-title">Third-Party Services & Integrations</h2>
            </div>
            <div className="legal-prose">
              <p>
                InTab integrates with third-party providers upon user configuration:
              </p>
              <ul>
                <li><strong>Google Drive API:</strong> Used solely for encrypted sync to your personal application folder in compliance with the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">Google API Services User Data Policy</a>.</li>
                <li><strong>OpenRouter:</strong> AI requests are subject to OpenRouter's terms and the respective model providers (Anthropic, OpenAI, Google, etc.). You are responsible for compliance with their terms and your own token usage.</li>
                <li><strong>GitHub:</strong> OAuth authorization is subject to GitHub's Terms of Service.</li>
              </ul>
              <p>
                InTab is not responsible or liable for any downtime, outages, rate limits, or policies enforced by these third-party providers.
              </p>
            </div>
          </article>

          {/* Section 6 */}
          <article className="legal-section" id="disclaimers">
            <div className="legal-section-header">
              <span className="legal-section-number">06</span>
              <h2 className="legal-section-title">Disclaimer of Warranties</h2>
            </div>
            <div className="legal-prose">
              <p>
                InTab is provided on an <strong>&ldquo;AS IS&rdquo;</strong> and <strong>&ldquo;AS AVAILABLE&rdquo;</strong> basis, without warranties of any kind, whether express or implied, including but not limited to the implied warranties of merchantability, fitness for a particular purpose, non-infringement, or course of performance.
              </p>
              <p>
                While we strive for high stability, security, and accuracy, we do not warrant that:
              </p>
              <ul>
                <li>The Service will be uninterrupted, error-free, or entirely bug-free.</li>
                <li>AI-generated code or suggestions will be complete, accurate, or safe for production deployment without review. Developers are expected to review and test all AI-generated code.</li>
              </ul>
            </div>
          </article>

          {/* Section 7 */}
          <article className="legal-section" id="liability">
            <div className="legal-section-header">
              <span className="legal-section-number">07</span>
              <h2 className="legal-section-title">Limitation of Liability</h2>
            </div>
            <div className="legal-prose">
              <p>
                To the maximum extent permitted by applicable law, in no event shall InTab, its maintainers, contributors, or affiliates be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of profits, data loss, corruption, or business interruption arising out of your access to or use of the Service.
              </p>
            </div>
          </article>

          {/* Section 8 */}
          <article className="legal-section" id="contact">
            <div className="legal-section-header">
              <span className="legal-section-number">08</span>
              <h2 className="legal-section-title">Modifications & Contact</h2>
            </div>
            <div className="legal-prose">
              <p>
                We may revise these Terms from time to time. When changes are made, we will update the &ldquo;Effective Date&rdquo; at the top of this document. Continued use of the Service following notice of changes constitutes acceptance of the revised Terms.
              </p>

              <div className="legal-callout highlight-green">
                <div className="legal-callout-title">
                  <Mail className="w-4 h-4 text-green-500" />
                  <span>Questions About These Terms?</span>
                </div>
                <p className="legal-callout-text">
                  Please reach out directly if you have any questions or feedback:<br />
                  <strong>Maintainer:</strong> William Le<br />
                  <strong>Email:</strong> <a href="mailto:william7e.se@gmail.com">william7e.se@gmail.com</a><br />
                  <strong>Website:</strong> <a href="https://www.in-tab.se">https://www.in-tab.se</a>
                </p>
              </div>
            </div>
          </article>
        </div>

        {/* Footer */}
        <footer className="legal-page-footer">
          <div>&copy; {new Date().getFullYear()} InTab. All rights reserved. Built local-first.</div>
          <div className="legal-footer-links">
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
            <Link to="/">Open App</Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
