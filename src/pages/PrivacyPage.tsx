// ============================================================
// Privacy Policy — InTab Developer Tools (in-tab.se)
// ============================================================
// Complies with Google API Services User Data Policy (including
// Limited Use requirements), GDPR, and local-first privacy standards.

import { useEffect } from "react";
import { Link } from "react-router-dom";
import {
  ShieldCheck,
  FileText,
  Lock,
  HardDrive,
  Cloud,
  Cpu,
  EyeOff,
  ExternalLink,
  ArrowLeft,
  Mail,
  CheckCircle2,
} from "lucide-react";
import { InTabLogo } from "@/components/ui/intab-logo";

export function PrivacyPage() {
  useEffect(() => {
    document.title = "Privacy Policy — InTab";
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  return (
    <div className="legal-page" id="privacy-policy-page">
      {/* Sticky Geist Navigation Header */}
      <header className="legal-header">
        <div className="legal-header-inner">
          <Link to="/" className="legal-brand-link" aria-label="InTab Home">
            <InTabLogo size={24} />
            <span>InTab</span>
            <span className="legal-brand-badge">Legal</span>
          </Link>

          <nav className="legal-nav-tabs" aria-label="Legal navigation">
            <Link to="/privacy" className="legal-nav-tab active">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Privacy Policy</span>
            </Link>
            <Link to="/terms" className="legal-nav-tab">
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
            <span>Effective Date: September 2026 · Version 2.4</span>
          </div>

          <h1 className="legal-title">Privacy Policy</h1>

          <p className="legal-subtitle">
            InTab is built from the ground up on a <strong>local-first, zero-telemetry architecture</strong>.
            Your code, API keys, conversations, and data run directly inside your browser and never touch
            our servers unless you explicitly configure an external connection.
          </p>

          {/* Highlights Matrix */}
          <div className="legal-highlights-grid">
            <div className="legal-highlight-card">
              <div className="legal-highlight-icon">
                <Cpu className="w-4 h-4" />
              </div>
              <div className="legal-highlight-title">100% Local Execution</div>
              <div className="legal-highlight-desc">
                Compilers, formatters, diff checks, and WASM runtimes run purely on your device.
              </div>
            </div>

            <div className="legal-highlight-card">
              <div className="legal-highlight-icon">
                <Lock className="w-4 h-4" />
              </div>
              <div className="legal-highlight-title">Encrypted at Rest</div>
              <div className="legal-highlight-desc">
                Stored tokens, vaults, and workspace state are sealed with AES-256-GCM.
              </div>
            </div>

            <div className="legal-highlight-card">
              <div className="legal-highlight-icon">
                <Cloud className="w-4 h-4" />
              </div>
              <div className="legal-highlight-title">Your Own Storage</div>
              <div className="legal-highlight-desc">
                Optional cloud backups sync directly to your private Google Drive or OneDrive.
              </div>
            </div>

            <div className="legal-highlight-card">
              <div className="legal-highlight-icon">
                <EyeOff className="w-4 h-4" />
              </div>
              <div className="legal-highlight-title">No Ads or Trackers</div>
              <div className="legal-highlight-desc">
                Zero third-party trackers, no analytics scripts, and no marketing pixels.
              </div>
            </div>
          </div>
        </section>

        {/* Quick Jump Bar */}
        <nav className="legal-toc-bar" aria-label="Table of contents">
          <span className="legal-toc-label">Jump to:</span>
          <a href="#core-architecture" className="legal-toc-link">1. Core Architecture</a>
          <a href="#google-user-data" className="legal-toc-link">2. Google User Data</a>
          <a href="#ai-openrouter" className="legal-toc-link">3. AI & OpenRouter</a>
          <a href="#data-storage" className="legal-toc-link">4. Encryption & Storage</a>
          <a href="#cookies" className="legal-toc-link">5. Cookies & Tracking</a>
          <a href="#deletion" className="legal-toc-link">6. Your Rights & Deletion</a>
          <a href="#contact" className="legal-toc-link">7. Contact</a>
        </nav>

        {/* Policy Sections */}
        <div className="legal-section-list">
          {/* Section 1 */}
          <article className="legal-section" id="core-architecture">
            <div className="legal-section-header">
              <span className="legal-section-number">01</span>
              <h2 className="legal-section-title">Core Architecture: Local-First by Design</h2>
            </div>
            <div className="legal-prose">
              <p>
                InTab (<a href="https://www.in-tab.se">in-tab.se</a>) is a suite of developer utilities designed to operate locally within your browser tab. Unlike traditional developer tools that upload your code, snippets, or JSON payloads to remote servers for processing:
              </p>
              <ul>
                <li><strong>Code Execution:</strong> JavaScript, TypeScript, Python (Pyodide WebAssembly), and formatters execute inside sandboxed Web Workers and WebAssembly isolated on your computer.</li>
                <li><strong>Network Isolation:</strong> The core application communicates with no central backend for its primary functionality. You can inspect the browser’s network monitor at any time to verify that zero payload data leaves your device.</li>
                <li><strong>No User Accounts:</strong> You do not need to register, provide an email address, or sign in to use InTab's developer tools.</li>
              </ul>
            </div>
          </article>

          {/* Section 2 - GOOGLE USER DATA (Crucial for Google OAuth Verification) */}
          <article className="legal-section" id="google-user-data">
            <div className="legal-section-header">
              <span className="legal-section-number">02</span>
              <h2 className="legal-section-title">Google API Services & Google Drive User Data</h2>
            </div>
            <div className="legal-prose">
              <p>
                InTab provides an optional <strong>Cloud Sync</strong> feature that allows you to synchronize your encrypted workspace, presets, and conversations across your devices using your own Google Drive account.
              </p>

              {/* Mandatory Google Policy Limited Use Callout Box */}
              <div className="legal-callout highlight-blue">
                <div className="legal-callout-title">
                  <ShieldCheck className="w-4 h-4 text-blue-500" />
                  <span>Google API Services User Data Policy Compliance</span>
                </div>
                <p className="legal-callout-text">
                  InTab's use and transfer to any other app of information received from Google APIs will adhere to the{" "}
                  <a
                    href="https://developers.google.com/terms/api-services-user-data-policy"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Google API Services User Data Policy
                  </a>
                  , including the <strong>Limited Use</strong> requirements.
                </p>
              </div>

              <p><strong>Specifically, regarding Google User Data:</strong></p>
              <ul>
                <li>
                  <strong>Scope Requested:</strong> We only request the <code>https://www.googleapis.com/auth/drive.appdata</code> scope. This is a restricted, application-specific isolated folder (&ldquo;Application Data folder&rdquo;) that only InTab can access. InTab <strong>cannot</strong> see, access, modify, or delete any of your personal files, photos, or documents in your main Google Drive.
                </li>
                <li>
                  <strong>Purpose of Access:</strong> We access this folder solely to save and restore your encrypted InTab settings, custom templates, and chat workspaces so that you can switch devices seamlessly.
                </li>
                <li>
                  <strong>Client-Side Encryption Before Upload:</strong> Before any backup file leaves your browser to Google Drive, it is sealed using client-side <strong>AES-256-GCM</strong> authenticated encryption. Even if someone inspected your Google Drive appDataFolder, the files are unreadable ciphertext without your local encryption pepper.
                </li>
                <li>
                  <strong>No Human Inspection:</strong> No human, employee, or automated InTab process ever reads, inspects, or accesses your Google user data.
                </li>
                <li>
                  <strong>No Third-Party Sharing:</strong> We do not sell, rent, transfer, or disclose Google user data to any third parties, advertisers, or data brokers.
                </li>
                <li>
                  <strong>No AI Model Training:</strong> Your Google user data is never used to train or fine-tune artificial intelligence or machine learning models.
                </li>
              </ul>
            </div>
          </article>

          {/* Section 3 */}
          <article className="legal-section" id="ai-openrouter">
            <div className="legal-section-header">
              <span className="legal-section-number">03</span>
              <h2 className="legal-section-title">AI Coding Assistant & External APIs</h2>
            </div>
            <div className="legal-prose">
              <p>
                InTab includes an integrated AI coding assistant. The assistant follows a strict <strong>Bring Your Own Key (BYOK)</strong> security model:
              </p>
              <ul>
                <li><strong>Direct Transmission:</strong> When you converse with the AI, prompts are transmitted directly from your browser to the OpenRouter API over encrypted TLS connections using your personal API key. InTab does not run an intermediate proxy that stores your prompts.</li>
                <li><strong>Local Key Storage:</strong> Your API keys are encrypted at rest using AES-256-GCM and stored exclusively in your browser’s IndexedDB storage. Keys are never transmitted to InTab developers.</li>
                <li><strong>Web Search:</strong> When the agent performs web searches to answer technical questions, queries are proxied via <code>/api/search</code> to privacy-preserving search providers (e.g. Tavily). Queries are ephemeral, and search logs are not stored or associated with personal identities.</li>
                <li><strong>GitHub Integration:</strong> If you connect GitHub to push code or create repositories, authentication is performed via standard OAuth. Your personal access token is encrypted in your local browser vault and used solely for user-initiated Git operations.</li>
              </ul>
            </div>
          </article>

          {/* Section 4 */}
          <article className="legal-section" id="data-storage">
            <div className="legal-section-header">
              <span className="legal-section-number">04</span>
              <h2 className="legal-section-title">Data Storage, Encryption & Security</h2>
            </div>
            <div className="legal-prose">
              <p>
                We implement industry-standard cryptographic techniques to secure all information stored by the application:
              </p>
              <ul>
                <li><strong>AES-256-GCM:</strong> Data written to browser storage (IndexedDB and localStorage) is encrypted using authenticated AES-256-GCM encryption with device-specific salts.</li>
                <li><strong>Content Security Policy (CSP):</strong> InTab enforces a strict Content Security Policy restricting unauthorized scripts, framing, and unauthorized network endpoints.</li>
                <li><strong>Cross-Origin Isolation:</strong> InTab implements <code>Cross-Origin-Opener-Policy: same-origin-allow-popups</code> and <code>Cross-Origin-Embedder-Policy: credentialless</code> to protect browser memory and prevent cross-origin leaks.</li>
              </ul>
            </div>
          </article>

          {/* Section 5 */}
          <article className="legal-section" id="cookies">
            <div className="legal-section-header">
              <span className="legal-section-number">05</span>
              <h2 className="legal-section-title">Cookies & Tracking Technologies</h2>
            </div>
            <div className="legal-prose">
              <p>
                InTab respects your privacy and operates without intrusive tracking:
              </p>
              <ul>
                <li><strong>No Advertising Cookies:</strong> We do not deploy advertising, marketing, or profiling cookies.</li>
                <li><strong>No Third-Party Analytics:</strong> We do not embed Google Analytics, Mixpanel, Hotjar, or similar session-recording trackers.</li>
                <li><strong>Local Storage Only:</strong> We use browser <code>localStorage</code> and <code>IndexedDB</code> solely for essential functionality: saving your theme preference, open tabs, offline workspace files, and encrypted credentials.</li>
              </ul>
            </div>
          </article>

          {/* Section 6 */}
          <article className="legal-section" id="deletion">
            <div className="legal-section-header">
              <span className="legal-section-number">06</span>
              <h2 className="legal-section-title">Data Retention, Control & Deletion</h2>
            </div>
            <div className="legal-prose">
              <p>
                Because your data resides locally on your machine, you have complete control over its retention and deletion:
              </p>
              <ul>
                <li><strong>Immediate Local Wipe:</strong> You can wipe all local tokens, chat history, and cache at any time by opening <strong>Settings &rarr; Storage</strong> and clicking <strong>&ldquo;Clear Stored Credentials&rdquo;</strong>, or by clearing your browser storage.</li>
                <li><strong>Cloud Sync Deletion:</strong> If you use Google Drive or OneDrive sync, you can delete your backups directly from the provider or disconnect your account in InTab Settings.</li>
                <li><strong>Revoking Google Access:</strong> You can revoke InTab's access to your Google account at any time via <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">Google Account Security Permissions <ExternalLink className="inline-block w-3 h-3 ml-1" /></a>. Once revoked, InTab will be unable to access the application folder.</li>
              </ul>
            </div>
          </article>

          {/* Section 7 */}
          <article className="legal-section" id="contact">
            <div className="legal-section-header">
              <span className="legal-section-number">07</span>
              <h2 className="legal-section-title">Contact & Inquiries</h2>
            </div>
            <div className="legal-prose">
              <p>
                If you have questions about this Privacy Policy, your data, or our security practices, please contact us:
              </p>
              <div className="legal-callout highlight-green">
                <div className="legal-callout-title">
                  <Mail className="w-4 h-4 text-green-500" />
                  <span>Developer Contact Information</span>
                </div>
                <p className="legal-callout-text">
                  <strong>Project Maintainer:</strong> William Le<br />
                  <strong>Support Email:</strong> <a href="mailto:william7e.se@gmail.com">william7e.se@gmail.com</a><br />
                  <strong>Website:</strong> <a href="https://www.in-tab.se">https://www.in-tab.se</a><br />
                  <strong>GitHub:</strong> <a href="https://github.com/Will7e/DeveloperUtils" target="_blank" rel="noopener noreferrer">Will7e/DeveloperUtils</a>
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
