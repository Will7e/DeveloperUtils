// ============================================================
// CloudSyncOverviewSection — Google Drive & Cloud Sync Explanation
// ============================================================
// Explicitly documents InTab's app purpose and Google Drive data usage
// on the public homepage for Google OAuth verification compliance.

import { Cloud, Lock, ShieldCheck, ArrowRight, HardDrive, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";

export function CloudSyncOverviewSection() {
  return (
    <section className="dash-privacy dash-cloud-sync-section" aria-labelledby="dash-cloud-sync-title">
      <div className="dash-cloud-header">
        <div className="dash-hero-badge">
          <Cloud className="w-3.5 h-3.5" style={{ color: "#0070f3" }} />
          <span>Optional Cloud Sync · Google Drive &amp; OneDrive</span>
        </div>
        <h2 className="dash-section-title" id="dash-cloud-sync-title" style={{ marginTop: "10px" }}>
          Private, Client-Side Encrypted Cloud Backup
        </h2>
        <p className="dash-hero-subtitle" style={{ maxWidth: "760px", margin: "8px auto 0" }}>
          InTab runs completely in your browser without requiring any login or account. If you want to sync your custom templates, presets, and snippets across devices, you can optionally connect your personal Google Drive or OneDrive.
        </p>
      </div>

      <ul className="dash-privacy-grid" style={{ marginTop: "20px" }}>
        <li className="dash-privacy-card">
          <span className="dash-privacy-icon" style={{ color: "#0070f3" }}>
            <HardDrive className="h-4 w-4" />
          </span>
          <h3 className="dash-privacy-title">Isolated App Folder Only</h3>
          <p className="dash-privacy-body">
            InTab requests only the <code>drive.appdata</code> scope (Application Data folder). It creates a single hidden sync file in your personal Google Drive. It cannot view, read, modify, or delete any of your other Google Drive files.
          </p>
        </li>

        <li className="dash-privacy-card">
          <span className="dash-privacy-icon" style={{ color: "#0070f3" }}>
            <Lock className="h-4 w-4" />
          </span>
          <h3 className="dash-privacy-title">Client-Side AES-256-GCM</h3>
          <p className="dash-privacy-body">
            Every snapshot is encrypted directly inside your browser before upload using AES-256-GCM. The encryption key never leaves your local machine, keeping your data unreadable even within Google Drive.
          </p>
        </li>

        <li className="dash-privacy-card">
          <span className="dash-privacy-icon" style={{ color: "#0070f3" }}>
            <Trash2 className="h-4 w-4" />
          </span>
          <h3 className="dash-privacy-title">User Controlled &amp; Deletable</h3>
          <p className="dash-privacy-body">
            You maintain full data ownership. You can disconnect sync and permanently delete your cloud backup at any time from InTab Settings, or revoke permissions directly in your Google Account security settings.
          </p>
        </li>

        <li className="dash-privacy-card">
          <span className="dash-privacy-icon" style={{ color: "#0070f3" }}>
            <ShieldCheck className="h-4 w-4" />
          </span>
          <h3 className="dash-privacy-title">Google Limited Use Compliant</h3>
          <p className="dash-privacy-body">
            InTab adheres strictly to the Google API Services User Data Policy. Your data is never sold, never shared with third parties or advertisers, and never used to train artificial intelligence or machine learning models.
          </p>
        </li>
      </ul>

      <div style={{ display: "flex", justifyContent: "center", marginTop: "16px" }}>
        <Link
          to="/privacy#google-user-data"
          className="dash-footer-link"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "13px",
            fontWeight: 500,
            color: "var(--text-1)",
            padding: "8px 16px",
            borderRadius: "var(--radius-full)",
            background: "var(--bg-1)",
            border: "1px solid var(--border-1)",
          }}
        >
          <ShieldCheck className="w-3.5 h-3.5" style={{ color: "#0070f3" }} />
          <span>Read Google API Compliance &amp; Privacy Policy</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </section>
  );
}
