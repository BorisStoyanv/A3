import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE = (window.API_BASE || import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
const CSRF_COOKIE = "icp_csrf";
const CSRF_HEADER = "x-csrf-token";
const DEFAULT_AVATAR = "/default-avatar.png";
const THEME_KEY = "nu2_theme";
const MAX_PROJECTS = 3;

const DEFAULT_BUILD = {
  framework: "auto",
  rootDir: "",
  installCommand: "",
  buildCommand: "",
  outputDir: "",
};

const FRAMEWORK_PRESETS = [
  { id: "auto", name: "Detect automatically" },
  { id: "static", name: "Static Site" },
  { id: "vite", name: "Vite" },
  { id: "nextjs", name: "Next.js" },
  { id: "cra", name: "Create React App" },
  { id: "nuxt", name: "Nuxt" },
  { id: "sveltekit", name: "SvelteKit" },
];
const QUICK_START_TEMPLATES = [
  {
    id: "template-react",
    label: "React",
    subtitle: "A3 React starter",
    sourceUrl: "https://github.com/BorisStoyanv/A3-template-react",
    suggestedRepoName: "a3-react-app",
    icon: "react",
  },
  {
    id: "template-nextjs",
    label: "Next.js",
    subtitle: "A3 Next.js starter",
    sourceUrl: "https://github.com/BorisStoyanv/A3-template-nextjs",
    suggestedRepoName: "a3-nextjs-app",
    icon: "nextjs",
  },
  {
    id: "template-html",
    label: "HTML",
    subtitle: "A3 static starter",
    sourceUrl: "https://github.com/BorisStoyanv/A3-template-static",
    suggestedRepoName: "a3-static-site",
    icon: "html",
  },
];
const ENV_KEY_SUGGESTIONS = [
  "VITE_API_BASE_URL",
  "VITE_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_API_BASE_URL",
  "NEXT_PUBLIC_APP_NAME",
  "SENTRY_DSN",
];
const ANALYTICS_RANGES = ["24h", "7d", "30d", "90d"];
const ADMIN_CANISTER_STATUSES = ["active", "draining", "full"];
const DEPLOYMENT_STAGES = ["build", "deploy"];
const DEPLOYMENT_STAGE_LABELS = {
  build: "Build",
  deploy: "Deploy",
};
const STAGE_MARKER_PATTERN =
  /^\[\[STAGE\]\]\s+(build|deploy)\s+(START|END)(?:\s+(success|failed))?\s*$/i;

const SESSION_BOOTSTRAP_UNKNOWN = "unknown";
const SESSION_BOOTSTRAP_READY = "ready";
const SESSION_BOOTSTRAP_ERROR = "error";
const CORE_POLL_VISIBLE_MS = 6000;
const CORE_POLL_HIDDEN_MS = 20000;
const NOTIFICATIONS_POLL_MS = 30000;
const REPO_CACHE_TTL_MS = 5 * 60 * 1000;
const TOAST_DEFAULT_DISMISS_MS = 3000;
const TOAST_DEPLOY_SUCCESS_DISMISS_MS = 6000;
const TOAST_EXIT_MS = 200;
const LOG_LINE_STAGE_PREFIX_PATTERN = /^\s*\[(build|deploy)\]\s*/i;
// eslint-disable-next-line no-control-regex -- Strip ANSI terminal escapes from deployment logs.
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;
let csrfRefreshInFlight = null;

const AnalyticsBundle = lazy(() => import("./components/AnalyticsBundle"));

function getCorePollIntervalMs() {
  if (typeof document === "undefined") {
    return CORE_POLL_VISIBLE_MS;
  }
  return document.visibilityState === "visible" ? CORE_POLL_VISIBLE_MS : CORE_POLL_HIDDEN_MS;
}

function normalizeEnvVarKey(key) {
  return String(key || "")
    .trim()
    .toUpperCase();
}

function createEmptyEnvVarRow() {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    key: "",
    value: "",
    isSecret: true,
  };
}

const ENV_INPUT_HINTS = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
  "data-lpignore": "true",
  "data-1p-ignore": "true",
  "data-form-type": "other",
  "data-bwignore": "true",
};

function EnvKeySuggestions({ onPick }) {
  return (
    <div className="env-suggestions">
      <span className="muted">Quick keys:</span>
      {ENV_KEY_SUGGESTIONS.map((key) => (
        <button key={key} type="button" className="env-chip" onClick={() => onPick(key)}>
          {key}
        </button>
      ))}
    </div>
  );
}

function SecretIcon({ secret = true }) {
  if (secret) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect
          x="6.4"
          y="10.5"
          width="11.2"
          height="9"
          rx="2.2"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M8.5 10.5V8.6a3.5 3.5 0 0 1 7 0v1.9"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="12" cy="14.8" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="6.4"
        y="10.5"
        width="11.2"
        height="9"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M8.5 10.5V8.6a3.5 3.5 0 0 1 6.1-2.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M13.7 6.1l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SecretToggle({ value, onChange, disabled = false }) {
  return (
    <button
      type="button"
      className={`secret-icon-toggle ${value ? "secret" : "plain"}`}
      onClick={() => onChange?.(!value)}
      disabled={disabled}
      aria-label={value ? "Secret value mode" : "Plain text value mode"}
      title={value ? "Secret value mode (encrypted at rest)" : "Plain text value mode"}
    >
      <SecretIcon secret={value} />
    </button>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 8.7a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M19.4 13.1a7.9 7.9 0 0 0 0-2.2l2-1.5-2-3.5-2.4 1a7.8 7.8 0 0 0-1.9-1.1l-.3-2.6h-4l-.3 2.6a7.8 7.8 0 0 0-1.9 1.1l-2.4-1-2 3.5 2 1.5a7.9 7.9 0 0 0 0 2.2l-2 1.5 2 3.5 2.4-1c.6.5 1.2.8 1.9 1.1l.3 2.6h4l.3-2.6c.7-.3 1.3-.6 1.9-1.1l2.4 1 2-3.5-2-1.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 18l-6-6 6-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TemplateReactIcon() {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle cx="32" cy="32" r="4.6" fill="#61DAFB" />
      <ellipse cx="32" cy="32" rx="20" ry="8.5" stroke="#61DAFB" strokeWidth="3" />
      <ellipse
        cx="32"
        cy="32"
        rx="20"
        ry="8.5"
        stroke="#61DAFB"
        strokeWidth="3"
        transform="rotate(60 32 32)"
      />
      <ellipse
        cx="32"
        cy="32"
        rx="20"
        ry="8.5"
        stroke="#61DAFB"
        strokeWidth="3"
        transform="rotate(120 32 32)"
      />
    </svg>
  );
}

function TemplateNextIcon() {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle
        cx="32"
        cy="32"
        r="26"
        fill="#0f1115"
        stroke="rgba(255,255,255,0.34)"
        strokeWidth="2.2"
      />
      <path d="M21 41V23h3.2l12.6 14.9V23H43v18h-3.2L27.2 26.1V41H21z" fill="#F5F7FA" />
    </svg>
  );
}

function TemplateHtmlIcon() {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path d="M10 8h44l-4.4 42.8L32 56l-17.6-5.2L10 8z" fill="#E44D26" />
      <path d="M32 12h18l-3.7 35L32 51.4V12z" fill="#F16529" />
      <path
        d="M32 23h9.2l.6-6H32v-5.8h16L46.2 29H32v-6zm0 15.2v6l8.1-2.4.6-7.1H32v3.5z"
        fill="#EBEBEB"
      />
      <path
        d="M32 23v6h-8.7l-.6-6H32zm0-11.8V17h-16l-.4-5.8H32zm0 23.5v9.5L23.9 42l-.5-6.3H32z"
        fill="#fff"
      />
    </svg>
  );
}

function QuickTemplateIcon({ kind }) {
  if (kind === "nextjs") {
    return <TemplateNextIcon />;
  }
  if (kind === "html") {
    return <TemplateHtmlIcon />;
  }
  return <TemplateReactIcon />;
}

function TerminalLockIcon() {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect
        x="5.5"
        y="8.5"
        width="29"
        height="22"
        rx="4.5"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M13 20l4-4m-4 4l4 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M20.5 24h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect
        x="25.5"
        y="24.5"
        width="16"
        height="13"
        rx="3.2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M30 24.5V22a3.5 3.5 0 1 1 7 0v2.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SearchOffIcon() {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="20" cy="20" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M26 26l9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M16.5 16.5l7 7m0-7l-7 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SidebarTabIcon({ tabId, size = 18 }) {
  const commonProps = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
  };
  switch (tabId) {
    case "overview":
      return (
        <svg {...commonProps}>
          <path d="M3.5 11.5 12 4.5l8.5 7" />
          <path d="M6.8 10.6V20h10.4v-9.4" />
        </svg>
      );
    case "projects":
      return (
        <svg {...commonProps}>
          <path d="M3.5 7.3h6.9l1.9 2.3h8.2V18a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" />
          <path d="M3.5 7.3V6a2 2 0 0 1 2-2h3.6" />
        </svg>
      );
    case "deployments":
      return (
        <svg {...commonProps}>
          <path d="M12 4v12" />
          <path d="m7.5 11.5 4.5 4.5 4.5-4.5" />
          <path d="M4 20h16" />
        </svg>
      );
    case "analytics":
      return (
        <svg {...commonProps}>
          <path d="M4 19V5" />
          <path d="M4 19h16" />
          <path d="M7.5 15.5 11 12l3 2.4 4.2-6.1" />
          <path d="M18.2 8.3h-3.1" />
        </svg>
      );
    case "domains":
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="8.1" />
          <path d="M4 12h16" />
          <path d="M12 3.9c2.5 2.3 2.5 13.9 0 16.2" />
          <path d="M12 3.9c-2.5 2.3-2.5 13.9 0 16.2" />
        </svg>
      );
    case "admin":
      return (
        <svg {...commonProps}>
          <path d="m12 3 7 3.6v5.1c0 4.6-3 7.6-7 8.8-4-1.2-7-4.2-7-8.8V6.6z" />
          <path d="m9.6 12.3 1.8 1.8 3.2-3.4" />
        </svg>
      );
    case "github":
    case "integrations":
      return (
        <svg {...commonProps}>
          <path d="M8.9 18v-2.1c0-1-.3-1.6-1.1-1.6-2.2 0-3.6-1.7-3.6-3.8 0-.9.3-1.7.9-2.3-.2-.5-.2-1.5.1-2.2 0 0 .8-.4 2.6 1 .8-.2 1.6-.3 2.4-.3s1.6.1 2.4.3c1.8-1.4 2.6-1 2.6-1 .3.7.3 1.7.1 2.2.6.6.9 1.4.9 2.3 0 2.1-1.4 3.8-3.6 3.8-.8 0-1.1.6-1.1 1.6V18" />
          <path d="M8.9 18c-.9.2-2.1.2-3 0" />
        </svg>
      );
    case "templates":
      return (
        <svg {...commonProps}>
          <path d="M5.5 3.8h8.6l4.4 4.4V20H5.5z" />
          <path d="M14.1 3.8v4.4h4.4" />
          <path d="M8.5 13h7" />
          <path d="M8.5 16.3h5.6" />
        </svg>
      );
    case "tier":
      return (
        <svg {...commonProps}>
          <path d="M4.5 7.2h15a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V9.2a2 2 0 0 1 2-2z" />
          <path d="M7.8 12.1h8.4" />
          <path d="M10.2 10.1h3.6a1.8 1.8 0 1 1 0 3.6h-3.6a1.8 1.8 0 1 0 0 3.6h3.9" />
        </svg>
      );
    case "eject":
      return (
        <svg {...commonProps}>
          <path d="M12 3v10.5" />
          <path d="m7.8 8.2 4.2-4.2 4.2 4.2" />
          <path d="M5 13.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4.5" />
        </svg>
      );
    case "team":
      return (
        <svg {...commonProps}>
          <circle cx="8.5" cy="8.5" r="2.7" />
          <circle cx="16.5" cy="9.5" r="2.3" />
          <path d="M3.8 19c1.1-3.1 2.7-4.6 4.9-4.6s3.8 1.5 4.9 4.6" />
          <path d="M13.3 15.3c1-.7 2.1-.9 3.2-.7 1.7.3 2.9 1.7 3.7 4.4" />
        </svg>
      );
    case "profile":
    case "settings":
      return (
        <svg {...commonProps}>
          <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z" />
          <path d="M19.4 13.5a7.9 7.9 0 0 0 0-3l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A8 8 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5a7.9 7.9 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5A8 8 0 0 0 17 17.5l2.4 1 2-3.5z" />
        </svg>
      );
    default:
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}

function ThemeModeIcon({ mode }) {
  const props = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
  };
  if (mode === "light") {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.8v2.1M12 19.1v2.1M4.2 4.2l1.5 1.5M18.3 18.3l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <path d="M20.2 14.1A7.6 7.6 0 0 1 9.9 3.8 8.4 8.4 0 1 0 20.2 14.1z" />
    </svg>
  );
}

function ExternalLinkIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 5h5v5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m19 5-8 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11 6H6.7A2.7 2.7 0 0 0 4 8.7v8.6A2.7 2.7 0 0 0 6.7 20h8.6a2.7 2.7 0 0 0 2.7-2.7V13"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function KebabIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5.5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="18.5" r="1.7" />
    </svg>
  );
}

function MenuItemIcon({ kind, size = 15 }) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
  };
  switch (kind) {
    case "settings":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="2.6" />
          <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
        </svg>
      );
    case "redeploy":
      return (
        <svg {...props}>
          <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      );
    case "copy":
      return (
        <svg {...props}>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    default:
      return null;
  }
}

function MetricIcon({ kind }) {
  const props = {
    width: 26,
    height: 26,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
  };
  switch (kind) {
    case "activity":
      return (
        <svg {...props}>
          <path d="M4 16.5c2.2 0 2.2-5 4.4-5s2.2 5 4.4 5 2.2-8.2 4.4-8.2 2.2 3.2 4.4 3.2" />
        </svg>
      );
    case "time":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="8.2" />
          <path d="M12 7.5v5l3.3 2" />
        </svg>
      );
    case "layers":
      return (
        <svg {...props}>
          <path d="m12 3.8 8 4.3-8 4.3-8-4.3z" />
          <path d="m4 12 8 4.3 8-4.3" />
          <path d="m4 16 8 4.3 8-4.3" />
        </svg>
      );
    case "github":
      return <GitHubMark />;
    default:
      return null;
  }
}

function ProjectsEmptyState({ icon, title, subtitle }) {
  return (
    <div className="projects-empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <h3>{title}</h3>
      <p>{subtitle}</p>
    </div>
  );
}

function sortDeploymentsDesc(items) {
  return [...(items || [])].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function getProjectDeployments(project, deployments) {
  if (!project) return [];
  return sortDeploymentsDesc(
    (deployments || []).filter((deployment) => projectMatchesDeployment(project, deployment)),
  );
}

function getLatestDeployment(project, deployments) {
  return getProjectDeployments(project, deployments)[0] || null;
}

function projectInitials(project) {
  const title = projectTitle(project);
  const letters = title
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return letters || "A3";
}

function deploymentTone(status) {
  const normalized = String(status || "").toLowerCase();
  if (
    normalized.includes("success") ||
    normalized.includes("succeed") ||
    normalized.includes("ready")
  )
    return "ok";
  if (normalized.includes("fail") || normalized.includes("error")) return "error";
  if (normalized.includes("build") || normalized.includes("run") || normalized.includes("queue"))
    return "running";
  return "";
}

function projectRuntimeStatus(project, deployments) {
  const latest = getLatestDeployment(project, deployments);
  if (latest) {
    return {
      label: formatDeploymentStatus(latest.status),
      className: deploymentTone(latest.status),
    };
  }
  if (project?.repoUrl) {
    return {
      label: projectHostedUrl(project) ? "Ready" : "Connected",
      className: projectHostedUrl(project) ? "ok" : "",
    };
  }
  return { label: "Repo needed", className: "warning" };
}

function projectBranch(project) {
  return project?.branch || project?.github?.branch || project?.gitlab?.branch || "main";
}

function projectProviderLabel(project) {
  const provider = projectGitProvider(project);
  if (provider === "gitlab") return "GitLab";
  if (provider === "github") return "GitHub";
  return project?.repoUrl ? "Git" : "Manual";
}

function readCookieValue(name) {
  const encodedName = `${encodeURIComponent(name)}=`;
  const parts = String(document.cookie || "").split("; ");
  for (const part of parts) {
    if (part.startsWith(encodedName)) {
      return decodeURIComponent(part.slice(encodedName.length));
    }
  }
  return "";
}

function isMutatingMethod(method) {
  const normalized = String(method || "GET").toUpperCase();
  return (
    normalized === "POST" ||
    normalized === "PUT" ||
    normalized === "PATCH" ||
    normalized === "DELETE"
  );
}

async function refreshSessionForCsrf() {
  if (csrfRefreshInFlight) {
    return csrfRefreshInFlight;
  }
  const refreshUrl = API_BASE ? `${API_BASE}/session` : "/session";
  csrfRefreshInFlight = fetch(refreshUrl, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  })
    .catch(() => null)
    .finally(() => {
      csrfRefreshInFlight = null;
    });
  return csrfRefreshInFlight;
}

function apiFetch(path, options = {}) {
  const url = API_BASE ? `${API_BASE}${path}` : path;
  const method = String(options.method || "GET").toUpperCase();
  const mutating = isMutatingMethod(method);

  async function isInvalidCsrfResponse(res) {
    if (!res || res.status !== 403) {
      return false;
    }
    let errorText;
    try {
      const data = await res.clone().json();
      errorText = String(data?.error || data?.message || "");
    } catch {
      errorText = await res
        .clone()
        .text()
        .catch(() => "");
    }
    return errorText.toLowerCase().includes("csrf");
  }

  function buildHeaders(forceCsrf = false) {
    const headers = new Headers(options.headers || {});
    if (mutating) {
      const csrfToken = readCookieValue(CSRF_COOKIE);
      if (csrfToken && (forceCsrf || !headers.has(CSRF_HEADER))) {
        headers.set(CSRF_HEADER, csrfToken);
      }
    }
    return headers;
  }

  return fetch(url, {
    credentials: "include",
    ...options,
    method,
    headers: buildHeaders(false),
  }).then(async (res) => {
    if (!mutating) {
      return res;
    }
    if (!(await isInvalidCsrfResponse(res))) {
      return res;
    }
    await refreshSessionForCsrf();
    return fetch(url, {
      credentials: "include",
      ...options,
      method,
      headers: buildHeaders(true),
    });
  });
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function statusClass(status) {
  const tone = (status || "").toLowerCase();
  if (tone.includes("success") || tone.includes("succeed") || tone.includes("completed")) {
    return "ok";
  }
  if (tone.includes("fail") || tone.includes("error")) return "error";
  if (tone.includes("process") || tone.includes("run") || tone.includes("progress"))
    return "running";
  if (tone.includes("queue") || tone.includes("pending")) return "pending";
  return "";
}

function stageStatusClass(status) {
  const tone = String(status || "").toLowerCase();
  if (tone.includes("success") || tone.includes("succeed")) {
    return "ok";
  }
  if (tone.includes("fail") || tone.includes("error")) {
    return "error";
  }
  if (tone.includes("run")) {
    return "running";
  }
  return "pending";
}

function isQueuedStatus(status) {
  const tone = String(status || "").toLowerCase();
  return tone.includes("queue") || tone.includes("pending");
}

function isRunningStatus(status) {
  const tone = String(status || "").toLowerCase();
  return tone.includes("run") || tone.includes("progress") || tone.includes("process");
}

function formatStageStatus(status) {
  const tone = String(status || "").toLowerCase();
  if (tone.includes("success") || tone.includes("succeed")) return "Succeeded";
  if (tone.includes("fail") || tone.includes("error")) return "Failed";
  if (tone.includes("run")) return "Running";
  if (tone.includes("cancel")) return "Canceled";
  return "Pending";
}

function formatDeploymentStatus(status) {
  const tone = String(status || "").toLowerCase();
  if (tone.includes("success") || tone.includes("succeed")) return "Succeeded";
  if (tone.includes("fail") || tone.includes("error")) return "Failed";
  if (tone.includes("process") || tone.includes("run") || tone.includes("progress")) {
    return "Processing";
  }
  if (tone.includes("queue") || tone.includes("pending")) {
    return "Queued";
  }
  return status || "Unknown";
}

function formatQueueHint(queue) {
  if (!queue) {
    return "Queued — waiting for canister";
  }
  if (Number.isFinite(queue.position) && Number.isFinite(queue.totalForCanister)) {
    return `Queued — waiting for canister (${queue.position} of ${queue.totalForCanister})`;
  }
  const bucket = String(queue.bucket || "").toLowerCase();
  if (bucket === "next_up") {
    return "Queued — next up";
  }
  if (bucket === "few_ahead") {
    return "Queued — few ahead";
  }
  if (bucket === "in_queue") {
    return "Queued — waiting in queue";
  }
  return "Queued — waiting for canister";
}

const DEPLOY_FAILURE_HINT_RULES = [
  {
    id: "branch_missing",
    pattern: /remote branch .* not found|couldn't find remote ref|pathspec .* did not match/i,
    reason: "Selected branch was not found.",
    hint: "Set the correct branch in Project Settings, then redeploy.",
  },
  {
    id: "repo_access",
    pattern:
      /repository .* not found|resource not accessible by integration|not accessible through this installation|authentication failed|access denied/i,
    reason: "Repository access failed.",
    hint: "Reconnect your Git provider and verify this repo is accessible.",
  },
  {
    id: "missing_build_command",
    pattern: /no "build" script defined|missing script:\s*build/i,
    reason: "Build command is missing.",
    hint: "Set a valid Build Command in Project Settings and redeploy.",
  },
  {
    id: "missing_output",
    pattern:
      /unable to detect static assets|assets directory .* does not exist|output directory .* does not exist|build output .* not found/i,
    reason: "Build output folder was not found.",
    hint: "Set the correct Output Directory in Project Settings (for example dist or build).",
  },
  {
    id: "runner_startup",
    pattern:
      /containercreating|container .* is waiting to start|unable to retrieve container logs|imagepullbackoff|errimagepull/i,
    reason: "Runner container did not start in time.",
    hint: "Retry deploy. If this repeats, platform support must check cluster capacity.",
  },
  {
    id: "timeout",
    pattern: /timed out|deadline exceeded|activeDeadlineSeconds|context deadline exceeded/i,
    reason: "Deployment timed out.",
    hint: "Reduce build time or output size and redeploy.",
  },
  {
    id: "memory",
    pattern: /exit(?:ed)? code 137|oomkilled|out of memory|killed process/i,
    reason: "Build ran out of memory.",
    hint: "Optimize the build workload or dependencies, then redeploy.",
  },
  {
    id: "package_manager",
    pattern: /npm err!|pnpm .*err|yarn error/i,
    reason: "Install or build command failed.",
    hint: "Check your dependency lockfile and build scripts, then redeploy.",
  },
];

function sanitizeLogLine(value) {
  return String(value || "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .trim();
}

function extractStageLogLines(logs, stageName) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return [];
  }
  const normalizedStage = String(stageName || "")
    .trim()
    .toLowerCase();
  const stagePrefix = normalizedStage ? `[${normalizedStage}]` : "";
  const stageLines = [];
  for (const rawLine of logs) {
    const line = sanitizeLogLine(rawLine);
    if (!line) continue;
    if (!stagePrefix) {
      stageLines.push(line);
      continue;
    }
    if (line.toLowerCase().startsWith(stagePrefix)) {
      stageLines.push(line.replace(LOG_LINE_STAGE_PREFIX_PATTERN, "").trim());
    }
  }
  return stageLines;
}

function inferDeploymentFailureHint(deployment, stageName) {
  const rawLogs = Array.isArray(deployment?.logs) ? deployment.logs : [];
  const stageLogs = extractStageLogLines(rawLogs, stageName);
  const normalizedLogs = stageLogs.length
    ? stageLogs
    : rawLogs.map((line) => sanitizeLogLine(line)).filter(Boolean);
  const tailLines = normalizedLogs.slice(-220);
  const haystack = tailLines.join("\n");
  for (const rule of DEPLOY_FAILURE_HINT_RULES) {
    if (rule.pattern.test(haystack)) {
      return {
        reason: rule.reason,
        hint: rule.hint,
      };
    }
  }
  return {
    reason: "An unexpected deployment error occurred.",
    hint: "Open deployment logs and check the last error lines before redeploying.",
  };
}

function GraphCardsFallback() {
  return (
    <>
      <section className="card graph-card modern">
        <div className="card-head">
          <div className="graph-title">
            <h2>Deployment Activity</h2>
            <span className="muted">Loading chart…</span>
          </div>
          <span className="graph-pill">-</span>
        </div>
        <div className="chart-empty-state">
          <p>Loading chart…</p>
        </div>
      </section>
      <section className="card graph-card modern">
        <div className="card-head">
          <div className="graph-title">
            <h2>Build Duration</h2>
            <span className="muted">Loading chart…</span>
          </div>
          <span className="graph-pill">-</span>
        </div>
        <div className="chart-empty-state is-build">
          <p>Loading chart…</p>
        </div>
      </section>
    </>
  );
}

function normalizeDeploymentStages(stages) {
  const input = stages && typeof stages === "object" ? stages : {};
  const out = {};
  for (const stage of DEPLOYMENT_STAGES) {
    const row = input[stage] && typeof input[stage] === "object" ? input[stage] : {};
    out[stage] = {
      status: String(row.status || "pending").toLowerCase(),
      startedAt:
        typeof row.startedAt === "number" && Number.isFinite(row.startedAt) ? row.startedAt : null,
      finishedAt:
        typeof row.finishedAt === "number" && Number.isFinite(row.finishedAt)
          ? row.finishedAt
          : null,
      jobName: typeof row.jobName === "string" ? row.jobName : null,
    };
  }
  return out;
}

function parseStageMarkerLine(line) {
  const match = STAGE_MARKER_PATTERN.exec(String(line || "").trim());
  if (!match) return null;
  return {
    stage: match[1].toLowerCase(),
    action: match[2].toUpperCase(),
    result: (match[3] || "").toLowerCase() || null,
  };
}

function formatDurationMs(value) {
  if (value == null || !Number.isFinite(value)) return "-";
  const sec = Math.max(0, Math.round(value / 1000));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  if (mm > 0) {
    return `${mm}m ${String(ss).padStart(2, "0")}s`;
  }
  return `${ss}s`;
}

function maskWebhook(value) {
  if (!value) return "Not set";
  try {
    const url = new URL(value);
    const masked = new URL(url.origin + url.pathname);
    for (const [key, val] of url.searchParams.entries()) {
      const tail = val ? val.slice(-4) : "";
      masked.searchParams.set(key, tail ? "****" + tail : "");
    }
    return masked.toString();
  } catch {
    const tail = value.slice(-4);
    return "****" + tail;
  }
}

function projectTitle(project) {
  return (
    project.github?.fullName ||
    project.gitlab?.pathWithNamespace ||
    project.tenant?.slug ||
    project.id
  );
}

function projectGitProvider(project) {
  const provider = String(project?.gitProvider || (project?.gitlab ? "gitlab" : "github"))
    .trim()
    .toLowerCase();
  return provider === "gitlab" ? "gitlab" : "github";
}

function projectWebhookAuthLabel(project) {
  if (projectGitProvider(project) === "gitlab") {
    return "GitLab token (`x-gitlab-token`)";
  }
  return "GitHub signature (`x-hub-signature-256`)";
}

function normalizeHostedExternalUrl(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(raw)) {
    return `https://${raw}`;
  }
  return null;
}

function slugifyTemplateValue(value, fallback = "new-project") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return normalized || fallback;
}

function projectHostedUrl(project) {
  return normalizeHostedExternalUrl(project?.tenant?.hostedUrl);
}

function projectHostedHost(project) {
  const hostedUrl = projectHostedUrl(project);
  if (!hostedUrl) return "No URL yet";
  try {
    const parsed = new URL(hostedUrl);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return hostedUrl.replace(/^https?:\/\//, "");
  }
}

function projectMatchesDeployment(project, deployment) {
  return deployment.project?.id === project.id || deployment.projectId === project.id;
}

async function parseError(res, fallback) {
  const data = await res.json().catch(() => ({}));
  return data?.error || fallback;
}

function authErrorMessageForCode(code) {
  const normalized = String(code || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "github_not_configured") {
    return "GitHub sign-in is temporarily unavailable. Please try again shortly.";
  }
  if (normalized === "gitlab_not_configured") {
    return "GitLab sign-in is temporarily unavailable. Please try again shortly.";
  }
  return "Authentication could not be started. Please retry.";
}

function createUnauthedSessionState(previous = null) {
  return {
    authenticated: false,
    user: null,
    github: null,
    gitlab: null,
    githubAuthEnabled: previous?.githubAuthEnabled !== false,
    gitlabAuthEnabled: previous?.gitlabAuthEnabled !== false,
    githubAppEnabled: Boolean(previous?.githubAppEnabled),
    localAuthEnabled: Boolean(previous?.localAuthEnabled ?? true),
  };
}

function normalizeBuildSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    framework: source.framework ?? DEFAULT_BUILD.framework,
    rootDir: source.rootDir ?? DEFAULT_BUILD.rootDir,
    installCommand: source.installCommand ?? DEFAULT_BUILD.installCommand,
    buildCommand: source.buildCommand ?? DEFAULT_BUILD.buildCommand,
    outputDir: source.outputDir ?? DEFAULT_BUILD.outputDir,
  };
}

function buildSettingsEqual(a, b) {
  const left = normalizeBuildSettings(a);
  const right = normalizeBuildSettings(b);
  return (
    left.framework === right.framework &&
    left.rootDir === right.rootDir &&
    left.installCommand === right.installCommand &&
    left.buildCommand === right.buildCommand &&
    left.outputDir === right.outputDir
  );
}

function Toasts({ items, onClose, onPause, onResume }) {
  return (
    <div className="toast-stack">
      {items.map((item) => (
        <article
          key={item.id}
          className={`toast ${item.type || "info"} ${item.closing ? "closing" : ""}`}
          onMouseEnter={() => onPause?.(item.id)}
          onMouseLeave={() => onResume?.(item.id)}
          onClick={() => onClose(item.id, { immediate: true })}
        >
          <p>{item.message}</p>
          <div className="toast-actions">
            {item.actionLabel ? (
              <button
                type="button"
                className="toast-action-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  item.onAction?.();
                  onClose(item.id, { immediate: true });
                }}
              >
                {item.actionLabel}
              </button>
            ) : null}
            <button
              type="button"
              className="toast-close-btn"
              onClick={(event) => {
                event.stopPropagation();
                onClose(item.id, { immediate: true });
              }}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

const AUTH_CANVAS_GRID_SPACING = 16;
const AUTH_CANVAS_DOT_RADIUS = 1.45;
const AUTH_CANVAS_BLOB_COUNT = 24;

function authCanvasRandomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function authCanvasClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function authCanvasLerp(start, end, t) {
  return start + (end - start) * t;
}

function authCanvasPaletteColor(t) {
  const u = ((t % 1) + 1) % 1;
  if (u < 0.33) {
    const k = u / 0.33;
    return {
      r: Math.round(authCanvasLerp(36, 124, k)),
      g: Math.round(authCanvasLerp(146, 72, k)),
      b: Math.round(authCanvasLerp(255, 240, k)),
    };
  }
  if (u < 0.66) {
    const k = (u - 0.33) / 0.33;
    return {
      r: Math.round(authCanvasLerp(124, 255, k)),
      g: Math.round(authCanvasLerp(72, 72, k)),
      b: Math.round(authCanvasLerp(240, 190, k)),
    };
  }
  const k = (u - 0.66) / 0.34;
  return {
    r: Math.round(authCanvasLerp(255, 241, k)),
    g: Math.round(authCanvasLerp(72, 90, k)),
    b: Math.round(authCanvasLerp(190, 36, k)),
  };
}

function createAuthCanvasDots(width, height) {
  const dots = [];
  const start = AUTH_CANVAS_GRID_SPACING / 2;
  for (let gy = 0, y = start; y <= height - start; y += AUTH_CANVAS_GRID_SPACING, gy += 1) {
    for (let gx = 0, x = start; x <= width - start; x += AUTH_CANVAS_GRID_SPACING, gx += 1) {
      dots.push({ x, y, gx, gy });
    }
  }
  return dots;
}

function createAuthCanvasBlobs(width, height, now) {
  return Array.from({ length: AUTH_CANVAS_BLOB_COUNT }, () => {
    const x = authCanvasRandomBetween(width * 0.08, width * 0.92);
    const y = authCanvasRandomBetween(height * 0.08, height * 0.92);
    const velocityAngle = authCanvasRandomBetween(0, Math.PI * 2);
    const speed = authCanvasRandomBetween(0.5, 1.2);
    return {
      x,
      y,
      vx: Math.cos(velocityAngle) * speed,
      vy: Math.sin(velocityAngle) * speed,
      radius: authCanvasRandomBetween(42, 84),
      colorValue: authCanvasRandomBetween(0, 1),
      nextImpulseAt: now + authCanvasRandomBetween(380, 1200),
    };
  });
}

function AuthPanelCanvas() {
  const canvasWrapRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = canvasWrapRef.current;
    if (!canvas || !wrap) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    let width = 0;
    let height = 0;
    let dots = [];
    let blobs = [];
    let frameId = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = wrap.clientWidth;
      height = wrap.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = createAuthCanvasDots(width, height);
      blobs = createAuthCanvasBlobs(width, height, performance.now());
    };

    const updateBlobs = (now) => {
      const edgeMargin = 56;
      for (const blob of blobs) {
        if (now >= blob.nextImpulseAt) {
          const angle = authCanvasRandomBetween(0, Math.PI * 2);
          const impulse = authCanvasRandomBetween(0.24, 0.82);
          blob.vx += Math.cos(angle) * impulse;
          blob.vy += Math.sin(angle) * impulse;
          blob.nextImpulseAt = now + authCanvasRandomBetween(380, 1200);
        }

        const seconds = now * 0.00055;
        const flowX =
          Math.sin(blob.y * 0.013 + seconds * 0.7 + blob.colorValue * Math.PI * 2) +
          Math.sin(blob.x * 0.009 - seconds * 0.52);
        const flowY =
          Math.cos(blob.x * 0.011 - seconds * 0.62 + blob.colorValue * Math.PI * 2) -
          Math.cos(blob.y * 0.01 + seconds * 0.58);

        blob.vx += flowX * 0.03;
        blob.vy += flowY * 0.03;

        if (blob.x < edgeMargin) {
          blob.vx += ((edgeMargin - blob.x) / edgeMargin) * 0.12;
        } else if (blob.x > width - edgeMargin) {
          blob.vx -= ((blob.x - (width - edgeMargin)) / edgeMargin) * 0.12;
        }
        if (blob.y < edgeMargin) {
          blob.vy += ((edgeMargin - blob.y) / edgeMargin) * 0.12;
        } else if (blob.y > height - edgeMargin) {
          blob.vy -= ((blob.y - (height - edgeMargin)) / edgeMargin) * 0.12;
        }
      }

      for (let i = 0; i < blobs.length; i += 1) {
        for (let j = i + 1; j < blobs.length; j += 1) {
          const a = blobs[i];
          const b = blobs[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.hypot(dx, dy) || 1;
          const nx = dx / distance;
          const ny = dy / distance;
          if (distance < 62) {
            const push = ((62 - distance) / 62) * 0.12;
            a.vx -= nx * push;
            a.vy -= ny * push;
            b.vx += nx * push;
            b.vy += ny * push;
          } else if (distance > 280) {
            const pull = Math.min((distance - 280) / 280, 1) * 0.0016;
            a.vx += nx * pull;
            a.vy += ny * pull;
            b.vx -= nx * pull;
            b.vy -= ny * pull;
          }
        }
      }

      for (const blob of blobs) {
        blob.vx *= 0.994;
        blob.vy *= 0.994;
        const speed = Math.hypot(blob.vx, blob.vy);
        if (speed > 1.45) {
          const factor = 1.45 / speed;
          blob.vx *= factor;
          blob.vy *= factor;
        }
        blob.x += blob.vx;
        blob.y += blob.vy;
        blob.x = authCanvasClamp(blob.x, 10, width - 10);
        blob.y = authCanvasClamp(blob.y, 10, height - 10);
      }
    };

    const drawDots = (seconds) => {
      const hotPulse = (Math.sin(seconds * 2.2) + 1) * 0.5;
      for (const dot of dots) {
        let energy = 0;
        let weightSum = 0;
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;

        for (const blob of blobs) {
          const breathingRadius =
            blob.radius +
            Math.sin(seconds * 1.2 + blob.colorValue * 9 + blob.x * 0.006) * 6 +
            Math.cos(seconds * 1.06 + blob.y * 0.004) * 5;
          const dx = dot.x - blob.x;
          const dy = dot.y - blob.y;
          const distanceSq = dx * dx + dy * dy + 1;
          const influence = (breathingRadius * breathingRadius) / distanceSq;
          energy += influence;
          const weight = authCanvasClamp((influence - 0.26) * 1.18, 0, 1.2);
          if (weight > 0) {
            const tint = authCanvasPaletteColor(
              blob.colorValue + seconds * 0.034 + Math.sin(blob.y * 0.004) * 0.04,
            );
            rSum += tint.r * weight;
            gSum += tint.g * weight;
            bSum += tint.b * weight;
            weightSum += weight;
          }
        }

        const checkerAlpha = (dot.gx + dot.gy) % 2 === 0 ? 0.95 : 1;
        let r = 44;
        let g = 45;
        let b = 51;
        let alpha = 0.2;
        if (weightSum > 0.02) {
          r = rSum / weightSum;
          g = gSum / weightSum;
          b = bSum / weightSum;
          const sparkle = authCanvasClamp((energy - 2.2) * 0.045, 0, 0.18 + hotPulse * 0.05);
          r = authCanvasClamp(r + 21 * sparkle, 0, 255);
          g = authCanvasClamp(g + 15 * sparkle, 0, 255);
          b = authCanvasClamp(b + 25 * sparkle, 0, 255);
          alpha = authCanvasClamp(0.28 + weightSum * 0.24, 0.28, 0.78);
        }

        context.beginPath();
        context.arc(dot.x, dot.y, AUTH_CANVAS_DOT_RADIUS, 0, Math.PI * 2);
        context.fillStyle = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha * checkerAlpha})`;
        context.fill();
      }
    };

    const tick = (timestamp) => {
      context.clearRect(0, 0, width, height);
      updateBlobs(timestamp);
      drawDots(timestamp / 1000);
      frameId = window.requestAnimationFrame(tick);
    };

    resize();
    frameId = window.requestAnimationFrame(tick);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(wrap);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div ref={canvasWrapRef} className="auth-canvas-wrap">
      <canvas ref={canvasRef} aria-hidden className="auth-canvas" />
    </div>
  );
}

function repoSelectionKey(repo) {
  if (!repo) return "";
  const provider = String(repo.provider || "github").toLowerCase();
  return `${provider}:${repo.installationId || ""}:${repo.id || ""}:${repo.fullName || repo.pathWithNamespace || ""}`;
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 1.7a10.3 10.3 0 0 0-3.25 20.08c.51.09.7-.22.7-.5v-1.74c-2.85.62-3.45-1.37-3.45-1.37-.47-1.2-1.15-1.52-1.15-1.52-.95-.65.07-.64.07-.64 1.05.08 1.6 1.08 1.6 1.08.93 1.6 2.45 1.14 3.05.87.1-.67.36-1.14.65-1.4-2.27-.26-4.65-1.14-4.65-5.06 0-1.12.4-2.03 1.06-2.75-.11-.26-.46-1.31.1-2.74 0 0 .87-.28 2.84 1.05a9.8 9.8 0 0 1 5.17 0c1.97-1.33 2.83-1.05 2.83-1.05.57 1.43.21 2.48.1 2.74.66.72 1.06 1.63 1.06 2.75 0 3.93-2.38 4.8-4.66 5.06.37.32.7.95.7 1.92v2.85c0 .28.18.6.7.5A10.3 10.3 0 0 0 12 1.7z"
      />
    </svg>
  );
}

function GitLabMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M22.7 9.5 20.5 2.9a1.2 1.2 0 0 0-1.1-.8h-14.8c-.5 0-.9.3-1.1.8L1.3 9.5a1.6 1.6 0 0 0 .4 1.7l10.3 10.4 10.3-10.4c.4-.4.5-1.1.4-1.7ZM8.3 8.6l1.4 4.3H4.2l4.1-4.3Zm2.2 0h2.9l1.4 4.3h-5.7l1.4-4.3Zm4.3 0 4.1 4.3h-5.5l1.4-4.3ZM6.2 4.3h4.6L9.4 7.8 6.2 4.3Zm7 0h4.6l-3.2 3.5-1.4-3.5Zm-1.2 5.3 1.4 4.3h-2.8l1.4-4.3Zm-7.5 5.5h5.7l1.8 4.8-7.5-4.8Zm8 4.7 1.8-4.7h5.7l-7.5 4.7Z"
      />
    </svg>
  );
}

function AuthCard({
  loginName,
  password,
  setLoginName,
  setPassword,
  onSubmit,
  loading,
  localAuthEnabled,
  githubAuthEnabled,
  gitlabAuthEnabled,
  authError,
  onGithubLogin,
  onGitlabLogin,
}) {
  const showGitHubLogin = typeof onGithubLogin === "function" && githubAuthEnabled !== false;
  const showGitLabLogin = typeof onGitlabLogin === "function" && gitlabAuthEnabled !== false;

  return (
    <main className="auth-layout">
      <section className="auth-shell auth-shell-login">
        <div className="auth-card auth-card-login">
          <div className="auth-header auth-header-modern">
            <div className="brand auth-brand-modern">
              <div className="wordmark">A3</div>
            </div>
          </div>
          <h1>Deploy to ICP in seconds</h1>
          <p className="auth-subtitle">
            Continue with GitHub or GitLab. No wallet is required to import a repo and ship.
          </p>
          {authError ? (
            <p className="auth-error-banner" role="alert">
              {authError}
            </p>
          ) : null}

          {showGitHubLogin ? (
            <>
              <button className="github-oauth-btn" type="button" onClick={onGithubLogin}>
                <span className="github-oauth-icon">
                  <GitHubMark />
                </span>
                <span className="github-oauth-copy">
                  <strong>Continue with GitHub</strong>
                  <small>Import repositories and deploy from Git pushes.</small>
                </span>
              </button>
            </>
          ) : null}
          {showGitLabLogin ? (
            <button
              className="github-oauth-btn gitlab-oauth-btn"
              type="button"
              onClick={onGitlabLogin}
            >
              <span className="github-oauth-icon">
                <GitLabMark />
              </span>
              <span className="github-oauth-copy">
                <strong>Continue with GitLab</strong>
                <small>Use GitLab projects with the same A3 deploy flow.</small>
              </span>
            </button>
          ) : null}
          {localAuthEnabled ? (
            <>
              {showGitHubLogin || showGitLabLogin ? (
                <div className="auth-divider">
                  <span>or</span>
                </div>
              ) : null}
              <form
                className="form auth-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  onSubmit();
                }}
              >
                <label className="auth-field">
                  Name
                  <input
                    value={loginName}
                    onChange={(e) => setLoginName(e.target.value)}
                    type="text"
                    required
                    minLength={2}
                    maxLength={80}
                    placeholder="Your display name"
                    autoComplete="username"
                  />
                </label>
                <label className="auth-field">
                  Password
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type="password"
                    required
                    minLength={8}
                    placeholder="********"
                    autoComplete="current-password"
                  />
                </label>
                <button
                  className="btn auth-submit-clean auth-submit-btn"
                  type="submit"
                  disabled={loading}
                >
                  {loading ? "Please wait..." : "Sign in"}
                </button>
              </form>
            </>
          ) : (
            <p className="muted auth-disabled-note">Email/password login is disabled.</p>
          )}
        </div>

        <aside className="auth-visual auth-visual-canvas" aria-hidden="true">
          <AuthPanelCanvas />
        </aside>
      </section>
    </main>
  );
}

function OnboardingCard({ session, loading, onSubmit }) {
  const [displayName, setDisplayName] = useState(
    session?.user?.displayName || session?.github?.name || session?.github?.login || "",
  );
  const [password, setPassword] = useState("");

  return (
    <main className="auth-layout">
      <section className="auth-shell onboarding-shell onboarding-shell-compact">
        <div className="auth-card onboarding-card onboarding-card-compact">
          <div className="brand auth-brand-modern">
            <div className="wordmark">A3</div>
          </div>
          <h1>Complete your profile</h1>
          <p className="auth-subtitle">
            Set your display name and password to finish account setup.
          </p>

          <form
            className="form auth-form onboarding-form-compact"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit({ displayName, password });
            }}
          >
            <label className="auth-field">
              Display name
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                type="text"
                required
                minLength={2}
                maxLength={80}
                placeholder="Your name"
                autoComplete="name"
              />
            </label>
            <label className="auth-field">
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                required
                minLength={8}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </label>
            <button className="btn icp-rim auth-submit-btn" type="submit" disabled={loading}>
              {loading ? "Saving..." : "Continue to dashboard"}
            </button>
          </form>
          <p className="onboarding-footnote">This password is used for fallback local sign in.</p>
        </div>
      </section>
    </main>
  );
}

function BuildSettings({ value, onChange }) {
  const current = normalizeBuildSettings(value || DEFAULT_BUILD);
  function patch(next) {
    onChange({ ...current, ...next });
  }

  return (
    <div className="build-grid">
      <label>
        Framework
        <select value={current.framework} onChange={(e) => patch({ framework: e.target.value })}>
          {FRAMEWORK_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Root dir
        <input
          value={current.rootDir || ""}
          onChange={(e) => patch({ rootDir: e.target.value })}
          placeholder="./"
        />
      </label>
      <label>
        Output dir
        <input
          value={current.outputDir || ""}
          onChange={(e) => patch({ outputDir: e.target.value })}
          placeholder="dist"
        />
      </label>
      <label>
        Build command
        <input
          value={current.buildCommand || ""}
          onChange={(e) => patch({ buildCommand: e.target.value })}
          placeholder="npm run build"
        />
      </label>
      <div className="settings-note">
        Install command overrides are disabled for security. Build command overrides are allowed.
      </div>
    </div>
  );
}

function EnvVarDraftEditor({ rows, setRows }) {
  function addRow() {
    setRows((prev) => [...prev, createEmptyEnvVarRow()]);
  }

  function removeRow(id) {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  function patchRow(id, patch) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  return (
    <div className="env-editor">
      <div className="env-editor-head">
        <h3>Environment Variables</h3>
        <button type="button" className="btn ghost" onClick={addRow}>
          Add variable
        </button>
      </div>
      <p className="muted env-help">
        Use uppercase keys like <code>VITE_API_BASE_URL</code> or{" "}
        <code>NEXT_PUBLIC_API_BASE_URL</code>.
      </p>
      {!rows.length ? <p className="muted">No variables yet.</p> : null}
      {rows.map((row) => (
        <div key={row.id} className="env-row">
          <input
            value={row.key}
            onChange={(e) => patchRow(row.id, { key: normalizeEnvVarKey(e.target.value) })}
            placeholder="Variable key"
            {...ENV_INPUT_HINTS}
          />
          <input
            value={row.value}
            onChange={(e) => patchRow(row.id, { value: e.target.value })}
            placeholder="Variable value"
            type="text"
            name={`env_value_${row.id}`}
            {...ENV_INPUT_HINTS}
          />
          <SecretToggle
            value={row.isSecret}
            onChange={(next) => patchRow(row.id, { isSecret: next })}
          />
          <button type="button" className="btn ghost danger" onClick={() => removeRow(row.id)}>
            Delete
          </button>
          <EnvKeySuggestions onPick={(key) => patchRow(row.id, { key })} />
        </div>
      ))}
    </div>
  );
}

function DotenvImportDialog({ open, onClose, onParse, onCommit, parsing, preview }) {
  const [content, setContent] = useState("");
  const [conflictPolicy, setConflictPolicy] = useState("replace");

  useEffect(() => {
    if (!open) {
      setContent("");
      setConflictPolicy("replace");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <div className="card-head">
          <h3>Import .env</h3>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <textarea
          className="dotenv-input"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="KEY=value&#10;ANOTHER_KEY=another-value"
          rows={9}
        />
        <div className="actions">
          <button
            type="button"
            className="btn ghost"
            onClick={() => onParse(content)}
            disabled={parsing}
          >
            {parsing ? "Parsing..." : "Preview import"}
          </button>
        </div>

        {preview ? (
          <div className="env-import-preview">
            <p className="muted">
              Parsed {preview.summary?.totalParsed || 0}, conflicts{" "}
              {preview.summary?.existingConflicts || 0}, invalid {preview.summary?.invalid || 0}
            </p>
            {Array.isArray(preview.invalidLines) && preview.invalidLines.length > 0 ? (
              <div className="invalid-lines">
                {preview.invalidLines.map((line, idx) => (
                  <p key={`${line.line}-${idx}`} className="muted">
                    Line {line.line}: {line.error}
                  </p>
                ))}
              </div>
            ) : null}
            <label>
              Conflict policy
              <select value={conflictPolicy} onChange={(e) => setConflictPolicy(e.target.value)}>
                <option value="replace">Replace existing</option>
                <option value="skip">Skip existing</option>
              </select>
            </label>
            <button
              type="button"
              className="btn"
              onClick={() => onCommit(preview, conflictPolicy)}
              disabled={!Array.isArray(preview.validEntries) || preview.validEntries.length === 0}
            >
              Commit import
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DeleteProjectDialog({
  open,
  project,
  confirmToken,
  input,
  setInput,
  acknowledge,
  setAcknowledge,
  step,
  setStep,
  deleting,
  error,
  onClose,
  onDelete,
}) {
  if (!open || !project) {
    return null;
  }

  const canContinue = acknowledge && input === confirmToken;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card delete-project-modal">
        <div className="card-head">
          <h3>Delete Project</h3>
          <button type="button" className="btn ghost" onClick={onClose} disabled={deleting}>
            Close
          </button>
        </div>

        {step === 1 ? (
          <>
            <p className="muted">
              This will permanently delete project settings, environment variables, deployment
              history, and tenant mapping.
            </p>
            <div className="delete-summary">
              <p>
                <strong>Project:</strong> {projectTitle(project)}
              </p>
              <p>
                <strong>Repo:</strong> {project.repoUrl || "not connected"}
              </p>
              <p>
                <strong>URL:</strong> {projectHostedUrl(project) || "none"}
              </p>
            </div>
            <label className="delete-ack">
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(event) => setAcknowledge(event.target.checked)}
              />
              <span>I understand this action is permanent.</span>
            </label>
            <label>
              Type <code>{confirmToken}</code> to continue
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={confirmToken}
                autoComplete="off"
              />
            </label>
            {error ? <p className="admin-error">{error}</p> : null}
            <div className="actions">
              <button type="button" className="btn ghost" onClick={onClose} disabled={deleting}>
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => setStep(2)}
                disabled={!canContinue || deleting}
              >
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">Final confirmation: this cannot be undone.</p>
            <div className="actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => setStep(1)}
                disabled={deleting}
              >
                Back
              </button>
              <button type="button" className="btn danger" onClick={onDelete} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete permanently"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NewProjectView({
  repos,
  githubLinked,
  gitlabLinked,
  onEnsureRepos,
  onCancel,
  onCreate,
  creating,
  onToast,
  session,
  deploymentRegions,
  onReloadDeploymentRegions,
}) {
  const initialProvider = githubLinked ? "github" : gitlabLinked ? "gitlab" : "github";
  const [projectName, setProjectName] = useState("");
  const [provider, setProvider] = useState(initialProvider);
  const [repoKey, setRepoKey] = useState("");
  const [repoFilter, setRepoFilter] = useState("");
  const [branch, setBranch] = useState("main");
  const [routingVisibility, setRoutingVisibility] = useState("public");
  const [region, setRegion] = useState("global");
  const [settings, setSettings] = useState({ ...DEFAULT_BUILD });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [envRows, setEnvRows] = useState([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const providerLinked = provider === "gitlab" ? gitlabLinked : githubLinked;
  const isPro = Boolean(session?.billing?.isPro);
  const privateRegions = Array.isArray(deploymentRegions?.private) ? deploymentRegions.private : [];
  const providerRepos = useMemo(
    () => repos.filter((item) => String(item.provider || "github").toLowerCase() === provider),
    [repos, provider],
  );
  const selectedRepo = useMemo(
    () => providerRepos.find((item) => repoSelectionKey(item) === repoKey) || null,
    [providerRepos, repoKey],
  );
  const filteredProviderRepos = useMemo(() => {
    const q = repoFilter.trim().toLowerCase();
    if (!q) return providerRepos;
    return providerRepos.filter((item) =>
      String(item.fullName || "")
        .toLowerCase()
        .includes(q),
    );
  }, [providerRepos, repoFilter]);

  useEffect(() => {
    if (!githubLinked && provider === "github" && gitlabLinked) {
      setProvider("gitlab");
      return;
    }
    if (!gitlabLinked && provider === "gitlab" && githubLinked) {
      setProvider("github");
    }
  }, [provider, githubLinked, gitlabLinked]);

  useEffect(() => {
    if (!providerLinked) {
      return;
    }
    if (providerRepos.length > 0) {
      return;
    }
    onEnsureRepos?.();
  }, [providerLinked, providerRepos.length, onEnsureRepos]);

  useEffect(() => {
    onReloadDeploymentRegions?.().catch(() => {});
  }, [onReloadDeploymentRegions]);

  useEffect(() => {
    if (!isPro && routingVisibility === "private") {
      setRoutingVisibility("public");
      setRegion("global");
      return;
    }
    if (routingVisibility === "private") {
      const exists = privateRegions.some((item) => item.id === region);
      if (!exists) {
        setRegion(privateRegions[0]?.id || "global");
      }
    }
  }, [isPro, routingVisibility, privateRegions, region]);

  useEffect(() => {
    if (!providerRepos.length) {
      setRepoKey("");
      return;
    }
    if (!providerRepos.some((item) => repoSelectionKey(item) === repoKey)) {
      setRepoKey(repoSelectionKey(providerRepos[0]));
    }
  }, [providerRepos, repoKey]);

  useEffect(() => {
    if (selectedRepo?.defaultBranch && !branch.trim()) {
      setBranch(selectedRepo.defaultBranch);
    }
    if (selectedRepo?.fullName && !projectName.trim()) {
      const repoName = String(selectedRepo.fullName).split("/").pop() || "";
      setProjectName(repoName);
    }
  }, [selectedRepo?.fullName, selectedRepo?.defaultBranch, branch, projectName]);

  function selectRepo(item) {
    setRepoKey(repoSelectionKey(item));
    const repoName =
      String(item?.fullName || "")
        .split("/")
        .pop() || "";
    if (!projectName.trim() && repoName) {
      setProjectName(repoName);
    }
    if (!branch.trim() && item?.defaultBranch) {
      setBranch(item.defaultBranch);
    }
  }

  function parseDotenvLocally(content) {
    const lines = String(content || "").split(/\r?\n/);
    const validEntries = [];
    const invalidLines = [];
    for (let idx = 0; idx < lines.length; idx += 1) {
      const raw = lines[idx];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      const eqIdx = normalized.indexOf("=");
      if (eqIdx <= 0) {
        invalidLines.push({ line: idx + 1, error: "Missing key=value format." });
        continue;
      }
      const key = normalizeEnvVarKey(normalized.slice(0, eqIdx));
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        invalidLines.push({ line: idx + 1, error: "Invalid key format." });
        continue;
      }
      let value = normalized.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      validEntries.push({ key, value, isSecret: true });
    }
    return {
      validEntries,
      invalidLines,
      summary: {
        totalParsed: validEntries.length,
        invalid: invalidLines.length,
      },
    };
  }

  function commitLocalEnvImport(preview, conflictPolicy) {
    const entries = Array.isArray(preview?.validEntries) ? preview.validEntries : [];
    setEnvRows((prev) => {
      const byKey = new Map(prev.map((row) => [normalizeEnvVarKey(row.key), row]));
      for (const entry of entries) {
        const key = normalizeEnvVarKey(entry.key);
        if (!key) continue;
        if (byKey.has(key) && conflictPolicy === "skip") {
          continue;
        }
        byKey.set(key, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          key,
          value: entry.value || "",
          isSecret: entry.isSecret !== false,
        });
      }
      return Array.from(byKey.values());
    });
    setImportOpen(false);
    setImportPreview(null);
  }

  function openQuickTemplate(template) {
    const sourceUrl = String(template?.sourceUrl || "").trim();
    if (!sourceUrl) {
      onToast?.("Template URL is invalid.", "error");
      return;
    }
    try {
      const url = new URL(sourceUrl);
      url.pathname = `${String(url.pathname || "").replace(/\/+$/, "")}/generate`;
      const suggestedRepo = slugifyTemplateValue(
        projectName.trim(),
        template?.suggestedRepoName || "a3-template-app",
      );
      if (suggestedRepo) {
        url.searchParams.set("name", suggestedRepo);
      }
      const popup = window.open(url.toString(), "_blank", "noopener,noreferrer");
      if (!popup) {
        onToast?.("Popup blocked. Open template manually.", "error");
        return;
      }
      if (!projectName.trim()) {
        setProjectName(suggestedRepo);
      }
      setProvider("github");
      onEnsureRepos?.();
    } catch (_error) {
      onToast?.("Couldn't open template.", "error");
    }
  }

  const [step, setStep] = useState(1);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && !importOpen) {
        onCancel?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, importOpen]);

  const sourceCanContinue = providerLinked || repoKey === "";
  const sourceLabel = selectedRepo
    ? selectedRepo.fullName
    : providerRepos.length > 0 && repoKey === ""
      ? "Empty project (no repository)"
      : "No source selected";
  const sourceSubtitle = selectedRepo
    ? `Branch · ${selectedRepo.defaultBranch || branch || "main"}`
    : "Project will be created without a connected repository";
  const sourceInitials = selectedRepo
    ? String(selectedRepo.fullName || "repo")
        .split("/")
        .pop()
        ?.slice(0, 2)
        .toUpperCase() || "RP"
    : "A3";

  function goToConfigure() {
    setStep(2);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function handleFooterBack() {
    if (step > 1) {
      setStep(step - 1);
      return;
    }
    onCancel?.();
  }

  return (
    <section className="card new-project-view">
      <div className="new-project-head">
        <button
          className="new-project-exit-btn"
          type="button"
          onClick={onCancel}
          aria-label="Back to Overview"
        >
          <ArrowLeftIcon />
          <span>Back to Overview</span>
        </button>
        <div className="new-project-heading">
          <h2>New Project</h2>
          <p className="muted">Import a real repository, configure the build, and deploy to ICP.</p>
        </div>
        <ol className="new-project-stepper" aria-label="Project setup steps">
          <li className={`stepper-item ${step >= 1 ? "active" : ""} ${step > 1 ? "complete" : ""}`}>
            <span className="stepper-dot">{step > 1 ? "✓" : "1"}</span>
            <span className="stepper-label">Source</span>
          </li>
          <span className="stepper-divider" aria-hidden="true" />
          <li className={`stepper-item ${step >= 2 ? "active" : ""}`}>
            <span className="stepper-dot">2</span>
            <span className="stepper-label">Configure & deploy</span>
          </li>
        </ol>
      </div>

      <form
        id="new-project-form"
        className="form new-project-form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          if (step !== 2) {
            goToConfigure();
            return;
          }
          onCreate({
            projectName: projectName.trim(),
            provider,
            repo: selectedRepo?.fullName || "",
            repoId: selectedRepo?.id ?? null,
            installationId: selectedRepo?.installationId ?? null,
            branch,
            region: routingVisibility === "private" ? region : "global",
            routingVisibility,
            settings,
            envVars: envRows
              .map((row) => ({
                key: normalizeEnvVarKey(row.key),
                value: row.value ?? "",
                isSecret: row.isSecret !== false,
              }))
              .filter((row) => row.key.length > 0),
          });
        }}
      >
        {step === 1 ? (
          <>
            <section className="new-project-template-strip">
              <div className="new-project-section-head">
                <div>
                  <h3>Quick Start Templates</h3>
                  <p className="muted">Bootstrap a fresh repository with a vetted starter</p>
                </div>
                <span className="muted">Open on GitHub</span>
              </div>
              <div className="new-project-template-grid">
                {QUICK_START_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="template-quick-card"
                    onClick={() => openQuickTemplate(template)}
                  >
                    <span className={`template-quick-icon ${template.icon}`}>
                      <QuickTemplateIcon kind={template.icon} />
                    </span>
                    <span className="template-quick-title">{template.label}</span>
                    <span className="template-quick-subtitle">{template.subtitle}</span>
                    <span className="template-quick-cta">Use template →</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="new-project-step">
              <div className="new-project-section-head">
                <div>
                  <h3>Import Repository</h3>
                  <p className="muted">Use repositories returned by your linked provider</p>
                </div>
                <button className="btn ghost" type="button" onClick={onEnsureRepos}>
                  Refresh repos
                </button>
              </div>

              <div className="provider-toggle" role="tablist" aria-label="Git provider">
                <button
                  type="button"
                  role="tab"
                  aria-selected={provider === "github"}
                  className={provider === "github" ? "active" : ""}
                  onClick={() => setProvider("github")}
                >
                  <GitHubMark />
                  GitHub
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={provider === "gitlab"}
                  className={provider === "gitlab" ? "active" : ""}
                  onClick={() => setProvider("gitlab")}
                >
                  <GitLabMark />
                  GitLab
                </button>
              </div>

              <label className="repo-search-field">
                Search repositories
                <input
                  value={repoFilter}
                  onChange={(event) => setRepoFilter(event.target.value)}
                  placeholder={`Search ${provider === "gitlab" ? "GitLab" : "GitHub"} repos`}
                  disabled={!providerLinked}
                />
              </label>

              {!providerLinked ? (
                <div className="empty compact">
                  {provider === "gitlab"
                    ? "Connect GitLab in Integrations before importing repositories."
                    : "Connect the GitHub App in Integrations before importing repositories."}
                </div>
              ) : null}

              {providerLinked && providerRepos.length === 0 ? (
                <div className="empty compact">
                  {provider === "gitlab"
                    ? "No repositories available from linked GitLab account."
                    : "No repositories available from linked GitHub App installations."}
                </div>
              ) : null}

              {providerLinked && providerRepos.length > 0 ? (
                <div className="repo-picker">
                  <button
                    type="button"
                    className={`repo-card ${repoKey === "" ? "active" : ""}`}
                    onClick={() => setRepoKey("")}
                  >
                    <span className="repo-card-icon">A3</span>
                    <span>
                      <strong>No repository</strong>
                      <em>Create project only</em>
                    </span>
                  </button>
                  {filteredProviderRepos.map((item) => (
                    <button
                      key={repoSelectionKey(item)}
                      type="button"
                      className={`repo-card ${repoSelectionKey(item) === repoKey ? "active" : ""}`}
                      onClick={() => selectRepo(item)}
                    >
                      <span className="repo-card-icon">
                        {String(item.fullName || "repo")
                          .split("/")
                          .pop()
                          ?.slice(0, 2)
                          .toUpperCase() || "RP"}
                      </span>
                      <span>
                        <strong>{item.fullName}</strong>
                        <em>{item.defaultBranch || "default branch"}</em>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <section className="new-project-source-summary">
              <span className="repo-card-icon">{sourceInitials}</span>
              <span className="new-project-source-summary-main">
                <span className="new-project-source-summary-label">Source</span>
                <strong>{sourceLabel}</strong>
                <em>{sourceSubtitle}</em>
              </span>
              <button
                type="button"
                className="new-project-source-summary-edit"
                onClick={() => setStep(1)}
              >
                Change source
              </button>
            </section>

            <section className="new-project-step">
              <div className="new-project-section-head">
                <div>
                  <h3>Project Configuration</h3>
                  <p className="muted">Name your project and pick the branch &amp; framework</p>
                </div>
              </div>
              <div className="inline-fields new-project-inline-fields">
                <label>
                  Project slug
                  <input
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    required
                    placeholder="my-project"
                  />
                </label>
                <label>
                  Branch
                  <input
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="main"
                  />
                </label>
                <label>
                  Framework
                  <select
                    value={settings.framework}
                    onChange={(event) =>
                      setSettings((prev) => ({ ...prev, framework: event.target.value }))
                    }
                  >
                    {FRAMEWORK_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="new-project-step region-step">
              <div className="new-project-section-head">
                <div>
                  <h3>Deployment Region</h3>
                  <p className="muted">
                    {isPro
                      ? "Use the public pool or route this project to an A3 Pro private canister."
                      : "Free projects deploy through the public global pool."}
                  </p>
                </div>
                {isPro ? <span className="tier-inline-badge">A3 Pro</span> : null}
              </div>
              <div className="region-choice-grid">
                <button
                  type="button"
                  className={`region-choice-card ${routingVisibility === "public" ? "active" : ""}`}
                  onClick={() => {
                    setRoutingVisibility("public");
                    setRegion("global");
                  }}
                >
                  <strong>Global public</strong>
                  <span>Default hosted ICP routing</span>
                </button>
                <button
                  type="button"
                  className={`region-choice-card ${routingVisibility === "private" ? "active" : ""}`}
                  disabled={!isPro || privateRegions.length === 0}
                  onClick={() => {
                    setRoutingVisibility("private");
                    setRegion(privateRegions[0]?.id || "global");
                  }}
                >
                  <strong>Private region</strong>
                  <span>
                    {!isPro
                      ? "Requires A3 Pro"
                      : privateRegions.length
                        ? "Priority routing to private host canisters"
                        : "No private capacity configured"}
                  </span>
                </button>
              </div>
              {routingVisibility === "private" ? (
                <label className="region-select-field">
                  Region
                  <select value={region} onChange={(event) => setRegion(event.target.value)}>
                    {privateRegions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id} · {item.canisters} canister{item.canisters === 1 ? "" : "s"}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </section>

            <section className="new-project-step new-project-advanced">
              <button
                className="new-project-advanced-toggle"
                type="button"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                <span className="new-project-advanced-toggle-main">
                  <GearIcon />
                  <span>
                    <strong>Build settings &amp; environment</strong>
                    <em>Optional · install command, build command, output dir, env vars</em>
                  </span>
                </span>
                <span
                  className={`new-project-advanced-chevron ${advancedOpen ? "open" : ""}`}
                  aria-hidden="true"
                >
                  ▾
                </span>
              </button>

              {advancedOpen ? (
                <div className="new-project-advanced-body">
                  <BuildSettings value={settings} onChange={setSettings} />
                  <EnvVarDraftEditor rows={envRows} setRows={setEnvRows} />
                  <div className="actions">
                    <button type="button" className="btn ghost" onClick={() => setImportOpen(true)}>
                      Import .env
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </form>

      <div className="new-project-footer">
        <button
          type="button"
          className="btn ghost new-project-footer-back"
          onClick={handleFooterBack}
        >
          {step === 1 ? "Cancel" : "Back"}
        </button>
        <div className="new-project-footer-right">
          <span className="muted new-project-footer-hint">
            {step === 1
              ? "Pick a source — you can change it on the next step"
              : "Defaults work for most projects · expand build settings if you need to tweak"}
          </span>
          {step === 1 ? (
            <button
              type="button"
              className="btn icp-rim new-project-primary"
              onClick={goToConfigure}
              disabled={!sourceCanContinue}
            >
              Continue
            </button>
          ) : (
            <button
              type="submit"
              form="new-project-form"
              className="btn icp-rim new-project-primary"
              disabled={creating}
            >
              {creating ? "Deploying…" : selectedRepo ? "Deploy project" : "Create project"}
            </button>
          )}
        </div>
      </div>

      <DotenvImportDialog
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          setImportPreview(null);
        }}
        parsing={false}
        preview={importPreview}
        onParse={(content) => setImportPreview(parseDotenvLocally(content))}
        onCommit={commitLocalEnvImport}
      />
    </section>
  );
}

function DeploymentLogBox({ deployment }) {
  const logBoxRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const seenLineKeysRef = useRef(new Set());
  const initializedRef = useRef(false);
  const logs = Array.isArray(deployment.logs) ? deployment.logs : [];
  const stages = normalizeDeploymentStages(deployment.stages);
  const deploymentRunning =
    isRunningStatus(deployment.status) ||
    DEPLOYMENT_STAGES.some((stageName) => isRunningStatus(stages[stageName]?.status));

  const { entries, newLineKeys } = useMemo(() => {
    const previousSeen = seenLineKeysRef.current;
    const nextSeen = new Set();
    const freshLineKeys = new Set();
    const parsedEntries = [];

    logs.forEach((line, index) => {
      const rawLineKey = `${index}:${line}`;
      nextSeen.add(rawLineKey);
      if (initializedRef.current && !previousSeen.has(rawLineKey)) {
        freshLineKeys.add(rawLineKey);
      }

      const stageMarker = parseStageMarkerLine(line);
      if (stageMarker) {
        if (stageMarker.action === "START") {
          if (stageMarker.stage === "deploy") {
            parsedEntries.push({
              type: "divider",
              key: `${rawLineKey}:deploy-divider`,
              text: "── Deploy phase ──",
            });
          }
          parsedEntries.push({
            type: "start",
            key: `${rawLineKey}:stage-start`,
            stage: stageMarker.stage,
            text: stageMarker.stage === "build" ? "> Build started" : "> Deploy started",
          });
          return;
        }
        const markerClass =
          stageMarker.result === "success"
            ? "ok"
            : stageMarker.result === "failed"
              ? "error"
              : "running";
        parsedEntries.push({
          type: "marker",
          key: `${rawLineKey}:stage-end`,
          markerClass,
          label: `${DEPLOYMENT_STAGE_LABELS[stageMarker.stage]} ${stageMarker.action}`,
          result: stageMarker.result || null,
        });
        return;
      }

      parsedEntries.push({
        type: "log",
        key: `${rawLineKey}:log`,
        lineKey: rawLineKey,
        text: line,
      });
    });

    seenLineKeysRef.current = nextSeen;
    if (!initializedRef.current) {
      initializedRef.current = true;
      return { entries: parsedEntries, newLineKeys: new Set() };
    }
    return { entries: parsedEntries, newLineKeys: freshLineKeys };
  }, [logs]);

  const lastLogEntryIndex = useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].type === "log") {
        return index;
      }
    }
    return -1;
  }, [entries]);

  useEffect(() => {
    const box = logBoxRef.current;
    if (!box || !stickToBottomRef.current) {
      return;
    }
    box.scrollTop = box.scrollHeight;
  }, [entries.length]);

  const onScroll = useCallback((event) => {
    const box = event.currentTarget;
    const remaining = box.scrollHeight - box.scrollTop - box.clientHeight;
    stickToBottomRef.current = remaining <= 24;
  }, []);

  if (!logs.length) {
    return (
      <div className="log-box stage-log-box">
        <span className="muted">No logs yet.</span>
      </div>
    );
  }

  return (
    <div className="log-box stage-log-box" ref={logBoxRef} onScroll={onScroll}>
      {entries.map((entry, index) => {
        if (entry.type === "start") {
          const stageIsRunning = isRunningStatus(stages[entry.stage]?.status);
          return (
            <div key={entry.key} className="stage-start-line">
              <span>{entry.text}</span>
              {stageIsRunning ? (
                <span className="stage-start-loader" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
            </div>
          );
        }
        if (entry.type === "divider") {
          return (
            <div key={entry.key} className="stage-phase-divider">
              {entry.text}
            </div>
          );
        }
        if (entry.type === "marker") {
          return (
            <div key={entry.key} className={`stage-marker ${entry.markerClass}`}>
              <span className="stage-marker-label">{entry.label}</span>
              {entry.result ? <span>{entry.result}</span> : null}
            </div>
          );
        }
        const isNewLine = newLineKeys.has(entry.lineKey);
        const showCursor = deploymentRunning && index === lastLogEntryIndex;
        return (
          <div key={entry.key} className={`log-line${isNewLine ? " new" : ""}`}>
            {entry.text}
            {showCursor ? <span className="log-cursor">|</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function OverviewProjectRow({
  project,
  deployments,
  active,
  onSelect,
  onOpenSettings,
  onCopy,
  onRedeploy,
  busy,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef(null);
  const status = projectRuntimeStatus(project, deployments);
  const hostedUrl = projectHostedUrl(project);
  const host = projectHostedHost(project);
  const latest = getLatestDeployment(project, deployments);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointer = (event) => {
      if (!menuWrapRef.current) return;
      if (!menuWrapRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const handleKey = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);

  const timestamp = latest?.createdAt || project.updatedAt;
  const formattedDate = timestamp
    ? new Date(timestamp).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "-";

  return (
    <article className={`overview-project-row ${active ? "active" : ""}`}>
      <button
        type="button"
        className="overview-project-select"
        onClick={() => onSelect(project.id)}
      >
        <span className="project-avatar-mark">{projectInitials(project)}</span>
        <span className="overview-project-main">
          <span className="overview-project-title-line">
            <strong>{projectTitle(project)}</strong>
            <span className="overview-project-branch-pill">{projectBranch(project)}</span>
          </span>
          {hostedUrl ? (
            <span className="overview-project-link">{host}</span>
          ) : (
            <em>{project.repoUrl || "No hosted URL yet"}</em>
          )}
          <span className={`overview-project-status project-health ${status.className}`}>
            <i />
            {status.label}
          </span>
        </span>
        <span className="overview-project-time">{formattedDate}</span>
      </button>
      <div className="row-kebab-wrap" ref={menuWrapRef}>
        <button
          type="button"
          className="row-kebab-btn"
          aria-label={`Actions for ${projectTitle(project)}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <KebabIcon size={16} />
        </button>
        {menuOpen ? (
          <div className="row-action-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                onOpenSettings?.(project.id);
              }}
            >
              <MenuItemIcon kind="settings" />
              <span>Settings</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                onRedeploy?.(project.id);
              }}
              disabled={!project.repoUrl || busy}
            >
              <MenuItemIcon kind="redeploy" />
              <span>{busy ? "Deploying..." : "Redeploy"}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                onCopy?.(project.webhookUrl);
              }}
              disabled={!project.webhookUrl}
            >
              <MenuItemIcon kind="copy" />
              <span>Copy webhook</span>
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function SelectedProjectPanel({ project, deployments }) {
  if (!project) {
    return (
      <section className="card selected-project-panel">
        <ProjectsEmptyState
          icon={<TerminalLockIcon />}
          title="No project selected"
          subtitle="Create or select a project to see deployment details."
        />
      </section>
    );
  }

  const related = getProjectDeployments(project, deployments);
  const latest = related[0] || null;
  const stages = normalizeDeploymentStages(latest?.stages);
  const hostedUrl = projectHostedUrl(project);
  const status = projectRuntimeStatus(project, deployments);
  const repoUrl = String(project?.repoUrl || "").trim();
  const githubRepoUrl = repoUrl && repoUrl.includes("github.com") ? repoUrl : "";

  return (
    <section className="card selected-project-panel">
      <div className="selected-project-head">
        <div>
          <div className="selected-project-title-row">
            <h2>{projectTitle(project)}</h2>
          </div>
          {hostedUrl ? (
            <a className="project-link" href={hostedUrl} target="_blank" rel="noopener noreferrer">
              {projectHostedHost(project)}
              <ExternalLinkIcon size={14} />
            </a>
          ) : (
            <p className="muted">No hosted URL yet</p>
          )}
        </div>
        <div className="selected-project-head-actions">
          {githubRepoUrl ? (
            <a
              className="detail-action-link"
              href={githubRepoUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <GitHubMark />
              View on GitHub
            </a>
          ) : null}
          <span className={`project-health large ${status.className}`}>
            <i />
            {status.label}
          </span>
        </div>
      </div>

      <div className="activity-summary deployment-summary-grid">
        <article className="mini-stat overview-metric-card">
          <span className="metric-icon activity">
            <MetricIcon kind="activity" />
          </span>
          <p>Deployments</p>
          <strong>{related.length}</strong>
        </article>
        <article className="mini-stat overview-metric-card">
          <span className="metric-icon time">
            <MetricIcon kind="time" />
          </span>
          <p>Last Update</p>
          <strong>{formatDate(latest?.createdAt || project.updatedAt)}</strong>
        </article>
        <article className="mini-stat overview-metric-card">
          <span className="metric-icon layers">
            <MetricIcon kind="layers" />
          </span>
          <p>Environment</p>
          <strong>{hostedUrl ? "Production" : "Not deployed"}</strong>
        </article>
        <article className="mini-stat overview-metric-card">
          <span className="metric-icon github">
            <MetricIcon kind="github" />
          </span>
          <p>Provider</p>
          <strong>{projectProviderLabel(project)}</strong>
        </article>
      </div>

      {latest ? (
        <article className="latest-deployment-card">
          <div className="activity-head">
            <span className={`pill ${statusClass(latest.status)}`}>
              {formatDeploymentStatus(latest.status)}
            </span>
            {latest.priority === "pro" ? (
              <span className="priority-pill">Priority queue</span>
            ) : null}
            <span className="muted">{formatDate(latest.createdAt)}</span>
          </div>
          {isQueuedStatus(latest.status) ? (
            <p className="queue-hint">{formatQueueHint(latest.queue)}</p>
          ) : null}
          <div className="stage-badges">
            {DEPLOYMENT_STAGES.map((stageName) => {
              const stage = stages[stageName];
              const toneClass = stageStatusClass(stage.status);
              const stageDurationMs =
                Number.isFinite(stage.startedAt) && Number.isFinite(stage.finishedAt)
                  ? Math.max(0, stage.finishedAt - stage.startedAt)
                  : null;
              return (
                <span
                  key={`${latest.id}-${stageName}`}
                  className={`stage-badge detailed ${toneClass}`}
                >
                  <span className="stage-badge-head">
                    <span className={`stage-badge-dot ${toneClass}`} />
                    <span className="stage-badge-name">{DEPLOYMENT_STAGE_LABELS[stageName]}</span>
                  </span>
                  <span className="stage-badge-status">{formatStageStatus(stage.status)}</span>
                  {stageDurationMs != null ? (
                    <span className="stage-badge-duration">
                      {formatDurationMs(stageDurationMs)}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
          <div className="deployment-meta">
            <p className="project-meta">
              <span className="meta-label">Branch:</span>{" "}
              <span className="meta-value">{latest.branch || projectBranch(project)}</span>
            </p>
            <p className="project-meta">
              <span className="meta-label">Source:</span>{" "}
              <span className="meta-value">{latest.source || "-"}</span>
            </p>
          </div>
          <DeploymentLogBox deployment={latest} />
        </article>
      ) : (
        <div className="empty compact">No deployments for this project yet.</div>
      )}
    </section>
  );
}

function OverviewTab({
  projects,
  deployments,
  repos,
  githubLinked,
  gitlabLinked,
  onEnsureRepos,
  forceCreateFlow,
  onCreateFlowConsumed,
  onCreateProject,
  deploymentRegions,
  onReloadDeploymentRegions,
  onRedeploy,
  onOpenProjectSettings,
  busyProjectId,
  onToast,
  selectedProjectId,
  setSelectedProjectId,
  globalSearch,
  onViewDeployments,
  session,
}) {
  const [creating, setCreating] = useState(false);

  const filteredProjects = useMemo(() => {
    const terms = String(globalSearch || "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!terms.length) return projects;
    return projects.filter((project) => {
      const haystack = [
        projectTitle(project),
        projectHostedHost(project),
        project.repoUrl,
        project.branch,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [projects, globalSearch]);
  const hasProjects = projects.length > 0;
  const noProjects = !hasProjects;
  const noSearchResults = hasProjects && filteredProjects.length === 0;

  const selectedProject = useMemo(() => {
    return filteredProjects.find((p) => p.id === selectedProjectId) || filteredProjects[0] || null;
  }, [filteredProjects, selectedProjectId]);

  async function onCreate(payload) {
    try {
      await onCreateProject(payload);
      setCreating(false);
    } catch (error) {
      onToast(error.message || "Failed to create project.", "error");
    }
  }

  async function onCopy(webhookUrl) {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      onToast("Copied", "success");
    } catch {
      onToast("Couldn't copy", "error");
    }
  }

  useEffect(() => {
    if (!forceCreateFlow) {
      return;
    }
    setCreating(true);
    onCreateFlowConsumed?.();
  }, [forceCreateFlow, onCreateFlowConsumed]);

  if (creating) {
    return (
      <NewProjectView
        repos={repos}
        githubLinked={githubLinked}
        gitlabLinked={gitlabLinked}
        onEnsureRepos={onEnsureRepos}
        onCancel={() => setCreating(false)}
        onCreate={onCreate}
        creating={busyProjectId === "__creating__"}
        onToast={onToast}
        session={session}
        deploymentRegions={deploymentRegions}
        onReloadDeploymentRegions={onReloadDeploymentRegions}
      />
    );
  }

  return (
    <>
      <div className="overview-main pro">
        <section className="card projects-pane">
          <div className="card-head">
            <h2>Projects</h2>
            <span className="muted">{filteredProjects.length} shown</span>
          </div>
          <div className="overview-project-list">
            {noProjects ? (
              <ProjectsEmptyState
                icon={<TerminalLockIcon />}
                title="No projects yet"
                subtitle="Connect a repo to ship your first deployment."
              />
            ) : null}
            {noSearchResults ? (
              <ProjectsEmptyState
                icon={<SearchOffIcon />}
                title="No results"
                subtitle="No projects match your search."
              />
            ) : null}
            {filteredProjects.map((project) => (
              <OverviewProjectRow
                key={project.id}
                project={project}
                deployments={deployments}
                active={selectedProject?.id === project.id}
                onSelect={setSelectedProjectId}
                onOpenSettings={onOpenProjectSettings}
                onCopy={onCopy}
                onRedeploy={onRedeploy}
                busy={busyProjectId === project.id}
              />
            ))}
          </div>
        </section>

        <SelectedProjectPanel
          project={selectedProject}
          deployments={deployments}
          onRedeploy={onRedeploy}
          onOpenSettings={onOpenProjectSettings}
          onViewDeployments={onViewDeployments}
          busy={busyProjectId === selectedProject?.id}
        />
      </div>

      <div className="graph-grid">
        <Suspense fallback={<GraphCardsFallback />}>
          <AnalyticsBundle kind="overview" deployments={deployments} project={selectedProject} />
        </Suspense>
      </div>
    </>
  );
}

function ProjectsTab({
  projects,
  onToast,
  selectedProjectId,
  setSelectedProjectId,
  onProjectDeleted,
  onProjectUpdated,
  onRedeploy,
}) {
  const [envRows, setEnvRows] = useState([]);
  const [loadingEnv, setLoadingEnv] = useState(false);
  const [envLoadError, setEnvLoadError] = useState("");
  const [draft, setDraft] = useState(createEmptyEnvVarRow());
  const [importOpen, setImportOpen] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteStep, setDeleteStep] = useState(1);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteAcknowledge, setDeleteAcknowledge] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [settingsDraft, setSettingsDraft] = useState(() => ({ ...DEFAULT_BUILD }));
  const [settingsSaveBusy, setSettingsSaveBusy] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState("");
  const [settingsRedeployAfterSave, setSettingsRedeployAfterSave] = useState(false);
  const pendingEnvDeleteRef = useRef(new Map());
  const selectedProject = projects.find((p) => p.id === selectedProjectId) || projects[0] || null;
  const selectedProjectSettings = useMemo(
    () => normalizeBuildSettings(selectedProject?.settings),
    [selectedProject?.settings],
  );
  const settingsDirty = !buildSettingsEqual(settingsDraft, selectedProjectSettings);
  const deleteConfirmToken = selectedProject?.tenant?.slug || selectedProject?.id || "";
  const webhookAuthLabel = selectedProject
    ? projectWebhookAuthLabel(selectedProject)
    : "GitHub signature (`x-hub-signature-256`)";

  function resetDeleteFlow() {
    setDeleteStep(1);
    setDeleteInput("");
    setDeleteAcknowledge(false);
    setDeleteBusy(false);
    setDeleteError("");
  }

  useEffect(() => {
    resetDeleteFlow();
    setDeleteOpen(false);
  }, [selectedProject?.id]);

  useEffect(() => {
    if (!selectedProject) {
      setSettingsDraft({ ...DEFAULT_BUILD });
      setSettingsSaveBusy(false);
      setSettingsSaveError("");
      setSettingsRedeployAfterSave(false);
      return;
    }
    setSettingsDraft(selectedProjectSettings);
    setSettingsSaveBusy(false);
    setSettingsSaveError("");
    setSettingsRedeployAfterSave(false);
  }, [selectedProject?.id, selectedProjectSettings]);

  useEffect(() => {
    return () => {
      for (const pending of pendingEnvDeleteRef.current.values()) {
        clearTimeout(pending.timeoutId);
      }
      pendingEnvDeleteRef.current.clear();
    };
  }, []);

  async function copyProjectSetting(value, label) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      onToast(label, "success");
    } catch {
      onToast("Couldn't copy value.", "error");
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function loadEnvVars() {
      if (!selectedProject?.id) {
        setEnvRows([]);
        setEnvLoadError("");
        return;
      }
      setLoadingEnv(true);
      setEnvLoadError("");
      try {
        const res = await apiFetch(`/projects/${selectedProject.id}/env-vars`);
        if (res.status === 404) {
          if (!cancelled) {
            setEnvRows([]);
            setEnvLoadError("");
          }
          return;
        }
        if (!res.ok) {
          throw new Error(await parseError(res, "Failed to load env vars."));
        }
        const data = await res.json();
        if (!cancelled) {
          setEnvRows(Array.isArray(data) ? data : []);
          setEnvLoadError("");
        }
      } catch (error) {
        if (!cancelled) {
          setEnvRows([]);
          setEnvLoadError(
            error.message || "Failed to load env vars. Check KMS env vars and IAM on backend.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingEnv(false);
        }
      }
    }
    loadEnvVars();
    return () => {
      cancelled = true;
    };
  }, [selectedProject?.id]);

  async function addEnvVar() {
    if (!selectedProject?.id) return;
    try {
      const payload = {
        key: normalizeEnvVarKey(draft.key),
        value: draft.value || "",
        isSecret: true,
      };
      const res = await apiFetch(`/projects/${selectedProject.id}/env-vars`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await parseError(res, "Failed to add env var."));
      }
      const row = await res.json();
      setEnvRows((prev) => {
        const without = prev.filter((item) => item.key !== row.key);
        return [...without, row].sort((a, b) => String(a.key).localeCompare(String(b.key)));
      });
      setDraft(createEmptyEnvVarRow());
      onToast("Environment variable saved.", "success");
    } catch (error) {
      onToast(error.message || "Failed to add env var.", "error");
    }
  }

  async function rotateEnvVar(row, nextValue) {
    if (!selectedProject?.id) return;
    try {
      const res = await apiFetch(`/projects/${selectedProject.id}/env-vars/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: nextValue, isSecret: true }),
      });
      if (!res.ok) {
        throw new Error(await parseError(res, "Failed to update env var."));
      }
      const updated = await res.json();
      setEnvRows((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      onToast(`Updated ${row.key}.`, "success");
    } catch (error) {
      onToast(error.message || "Failed to update env var.", "error");
    }
  }

  async function deleteEnvVar(row) {
    if (!selectedProject?.id) return;
    if (pendingEnvDeleteRef.current.has(row.id)) return;
    const snapshot = [...envRows];
    const index = snapshot.findIndex((item) => item.id === row.id);
    setEnvRows((prev) => prev.filter((item) => item.id !== row.id));

    const restore = () => {
      setEnvRows((prev) => {
        if (prev.some((item) => item.id === row.id)) {
          return prev;
        }
        const next = [...prev];
        const insertAt = index >= 0 && index <= next.length ? index : next.length;
        next.splice(insertAt, 0, row);
        return next;
      });
    };

    const finalizeDelete = async () => {
      try {
        const res = await apiFetch(`/projects/${selectedProject.id}/env-vars/${row.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          throw new Error(await parseError(res, "Couldn't delete variable."));
        }
      } catch (error) {
        restore();
        onToast(error.message || "Couldn't delete variable.", "error");
      }
    };

    const timeoutId = setTimeout(() => {
      pendingEnvDeleteRef.current.delete(row.id);
      finalizeDelete().catch(() => {});
    }, 3200);
    pendingEnvDeleteRef.current.set(row.id, { timeoutId });

    onToast("Deleted", "success", {
      actionLabel: "Undo",
      durationMs: 3200,
      onAction: () => {
        const pending = pendingEnvDeleteRef.current.get(row.id);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingEnvDeleteRef.current.delete(row.id);
        }
        restore();
      },
    });
  }

  async function parseImport(content) {
    if (!selectedProject?.id) return;
    try {
      const res = await apiFetch(`/projects/${selectedProject.id}/env-vars/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        throw new Error(await parseError(res, "Failed to parse .env."));
      }
      const preview = await res.json();
      setImportPreview(preview);
    } catch (error) {
      onToast(error.message || "Failed to parse .env.", "error");
    }
  }

  async function commitImport(preview, conflictPolicy) {
    if (!selectedProject?.id) return;
    try {
      const entries = (preview?.validEntries || []).map((entry) => ({
        key: entry.key,
        value: entry.value || "",
        isSecret: entry.isSecret !== false,
      }));
      const includeValuesRes = await apiFetch(
        `/projects/${selectedProject.id}/env-vars/import/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conflictPolicy,
            entries,
          }),
        },
      );
      if (!includeValuesRes.ok) {
        throw new Error(await parseError(includeValuesRes, "Failed to import .env."));
      }
      const result = await includeValuesRes.json();
      onToast(`Imported env vars. Saved ${result.saved}, skipped ${result.skipped}.`, "success");
      setImportOpen(false);
      setImportPreview(null);
      const refresh = await apiFetch(`/projects/${selectedProject.id}/env-vars`);
      if (refresh.ok) {
        const data = await refresh.json();
        setEnvRows(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      onToast(error.message || "Failed to import .env.", "error");
    }
  }

  async function deleteSelectedProject() {
    if (!selectedProject?.id) {
      return;
    }
    if (deleteBusy) {
      return;
    }
    const projectToDelete = selectedProject;
    const deletedId = projectToDelete.id;
    const confirmToken = deleteConfirmToken;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const res = await apiFetch(`/projects/${deletedId}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: confirmToken }),
      });
      if (!res.ok) {
        throw new Error(await parseError(res, "Couldn't delete project."));
      }
      setDeleteOpen(false);
      resetDeleteFlow();
      await onProjectDeleted?.(deletedId);
      onToast("Deleted", "success");
    } catch (error) {
      setDeleteError(error.message || "Couldn't delete project.");
      onToast(error.message || "Couldn't delete project.", "error");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function saveProjectSettings() {
    if (!selectedProject?.id || settingsSaveBusy) {
      return;
    }
    setSettingsSaveBusy(true);
    setSettingsSaveError("");
    try {
      const payload = {
        framework: settingsDraft.framework,
        rootDir: settingsDraft.rootDir,
        buildCommand: settingsDraft.buildCommand,
        outputDir: settingsDraft.outputDir,
      };
      const res = await apiFetch(`/projects/${selectedProject.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await parseError(res, "Couldn't save project settings."));
      }
      await onProjectUpdated?.();
      onToast("Project settings saved.", "success");
      if (settingsRedeployAfterSave) {
        if (!selectedProject.repoUrl) {
          onToast("Settings saved. Connect a repo before redeploy.", "error");
        } else {
          await onRedeploy?.(selectedProject.id);
        }
      }
    } catch (error) {
      setSettingsSaveError(error.message || "Couldn't save project settings.");
      onToast(error.message || "Couldn't save project settings.", "error");
    } finally {
      setSettingsSaveBusy(false);
    }
  }

  return (
    <section className="card projects-full">
      <div className="card-head">
        <h2>Projects</h2>
      </div>
      <div className="project-selector-row">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className={`project-selector-chip ${selectedProject?.id === project.id ? "active" : ""}`}
            onClick={() => setSelectedProjectId(project.id)}
          >
            <strong>{projectTitle(project)}</strong>
            <span>{projectHostedHost(project)}</span>
          </button>
        ))}
      </div>
      <div className="projects-settings-layout">
        <div className="env-settings card nested">
          <div className="card-head">
            <h3>Project Settings</h3>
            <span className="muted">{selectedProject?.tenant?.slug || "Select a project"}</span>
          </div>
          {selectedProject ? (
            <div className="project-integrations-meta">
              <p className="project-meta">
                <span className="meta-label">Webhook:</span>{" "}
                <span className="meta-value">{maskWebhook(selectedProject.webhookUrl)}</span>
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  onClick={() => copyProjectSetting(selectedProject.webhookUrl, "Webhook copied")}
                >
                  Copy
                </button>
              </p>
              <p className="project-meta">
                <span className="meta-label">Auth:</span>{" "}
                <span className="meta-value">{webhookAuthLabel}</span>
              </p>
              {projectGitProvider(selectedProject) === "gitlab" &&
              selectedProject.gitlab?.webhookSecret ? (
                <p className="project-meta">
                  <span className="meta-label">Token:</span>{" "}
                  <span className="meta-value">
                    {maskWebhook(selectedProject.gitlab.webhookSecret)}
                  </span>
                  <button
                    type="button"
                    className="btn ghost btn-sm"
                    onClick={() =>
                      copyProjectSetting(selectedProject.gitlab.webhookSecret, "Token copied")
                    }
                  >
                    Copy
                  </button>
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="build-settings-editor">
            <div className="card-head compact">
              <h4>Build Configuration</h4>
            </div>
            {selectedProject ? (
              <>
                <BuildSettings value={settingsDraft} onChange={setSettingsDraft} />
                <label className="delete-ack">
                  <input
                    type="checkbox"
                    checked={settingsRedeployAfterSave}
                    onChange={(event) => setSettingsRedeployAfterSave(event.target.checked)}
                    disabled={settingsSaveBusy}
                  />
                  <span>Trigger redeploy after saving</span>
                </label>
                {settingsSaveError ? <p className="admin-error">{settingsSaveError}</p> : null}
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={saveProjectSettings}
                    disabled={!settingsDirty || settingsSaveBusy}
                  >
                    {settingsSaveBusy ? "Saving..." : "Save configuration"}
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">Select a project to edit build configuration.</p>
            )}
          </div>
          <p className="muted env-inline-note">
            Values are write-only and stored encrypted. To change one, enter a new value and save.
          </p>
          <div className="actions">
            <button
              className="btn ghost danger"
              type="button"
              onClick={() => {
                resetDeleteFlow();
                setDeleteOpen(true);
              }}
              disabled={!selectedProject}
            >
              Delete project
            </button>
          </div>
          {loadingEnv ? <p className="muted">Loading env vars...</p> : null}
          {!loadingEnv && selectedProject ? (
            <>
              <div className="env-row add">
                <input
                  value={draft.key}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, key: normalizeEnvVarKey(e.target.value) }))
                  }
                  placeholder="Variable key"
                  {...ENV_INPUT_HINTS}
                />
                <input
                  value={draft.value}
                  onChange={(e) => setDraft((prev) => ({ ...prev, value: e.target.value }))}
                  placeholder="Variable value"
                  type="text"
                  name="env_value_draft"
                  {...ENV_INPUT_HINTS}
                />
                <span className="env-protect-pill">Encrypted</span>
                <button className="btn" type="button" onClick={addEnvVar}>
                  Save variable
                </button>
              </div>
              <EnvKeySuggestions onPick={(key) => setDraft((prev) => ({ ...prev, key }))} />
              <div className="actions">
                <button className="btn ghost" type="button" onClick={() => setImportOpen(true)}>
                  Import .env
                </button>
              </div>
              {envLoadError ? (
                <p className="muted env-inline-note">Could not load saved variables right now.</p>
              ) : null}
              <div className="env-existing-list">
                {envRows.length === 0 ? <p className="muted">No env vars configured.</p> : null}
                {envRows.map((row) => (
                  <EnvExistingRow
                    key={row.id}
                    row={row}
                    onRotate={rotateEnvVar}
                    onDelete={deleteEnvVar}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <DotenvImportDialog
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          setImportPreview(null);
        }}
        parsing={false}
        preview={importPreview}
        onParse={parseImport}
        onCommit={commitImport}
      />
      <DeleteProjectDialog
        open={deleteOpen}
        project={selectedProject}
        confirmToken={deleteConfirmToken}
        input={deleteInput}
        setInput={setDeleteInput}
        acknowledge={deleteAcknowledge}
        setAcknowledge={setDeleteAcknowledge}
        step={deleteStep}
        setStep={setDeleteStep}
        deleting={deleteBusy}
        error={deleteError}
        onClose={() => {
          setDeleteOpen(false);
          resetDeleteFlow();
        }}
        onDelete={deleteSelectedProject}
      />
    </section>
  );
}

function EnvExistingRow({ row, onRotate, onDelete }) {
  const [nextValue, setNextValue] = useState("");
  return (
    <div className="env-row existing">
      <input value={row.key} disabled />
      <input
        value={nextValue}
        onChange={(e) => setNextValue(e.target.value)}
        placeholder="Update value"
        type="text"
        name={`env_value_rotate_${row.id}`}
        {...ENV_INPUT_HINTS}
      />
      <span className="env-protect-pill">Encrypted</span>
      <button
        type="button"
        className="btn ghost"
        onClick={() => {
          onRotate(row, nextValue);
          setNextValue("");
        }}
        disabled={!nextValue}
      >
        Save new value
      </button>
      <button type="button" className="btn ghost danger" onClick={() => onDelete(row)}>
        Delete
      </button>
    </div>
  );
}

function DeploymentsTab({ deployments }) {
  const sortedDeployments = useMemo(() => sortDeploymentsDesc(deployments), [deployments]);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState("");
  const selectedDeployment =
    sortedDeployments.find((deployment) => deployment.id === selectedDeploymentId) ||
    sortedDeployments[0] ||
    null;

  useEffect(() => {
    if (!sortedDeployments.length) {
      setSelectedDeploymentId("");
      return;
    }
    if (!sortedDeployments.some((deployment) => deployment.id === selectedDeploymentId)) {
      setSelectedDeploymentId(sortedDeployments[0].id);
    }
  }, [sortedDeployments, selectedDeploymentId]);

  return (
    <div className="deployments-page">
      <section className="card">
        <div className="card-head">
          <h2>Deployments</h2>
          <span className="muted">{sortedDeployments.length} runs</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Build</th>
                <th>Deploy</th>
                <th>Repo</th>
                <th>Source</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {sortedDeployments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    No deployments yet.
                  </td>
                </tr>
              ) : null}
              {sortedDeployments.map((d) => {
                const stages = normalizeDeploymentStages(d.stages);
                const repoLabel =
                  d.project?.github?.fullName ||
                  d.project?.gitlab?.pathWithNamespace ||
                  d.project?.repoUrl ||
                  "-";
                return (
                  <tr
                    key={d.id}
                    className={selectedDeployment?.id === d.id ? "selected-row" : ""}
                    onClick={() => setSelectedDeploymentId(d.id)}
                  >
                    <td>
                      <div className="deploy-status-cell">
                        <span className={`pill ${statusClass(d.status)}`}>
                          {formatDeploymentStatus(d.status)}
                        </span>
                        {isQueuedStatus(d.status) ? (
                          <span className="queue-hint compact">{formatQueueHint(d.queue)}</span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <span className={`stage-badge ${stageStatusClass(stages.build.status)}`}>
                        {stages.build.status}
                      </span>
                    </td>
                    <td>
                      <span className={`stage-badge ${stageStatusClass(stages.deploy.status)}`}>
                        {stages.deploy.status}
                      </span>
                    </td>
                    <td>{repoLabel}</td>
                    <td>{d.source || "-"}</td>
                    <td>{formatDate(d.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {selectedDeployment ? (
        <section className="card deployment-inspector">
          <div className="card-head">
            <div>
              <h2>Run Details</h2>
              <p className="muted">
                {selectedDeployment.project?.github?.fullName ||
                  selectedDeployment.project?.gitlab?.pathWithNamespace ||
                  selectedDeployment.project?.repoUrl ||
                  selectedDeployment.id}
              </p>
            </div>
            <span className={`pill ${statusClass(selectedDeployment.status)}`}>
              {formatDeploymentStatus(selectedDeployment.status)}
            </span>
          </div>
          <div className="deployment-meta">
            <p className="project-meta">
              <span className="meta-label">Branch:</span>{" "}
              <span className="meta-value">{selectedDeployment.branch || "-"}</span>
            </p>
            <p className="project-meta">
              <span className="meta-label">Source:</span>{" "}
              <span className="meta-value">{selectedDeployment.source || "-"}</span>
            </p>
            <p className="project-meta">
              <span className="meta-label">Created:</span>{" "}
              <span className="meta-value">{formatDate(selectedDeployment.createdAt)}</span>
            </p>
          </div>
          <DeploymentLogBox deployment={selectedDeployment} />
        </section>
      ) : null}
    </div>
  );
}

function TierFeatureIcon({ kind }) {
  const props = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
  };
  switch (kind) {
    case "folder":
      return (
        <svg {...props}>
          <path d="M3.5 7.6h6.4l1.8 2.2h8.8V18a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" />
          <path d="M3.5 7.6V6.1a2 2 0 0 1 2-2h3.4" />
        </svg>
      );
    case "rocket":
      return (
        <svg {...props}>
          <path d="M14.4 4.4c2.7.2 5 2.5 5.2 5.2l-4.9 4.9-5.2-5.2z" />
          <path d="m9.5 9.3-3.8 3.8 3.7 1.1 1.1 3.7 3.8-3.8" />
          <circle cx="14.7" cy="9.2" r="1.1" />
        </svg>
      );
    case "region":
      return (
        <svg {...props}>
          <path d="M12 20s6-4.8 6-10a6 6 0 1 0-12 0c0 5.2 6 10 6 10z" />
          <circle cx="12" cy="10" r="2.1" />
        </svg>
      );
    case "subnet":
      return (
        <svg {...props}>
          <path d="M7.2 16.8h9.6a3.2 3.2 0 0 0 .3-6.3 4.8 4.8 0 0 0-9.3 1.1 2.6 2.6 0 0 0-.6 5.2z" />
          <path d="M8.8 19.5h6.4" />
          <path d="M10.6 13.1h2.1m2.6 0h.1" />
        </svg>
      );
    case "eject":
      return (
        <svg {...props}>
          <rect x="4.5" y="6.2" width="15" height="12.5" rx="2.2" />
          <path d="m12 14.7 3.2-3.2M12 14.7V9.2m0 5.5-3.2-3.2" />
          <path d="M8.3 18.9h7.4" />
        </svg>
      );
    case "queue":
      return (
        <svg {...props}>
          <rect x="4.5" y="4.6" width="9.2" height="6.1" rx="1.5" />
          <rect x="10.3" y="13.3" width="9.2" height="6.1" rx="1.5" />
          <path d="M13.7 7.6h2.4a2.4 2.4 0 0 1 2.4 2.4v3.3" />
        </svg>
      );
    case "support":
      return (
        <svg {...props}>
          <circle cx="8.4" cy="9.2" r="2.8" />
          <circle cx="16.2" cy="10.1" r="2.3" />
          <path d="M3.8 19c1.1-3.2 2.7-4.8 4.8-4.8s3.6 1.6 4.7 4.8" />
          <path d="M13.5 15.2c.8-.5 1.7-.7 2.7-.5 1.7.3 2.9 1.7 3.7 4.3" />
        </svg>
      );
    case "deploy":
      return (
        <svg {...props}>
          <path d="M12 4.2v11.1" />
          <path d="m8.6 8.2 3.4-3.4 3.4 3.4" />
          <path d="M4.5 18.9h15" />
        </svg>
      );
    case "globe":
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="8.1" />
          <path d="M4.2 12h15.6M12 3.9c2.4 2.2 2.4 14 0 16.2M12 3.9c-2.4 2.2-2.4 14 0 16.2" />
        </svg>
      );
  }
}

function TierFeatureCheck() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="m8 12.4 2.6 2.6 5.4-5.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TierTab({ billing, projects, deployments, onStartCheckout, onManageBilling, onToast }) {
  const [billingCycle, setBillingCycle] = useState("monthly");
  const [busyAction, setBusyAction] = useState("");
  const isPro = Boolean(billing?.isPro);
  const statusLabel = billing?.subscriptionStatus
    ? billing.subscriptionStatus.replace(/_/g, " ")
    : "free";
  const monthlyPrice = 19;
  const yearlyMonthlyPrice = monthlyPrice * 0.8;
  const displayedPrice = billingCycle === "yearly" ? yearlyMonthlyPrice : monthlyPrice;
  const projectLimit = isPro ? 50 : 3;
  const projectCount = Array.isArray(projects) ? projects.length : 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const deploymentsThisWeek = (Array.isArray(deployments) ? deployments : []).filter(
    (deployment) => {
      const createdAt = Number(deployment?.createdAt || 0);
      return Number.isFinite(createdAt) && createdAt >= weekAgo;
    },
  ).length;
  const primaryActionLabel = isPro ? "Manage billing" : "Buy";
  const usageCards = [
    {
      key: "projects",
      icon: "folder",
      label: "Projects",
      value: `${projectCount} / ${projectLimit}`,
      detail:
        projectCount >= projectLimit
          ? "You're at your project limit"
          : `${Math.max(0, projectLimit - projectCount)} project slots remaining`,
    },
    {
      key: "deployments",
      icon: "deploy",
      label: "Deployments this week",
      value: String(deploymentsThisWeek),
      detail: "Resets on a rolling 7 day window",
    },
    {
      key: "bandwidth",
      icon: "globe",
      label: "Bandwidth",
      value: "Unmetered",
      detail: "Traffic capacity depends on the host pool",
    },
    {
      key: "region",
      icon: "region",
      label: "Region",
      value: isPro ? "Private" : "Shared",
      detail: isPro ? "Private routing available" : "Using shared infrastructure",
    },
  ];
  const freeFeatures = [
    {
      key: "projects",
      icon: "folder",
      title: "3 projects",
      description: "Create up to 3 projects per account",
    },
    {
      key: "deploys",
      icon: "rocket",
      title: "Generous deploys",
      description: "Generous deploys for development",
    },
    {
      key: "bandwidth",
      icon: "globe",
      title: "Unmetered static reads",
      description: "No per-GB customer meter in this prototype",
    },
    {
      key: "support",
      icon: "support",
      title: "Community support",
      description: "Standard community help",
    },
  ];
  const proFeatures = [
    {
      key: "pro-projects",
      icon: "folder",
      title: "50 projects",
      description: "Scale beyond the free project limit",
    },
    {
      key: "pro-deploys",
      icon: "deploy",
      title: "Frequent deployments",
      description: "Subject to queue capacity and request limits",
    },
    {
      key: "pro-region",
      icon: "region",
      title: "Choose your region",
      description: "Deploy to configured private host regions",
    },
    {
      key: "pro-subnet",
      icon: "subnet",
      title: "Private canister routing",
      description: "Use private A3 host canisters when capacity is available",
    },
    {
      key: "pro-priority",
      icon: "queue",
      title: "Priority deployment",
      description: "Priority on deployment queues",
    },
  ];

  async function runBillingAction(action, fn) {
    setBusyAction(action);
    try {
      await fn();
    } catch (error) {
      onToast?.(error.message || "Billing action failed.", "error");
    } finally {
      setBusyAction("");
    }
  }

  return (
    <section className="tier-page">
      <div className="tier-grid" role="list" aria-label="Pricing plans">
        <article className="tier-card tier-card-free" role="listitem">
          <div className="tier-card-top">
            <div>
              <h3>Free</h3>
              <p>For testing deployments and small projects.</p>
            </div>
            <span className="tier-badge tier-badge-current">
              {isPro ? "Included" : "Current plan"}
            </span>
          </div>

          <div className="tier-price-wrap">
            <div className="tier-price">
              <strong>$0</strong>
              <span>/ month</span>
            </div>
          </div>

          <ul className="tier-feature-list">
            {freeFeatures.map((feature) => (
              <li key={feature.key}>
                <span className="tier-feature-icon" aria-hidden="true">
                  <TierFeatureIcon kind={feature.icon} />
                </span>
                <div className="tier-feature-copy">
                  <div className="tier-feature-title-row">
                    <strong>{feature.title}</strong>
                  </div>
                  <p>{feature.description}</p>
                </div>
                <span className="tier-feature-check" aria-hidden="true">
                  <TierFeatureCheck />
                </span>
              </li>
            ))}
          </ul>

          <button className="tier-button tier-button-current" type="button" disabled>
            {isPro ? "Included with Pro" : "Current plan"}
          </button>
        </article>

        <article className="tier-card tier-card-pro" role="listitem">
          <div className="tier-card-pro-toolbar">
            <div className="tier-billing-toggle" role="tablist" aria-label="Billing cycle">
              <button
                type="button"
                role="tab"
                aria-selected={billingCycle === "monthly"}
                className={billingCycle === "monthly" ? "active" : ""}
                onClick={() => setBillingCycle("monthly")}
              >
                Monthly
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={billingCycle === "yearly"}
                className={billingCycle === "yearly" ? "active yearly-tab" : "yearly-tab"}
                onClick={() => setBillingCycle("yearly")}
              >
                <span>Yearly</span>
                <span className="tier-save-badge">Save 20%</span>
              </button>
            </div>
            <span className="tier-badge tier-badge-coming">
              {isPro ? `Active · ${statusLabel}` : "Available now"}
            </span>
          </div>

          <div className="tier-price-wrap">
            <h3>A3 Pro</h3>
            <div className="tier-price">
              <strong>
                ${displayedPrice % 1 === 0 ? displayedPrice.toFixed(0) : displayedPrice.toFixed(2)}
              </strong>
              <span>/ month</span>
              {billing?.cancelAtPeriodEnd && billing?.currentPeriodEnd ? (
                <em>ends {new Date(billing.currentPeriodEnd).toLocaleDateString()}</em>
              ) : billingCycle === "yearly" ? (
                <em>billed yearly</em>
              ) : null}
            </div>
            <p>For teams that need more control and performance.</p>
          </div>

          <ul className="tier-feature-list">
            {proFeatures.map((feature) => (
              <li key={feature.key}>
                <span className="tier-feature-icon tier-feature-icon-pro" aria-hidden="true">
                  <TierFeatureIcon kind={feature.icon} />
                </span>
                <div className="tier-feature-copy">
                  <div className="tier-feature-title-row">
                    <strong>{feature.title}</strong>
                    {feature.badge ? (
                      <span className="tier-inline-badge">{feature.badge}</span>
                    ) : null}
                  </div>
                  <p>{feature.description}</p>
                </div>
                <span className="tier-feature-check" aria-hidden="true">
                  <TierFeatureCheck />
                </span>
              </li>
            ))}
          </ul>

          {isPro ? (
            <button
              className="tier-button tier-button-pro"
              type="button"
              disabled={busyAction === "portal"}
              onClick={() => runBillingAction("portal", onManageBilling)}
            >
              {busyAction === "portal" ? "Opening..." : primaryActionLabel}
            </button>
          ) : (
            <button
              className="tier-button tier-button-pro"
              type="button"
              disabled={busyAction === "checkout"}
              onClick={() => runBillingAction("checkout", () => onStartCheckout(billingCycle))}
            >
              {busyAction === "checkout" ? "Opening..." : primaryActionLabel}
            </button>
          )}
        </article>
      </div>

      <section className="tier-usage card">
        <div className="card-head">
          <h2>Current usage</h2>
        </div>
        <div className="tier-usage-grid">
          {usageCards.map((item) => (
            <article key={item.key} className="tier-usage-card">
              <span className="tier-feature-icon" aria-hidden="true">
                <TierFeatureIcon kind={item.icon} />
              </span>
              <div>
                <p>{item.label}</p>
                <strong>{item.value}</strong>
                <span>{item.detail}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

function EjectTab() {
  return (
    <section className="card eject-page">
      <div className="eject-mark" aria-hidden="true">
        <SidebarTabIcon tabId="eject" />
      </div>
      <div className="eject-copy">
        <span className="tier-inline-badge">Coming soon</span>
        <h2>Eject your site from A3 hosting</h2>
        <p>
          A3 Eject will let teams transfer a hosted ICP project into their own custody when they are
          ready to operate infrastructure directly.
        </p>
        <p className="muted">
          We are designing this flow around ownership handoff, auditability, and zero surprise
          downtime.
        </p>
      </div>
    </section>
  );
}

function GithubTab({
  session,
  projects,
  installations,
  repos,
  loadingRepos,
  loadingGitlabRepos,
  onReloadRepos,
  onReloadGitlabRepos,
  onConnectGitHubApp,
  onConnectGitLab,
  onDisconnectInstallation,
  onDisconnectGitLabAccount,
  gitlabAccount,
}) {
  const [filter, setFilter] = useState("");
  const githubRepos = useMemo(
    () => repos.filter((repo) => String(repo.provider || "github").toLowerCase() !== "gitlab"),
    [repos],
  );
  const gitlabRepos = useMemo(
    () => repos.filter((repo) => String(repo.provider || "github").toLowerCase() === "gitlab"),
    [repos],
  );
  const filteredGitHubRepos = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return githubRepos;
    return githubRepos.filter((repo) =>
      String(repo.fullName || "")
        .toLowerCase()
        .includes(q),
    );
  }, [githubRepos, filter]);
  const filteredGitLabRepos = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return gitlabRepos;
    return gitlabRepos.filter((repo) =>
      String(repo.fullName || "")
        .toLowerCase()
        .includes(q),
    );
  }, [gitlabRepos, filter]);
  const installationById = useMemo(() => {
    const map = new Map();
    for (const installation of installations || []) {
      map.set(Number(installation.installationId), installation);
    }
    return map;
  }, [installations]);
  const appEnabled = Boolean(session?.githubAppEnabled);
  const gitlabEnabled = session?.gitlabAuthEnabled !== false;
  const gitlabConnected = Boolean(gitlabAccount?.connected);
  const reconnectCount = useMemo(
    () =>
      projects.filter((project) => project?.github?.fullName && !project?.github?.installationId)
        .length,
    [projects],
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2>Git Providers</h2>
      </div>
      <div className="stack">
        <p className="muted">
          Connect providers, select repositories, and use exact-branch webhooks for redeploys.
        </p>
        <div className="actions">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter repositories"
          />
          <button
            className="btn ghost"
            type="button"
            onClick={onReloadRepos}
            disabled={loadingRepos}
          >
            Refresh GitHub
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={onReloadGitlabRepos}
            disabled={loadingGitlabRepos || !gitlabEnabled}
          >
            Refresh GitLab
          </button>
        </div>

        <article className="card nested">
          <div className="card-head">
            <h3>GitHub</h3>
          </div>
          {!appEnabled ? (
            <p className="muted">GitHub App is disabled on the server.</p>
          ) : (
            <>
              <button className="btn icp-rim" type="button" onClick={onConnectGitHubApp}>
                Connect GitHub App
              </button>
              {installations.length > 0 ? (
                <div className="project-grid repo-grid">
                  {installations.map((installation) => (
                    <article className="project-card" key={installation.installationId}>
                      <h3>
                        {installation.accountLogin || `Installation ${installation.installationId}`}
                      </h3>
                      <p className="project-meta">
                        {installation.accountType || "Unknown"} · ID {installation.installationId}
                      </p>
                      <div className="actions">
                        <button
                          className="btn ghost danger"
                          type="button"
                          onClick={() => onDisconnectInstallation(installation.installationId)}
                        >
                          Disconnect
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted">No installations linked yet.</p>
              )}
              {reconnectCount > 0 ? (
                <p className="muted">
                  {reconnectCount} project{reconnectCount === 1 ? "" : "s"} still use legacy OAuth
                  metadata and must be reconnected.
                </p>
              ) : null}
              <div className="project-grid repo-grid">
                {filteredGitHubRepos.map((repo) => (
                  <article className="project-card" key={repoSelectionKey(repo)}>
                    <h3>{repo.fullName}</h3>
                    <p className="project-meta">Default branch: {repo.defaultBranch || "main"}</p>
                    <p className="project-meta">{repo.private ? "Private" : "Public"} repository</p>
                    <p className="project-meta">
                      Installation:{" "}
                      {installationById.get(Number(repo.installationId))?.accountLogin ||
                        repo.installationId}
                    </p>
                  </article>
                ))}
              </div>
            </>
          )}
        </article>

        <article className="card nested">
          <div className="card-head">
            <h3>GitLab</h3>
          </div>
          {!gitlabEnabled ? (
            <p className="muted">GitLab integration is disabled on the server.</p>
          ) : (
            <>
              {gitlabConnected ? (
                <div className="item">
                  <div>
                    <strong>
                      {gitlabAccount?.identity?.name ||
                        gitlabAccount?.identity?.username ||
                        "GitLab account"}
                    </strong>
                    <p className="project-meta">
                      @{gitlabAccount?.identity?.username || "unknown"}
                    </p>
                  </div>
                  <div className="actions">
                    <button
                      className="btn ghost danger"
                      type="button"
                      onClick={onDisconnectGitLabAccount}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn icp-rim" type="button" onClick={onConnectGitLab}>
                  Connect GitLab
                </button>
              )}
              <div className="project-grid repo-grid">
                {filteredGitLabRepos.map((repo) => (
                  <article className="project-card" key={repoSelectionKey(repo)}>
                    <h3>{repo.pathWithNamespace || repo.fullName}</h3>
                    <p className="project-meta">Default branch: {repo.defaultBranch || "main"}</p>
                    <p className="project-meta">{repo.private ? "Private" : "Public"} repository</p>
                    <p className="project-meta">Project ID: {repo.id}</p>
                  </article>
                ))}
              </div>
              {gitlabConnected && filteredGitLabRepos.length === 0 ? (
                <p className="muted">No repositories available from linked GitLab account.</p>
              ) : null}
            </>
          )}
        </article>
      </div>
    </section>
  );
}

function TemplatesTab({
  session,
  templates,
  installations,
  loadingTemplates,
  onEnsureTemplates,
  onReloadTemplates,
  onProvisionTemplate,
  onTemplateProvisioned,
  onToast,
}) {
  const appEnabled = Boolean(session?.githubAppEnabled);
  const [templateModal, setTemplateModal] = useState(null);
  const [templateProvider, setTemplateProvider] = useState("github");
  const [templateRepoName, setTemplateRepoName] = useState("");
  const [templateProjectSlug, setTemplateProjectSlug] = useState("");
  const [templateInstallationId, setTemplateInstallationId] = useState("");
  const [templateSubmitting, setTemplateSubmitting] = useState(false);
  const [templateError, setTemplateError] = useState("");
  const [templateNextActionUrl, setTemplateNextActionUrl] = useState("");
  const hasTemplates = Array.isArray(templates) && templates.length > 0;

  useEffect(() => {
    onEnsureTemplates?.();
  }, [onEnsureTemplates]);

  function openTemplateModal(template) {
    const providerDefault = appEnabled ? "github" : "gitlab";
    const baseName = slugifyTemplateValue(
      String(template?.id || template?.name || "template")
        .replace(/^a3-/, "")
        .replace(/-template/g, ""),
      "my-template-project",
    );
    setTemplateModal(template);
    setTemplateProvider(providerDefault);
    setTemplateRepoName(baseName);
    setTemplateProjectSlug(baseName);
    setTemplateInstallationId(installations?.length ? String(installations[0].installationId) : "");
    setTemplateError("");
    setTemplateNextActionUrl("");
  }

  function closeTemplateModal() {
    if (templateSubmitting) {
      return;
    }
    setTemplateModal(null);
    setTemplateError("");
    setTemplateNextActionUrl("");
  }

  function buildGitHubTemplateGenerateUrl(template, repoName, ownerLogin = "") {
    if (!template?.providerSource) {
      return "";
    }
    try {
      const sourceUrl = new URL(String(template.providerSource));
      sourceUrl.pathname = `${String(sourceUrl.pathname || "").replace(/\/+$/, "")}/generate`;
      const normalizedName = String(repoName || "").trim();
      if (normalizedName) {
        sourceUrl.searchParams.set("name", normalizedName);
      }
      const normalizedOwner = String(ownerLogin || "").trim();
      if (normalizedOwner) {
        sourceUrl.searchParams.set("owner", normalizedOwner);
      }
      return sourceUrl.toString();
    } catch (_error) {
      return "";
    }
  }

  function openGitHubTemplatePage(overrideUrl = "") {
    const selectedInstallation =
      installations.find(
        (item) => String(item.installationId) === String(templateInstallationId),
      ) ||
      installations[0] ||
      null;
    const fallbackUrl = buildGitHubTemplateGenerateUrl(
      templateModal,
      templateRepoName,
      selectedInstallation?.accountLogin || "",
    );
    const targetUrl = String(overrideUrl || fallbackUrl || "").trim();
    if (!targetUrl) {
      onToast?.("Template link is invalid.", "error");
      return false;
    }
    const popup = window.open(targetUrl, "_blank", "noopener,noreferrer");
    if (!popup) {
      onToast?.("Popup blocked. Open template manually.", "error");
      return false;
    }
    return true;
  }

  async function submitTemplateProvision(event) {
    event.preventDefault();
    if (!templateModal || !onProvisionTemplate) {
      return;
    }
    setTemplateSubmitting(true);
    setTemplateError("");
    setTemplateNextActionUrl("");
    try {
      const payload = {
        templateId: templateModal.id,
        provider: templateProvider,
        repoName: templateRepoName.trim(),
        projectSlug: templateProjectSlug.trim(),
      };
      if (templateProvider === "github") {
        payload.githubInstallationId = templateInstallationId
          ? Number(templateInstallationId)
          : null;
      }
      const createdProject = await onProvisionTemplate(payload);
      onTemplateProvisioned?.(createdProject || null);
      setTemplateModal(null);
    } catch (error) {
      const fallbackActionUrl = buildGitHubTemplateGenerateUrl(
        templateModal,
        templateRepoName,
        installations.find((item) => String(item.installationId) === String(templateInstallationId))
          ?.accountLogin || "",
      );
      const nextActionUrl = String(error?.nextAction?.url || fallbackActionUrl || "").trim();
      const requiresRepoCreation =
        Boolean(error?.requiresUserRepoCreation) ||
        Boolean(error?.nextAction?.type === "open_github_template");
      if (templateProvider === "github" && requiresRepoCreation) {
        if (nextActionUrl) {
          setTemplateNextActionUrl(nextActionUrl);
          openGitHubTemplatePage(nextActionUrl);
        }
        const guidance = "Create the repo from template, then click Link repo and deploy.";
        setTemplateError(guidance);
        onToast?.(guidance, "info");
      } else {
        const message = error?.message || "Couldn't provision template.";
        setTemplateError(message);
        onToast?.(message, "error");
      }
    } finally {
      setTemplateSubmitting(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Templates</h2>
      </div>
      <div className="stack">
        <p className="muted">
          Start from curated templates and continue through the same project and deployment flow.
        </p>
        <div className="actions">
          <button
            className="btn ghost"
            type="button"
            onClick={onReloadTemplates}
            disabled={loadingTemplates}
          >
            Refresh templates
          </button>
        </div>
        {loadingTemplates && !hasTemplates ? <p className="muted">Loading templates...</p> : null}
        {!loadingTemplates && !hasTemplates ? (
          <p className="muted">No templates configured on the server.</p>
        ) : null}
        <div className="project-grid repo-grid">
          {(templates || []).map((template) => (
            <article className="project-card" key={template.id}>
              <h3>{template.name}</h3>
              <p className="project-meta template-card-source">{template.providerSource}</p>
              <p className="project-meta">
                Default framework: {template.defaultBuildConfig?.framework || "auto"}
              </p>
              <div className="actions">
                <button
                  className="btn icp-rim"
                  type="button"
                  onClick={() => openTemplateModal(template)}
                >
                  Use template
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
      {templateModal ? (
        <div className="modal-overlay" onClick={closeTemplateModal}>
          <div className="modal-card template-modal" onClick={(event) => event.stopPropagation()}>
            <div className="card-head">
              <h3>Use template</h3>
              <button
                className="btn ghost"
                type="button"
                onClick={closeTemplateModal}
                disabled={templateSubmitting}
              >
                Close
              </button>
            </div>
            <p className="muted">{templateModal.name}</p>
            <form className="form template-modal-form" onSubmit={submitTemplateProvision}>
              <div className="inline-fields">
                <label>
                  Provider
                  <select
                    value={templateProvider}
                    onChange={(event) => setTemplateProvider(event.target.value)}
                    disabled={templateSubmitting}
                  >
                    <option value="github">GitHub</option>
                    <option value="gitlab">GitLab</option>
                  </select>
                </label>
                {templateProvider === "github" ? (
                  <label>
                    GitHub account
                    <select
                      value={templateInstallationId}
                      onChange={(event) => setTemplateInstallationId(event.target.value)}
                      disabled={templateSubmitting}
                    >
                      <option value="">Select installation</option>
                      {installations.map((installation) => (
                        <option
                          key={installation.installationId}
                          value={String(installation.installationId)}
                        >
                          {installation.accountLogin ||
                            `Installation ${installation.installationId}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label>
                  Repository name
                  <input
                    value={templateRepoName}
                    onChange={(event) => setTemplateRepoName(event.target.value)}
                    placeholder="my-template-app"
                    required
                    disabled={templateSubmitting}
                  />
                </label>
                <label>
                  Project slug
                  <input
                    value={templateProjectSlug}
                    onChange={(event) => setTemplateProjectSlug(event.target.value)}
                    placeholder="my-template-app"
                    required
                    disabled={templateSubmitting}
                  />
                </label>
              </div>
              {templateProvider === "github" ? (
                <div className="stack">
                  <p className="muted">1. Open template on GitHub and create the repo.</p>
                  <div className="actions">
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => openGitHubTemplatePage()}
                      disabled={templateSubmitting}
                    >
                      Open GitHub template
                    </button>
                    {templateNextActionUrl ? (
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={() => openGitHubTemplatePage(templateNextActionUrl)}
                        disabled={templateSubmitting}
                      >
                        Open again
                      </button>
                    ) : null}
                  </div>
                  <p className="muted">2. Return and click Link repo and deploy.</p>
                </div>
              ) : null}
              {templateError ? <p className="admin-error">{templateError}</p> : null}
              <div className="actions">
                <button
                  className="btn ghost"
                  type="button"
                  onClick={closeTemplateModal}
                  disabled={templateSubmitting}
                >
                  Cancel
                </button>
                <button className="btn icp-rim" type="submit" disabled={templateSubmitting}>
                  {templateSubmitting
                    ? "Provisioning..."
                    : templateProvider === "github"
                      ? "Link repo and deploy"
                      : "Create from template"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProfileTab({
  session,
  projects,
  deployments,
  repos,
  theme,
  setTheme,
  onSaveAvatar,
  onResetPassword,
  onLogout,
  onToast,
}) {
  const [avatarUrl, setAvatarUrl] = useState(session.user?.avatarUrl || "");
  const isAdmin = Boolean(session?.user?.isAdmin);
  const [avatarSaved, setAvatarSaved] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const avatarSavedTimerRef = useRef(null);
  const passwordSavedTimerRef = useRef(null);

  useEffect(() => {
    setAvatarUrl(session.user?.avatarUrl || "");
  }, [session.user?.avatarUrl]);

  useEffect(() => {
    return () => {
      if (avatarSavedTimerRef.current) {
        clearTimeout(avatarSavedTimerRef.current);
      }
      if (passwordSavedTimerRef.current) {
        clearTimeout(passwordSavedTimerRef.current);
      }
    };
  }, []);

  function markAvatarSaved() {
    setAvatarSaved(true);
    if (avatarSavedTimerRef.current) {
      clearTimeout(avatarSavedTimerRef.current);
    }
    avatarSavedTimerRef.current = setTimeout(() => {
      setAvatarSaved(false);
    }, 2500);
  }

  function markPasswordSaved() {
    setPasswordSaved(true);
    if (passwordSavedTimerRef.current) {
      clearTimeout(passwordSavedTimerRef.current);
    }
    passwordSavedTimerRef.current = setTimeout(() => {
      setPasswordSaved(false);
    }, 2500);
  }

  async function saveAvatar() {
    try {
      await onSaveAvatar(avatarUrl.trim());
      markAvatarSaved();
    } catch (error) {
      onToast(error.message || "Failed to update avatar.", "error");
    }
  }

  async function useGithubAvatar() {
    try {
      await onSaveAvatar(session.github?.avatarUrl || session.gitlab?.avatarUrl || "");
      markAvatarSaved();
    } catch (error) {
      onToast(error.message || "Failed to update avatar.", "error");
    }
  }

  async function clearAvatar() {
    try {
      await onSaveAvatar("");
      setAvatarUrl("");
      markAvatarSaved();
    } catch (error) {
      onToast(error.message || "Failed to clear avatar.", "error");
    }
  }

  async function resetPassword(event) {
    event.preventDefault();
    if (!currentPassword) {
      onToast("Enter current password.", "error");
      return;
    }
    if (nextPassword.length < 8) {
      onToast("Password must be 8+ chars.", "error");
      return;
    }
    if (nextPassword !== confirmPassword) {
      onToast("Passwords do not match.", "error");
      return;
    }
    try {
      await onResetPassword({
        currentPassword,
        newPassword: nextPassword,
      });
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      markPasswordSaved();
      onToast("Password updated.", "success");
    } catch (error) {
      onToast(error.message || "Failed to update password.", "error");
    }
  }

  return (
    <div className="grid-2">
      <section className="card">
        <div className="card-head">
          <h2>Profile</h2>
        </div>
        <div className="item">
          <div>
            <strong>{session.user?.email || "-"}</strong>
            <p>GitHub: {session.github?.login || "not linked"}</p>
            <p>GitLab: {session.gitlab?.username || "not linked"}</p>
          </div>
          <img
            className="avatar-preview"
            src={
              session.user?.avatarUrl ||
              session.github?.avatarUrl ||
              session.gitlab?.avatarUrl ||
              DEFAULT_AVATAR
            }
            alt="avatar"
          />
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Workspace Stats</h2>
        </div>
        <div className="activity-summary">
          <article className="mini-stat">
            <p>Projects</p>
            <strong>
              {isAdmin ? `${projects.length} / admin` : `${projects.length}/${MAX_PROJECTS}`}
            </strong>
          </article>
          <article className="mini-stat">
            <p>Deployments</p>
            <strong>{deployments.length}</strong>
          </article>
          <article className="mini-stat">
            <p>Repos</p>
            <strong>{repos.length}</strong>
          </article>
        </div>
        <div className="form">
          <label>
            Avatar URL
            <input
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="https://example.com/avatar.png"
            />
          </label>
          <div className="actions">
            <button className="btn icp-rim" onClick={saveAvatar}>
              Save avatar
            </button>
            <button className="btn ghost" onClick={useGithubAvatar}>
              Use GitHub avatar
            </button>
            <button className="btn ghost" onClick={clearAvatar}>
              Clear
            </button>
            {avatarSaved ? <span className="inline-success">Saved</span> : null}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Appearance</h2>
        </div>
        <p className="muted">Use the default dark dashboard or switch to a clean light mode.</p>
        <div className="settings-row-actions">
          <button
            type="button"
            className={theme === "dark" ? "theme-mode-button active" : "theme-mode-button"}
            onClick={() => setTheme("dark")}
          >
            <ThemeModeIcon mode="dark" />
            Dark
          </button>
          <button
            type="button"
            className={theme === "light" ? "theme-mode-button active" : "theme-mode-button"}
            onClick={() => setTheme("light")}
          >
            <ThemeModeIcon mode="light" />
            Light
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Session</h2>
        </div>
        <p className="muted">Sign out of this dashboard session.</p>
        <div className="actions">
          <button className="btn ghost" type="button" onClick={onLogout}>
            Log out
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Security</h2>
        </div>
        <form className="form" onSubmit={resetPassword}>
          <label>
            Current password
            <input
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              placeholder="Current password"
              autoComplete="current-password"
              required
            />
          </label>
          <label>
            New password
            <input
              value={nextPassword}
              onChange={(event) => setNextPassword(event.target.value)}
              type="password"
              placeholder="At least 8 characters"
              autoComplete="new-password"
              required
              minLength={8}
            />
          </label>
          <label>
            Confirm new password
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              placeholder="Repeat new password"
              autoComplete="new-password"
              required
              minLength={8}
            />
          </label>
          <div className="actions">
            <button className="btn icp-rim" type="submit">
              Reset password
            </button>
            {passwordSaved ? <span className="inline-success">Saved</span> : null}
          </div>
        </form>
      </section>
    </div>
  );
}

function AdminTab({
  range,
  onRangeChange,
  overview,
  timeseries,
  canisters,
  hostCanisters,
  deployedProjects,
  loading,
  error,
  onRefresh,
  onCreateHostCanister,
  onUpdateHostCanister,
}) {
  const totals = overview?.totals || {};
  const inRange = overview?.inRange || {};
  const failureInsights = overview?.failureInsights || {};
  const insightTopCauses = Array.isArray(failureInsights.topCauses)
    ? failureInsights.topCauses
    : [];
  const insightRecentFailures = Array.isArray(failureInsights.recentFailures)
    ? failureInsights.recentFailures
    : [];
  const points = Array.isArray(timeseries?.points) ? timeseries.points : [];
  const canisterItems = Array.isArray(canisters?.items) ? canisters.items : [];
  const hostCanisterItems = Array.isArray(hostCanisters?.items) ? hostCanisters.items : [];
  const deployedProjectItems = Array.isArray(deployedProjects?.items) ? deployedProjects.items : [];
  const [hostForm, setHostForm] = useState({
    alias: "",
    canisterId: "",
    status: "active",
    region: "global",
    visibility: "public",
    capacity: "",
  });
  const [statusDrafts, setStatusDrafts] = useState({});
  const [regionDrafts, setRegionDrafts] = useState({});
  const [visibilityDrafts, setVisibilityDrafts] = useState({});
  const [savingHostCanister, setSavingHostCanister] = useState(false);
  const [savingStatusId, setSavingStatusId] = useState("");
  const [hostCanisterError, setHostCanisterError] = useState("");
  const statsByCanisterId = useMemo(
    () => new Map(canisterItems.map((item) => [String(item.canisterId || ""), item])),
    [canisterItems],
  );

  useEffect(() => {
    const next = {};
    const nextRegions = {};
    const nextVisibilities = {};
    hostCanisterItems.forEach((item) => {
      next[item.id] = item.status || "active";
      nextRegions[item.id] = item.region || "global";
      nextVisibilities[item.id] = item.visibility || "public";
    });
    setStatusDrafts(next);
    setRegionDrafts(nextRegions);
    setVisibilityDrafts(nextVisibilities);
  }, [hostCanisterItems]);

  async function handleCreateHostCanister(event) {
    event.preventDefault();
    setHostCanisterError("");
    setSavingHostCanister(true);
    try {
      await onCreateHostCanister({
        alias: hostForm.alias.trim().toLowerCase(),
        canisterId: hostForm.canisterId.trim().toLowerCase(),
        status: hostForm.status,
        region: hostForm.region.trim().toLowerCase() || "global",
        visibility: hostForm.visibility,
        capacity: hostForm.capacity.trim() === "" ? null : hostForm.capacity.trim(),
      });
      setHostForm({
        alias: "",
        canisterId: "",
        status: "active",
        region: "global",
        visibility: "public",
        capacity: "",
      });
    } catch (submitError) {
      setHostCanisterError(submitError.message || "Cannot add host canister.");
    } finally {
      setSavingHostCanister(false);
    }
  }

  async function handleSaveHostStatus(item) {
    const nextStatus = statusDrafts[item.id] || item.status;
    const nextRegion = (regionDrafts[item.id] || item.region || "global").trim().toLowerCase();
    const nextVisibility = visibilityDrafts[item.id] || item.visibility || "public";
    const payload = {};
    if (nextStatus && nextStatus !== item.status) {
      payload.status = nextStatus;
    }
    if (nextRegion && nextRegion !== (item.region || "global")) {
      payload.region = nextRegion;
    }
    if (nextVisibility && nextVisibility !== (item.visibility || "public")) {
      payload.visibility = nextVisibility;
    }
    if (Object.keys(payload).length === 0) {
      return;
    }
    setHostCanisterError("");
    setSavingStatusId(item.id);
    try {
      await onUpdateHostCanister(item.id, payload);
    } catch (saveError) {
      setHostCanisterError(saveError.message || "Cannot update canister status.");
    } finally {
      setSavingStatusId("");
    }
  }

  return (
    <section className="card admin-dashboard">
      <div className="card-head admin-head">
        <div>
          <h2>Admin Analytics</h2>
          <p className="muted">Platform-wide stats and canister distribution.</p>
        </div>
        <div className="admin-controls">
          <div className="admin-range">
            {ANALYTICS_RANGES.map((item) => (
              <button
                key={item}
                type="button"
                className={item === range ? "active" : ""}
                onClick={() => onRangeChange(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <button type="button" className="btn ghost" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </div>

      {loading ? <p className="muted">Loading admin analytics...</p> : null}
      {error ? <p className="muted admin-error">{error}</p> : null}

      <div className="admin-kpi-grid">
        <article className="mini-stat admin-kpi">
          <p>Total accounts</p>
          <strong>{totals.accounts ?? 0}</strong>
        </article>
        <article className="mini-stat admin-kpi">
          <p>Total projects</p>
          <strong>{totals.projects ?? 0}</strong>
        </article>
        <article className="mini-stat admin-kpi">
          <p>Total hosted websites</p>
          <strong>{totals.hostedWebsites ?? 0}</strong>
        </article>
        <article className="mini-stat admin-kpi">
          <p>Total deployments</p>
          <strong>{totals.deployments ?? 0}</strong>
        </article>
        <article className="mini-stat admin-kpi">
          <p>Deployments ({range})</p>
          <strong>{inRange.deployments ?? 0}</strong>
        </article>
        <article className="mini-stat admin-kpi">
          <p>Success rate ({range})</p>
          <strong>
            {Number.isFinite(inRange.successRatePct) ? `${inRange.successRatePct}%` : "-"}
          </strong>
        </article>
        <article className="mini-stat admin-kpi">
          <p>Failures ({range})</p>
          <strong>{inRange.failed ?? 0}</strong>
        </article>
      </div>

      <section className="admin-insights">
        <div className="card-head">
          <h3>Operational Insights</h3>
          <span className="muted">
            {Number(failureInsights.totalFailedInRange || 0)} failed in {range}
            {Number(failureInsights.analyzedFailedDeployments || 0) >
            Number(failureInsights.sampleLimit || 0)
              ? ` (showing latest ${failureInsights.sampleLimit})`
              : ""}
          </span>
        </div>
        {insightTopCauses.length === 0 ? (
          <p className="muted">No recurring failure patterns in this range.</p>
        ) : (
          <div className="admin-insight-grid">
            {insightTopCauses.map((cause) => (
              <article key={cause.id} className="admin-insight-item">
                <div className="admin-insight-head">
                  <strong>{cause.title}</strong>
                  <span className="admin-insight-count">{cause.count}</span>
                </div>
                <p className="muted">{cause.hint}</p>
                {cause.sample?.project ? (
                  <p className="admin-insight-sample">
                    Sample: <b>{cause.sample.project}</b>
                    {cause.sample?.branch ? ` (${cause.sample.branch})` : ""}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {insightRecentFailures.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recent failed deployment</th>
                  <th>Reason</th>
                  <th>Hint</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {insightRecentFailures.map((item) => (
                  <tr key={item.deploymentId}>
                    <td>
                      <div className="table-cell-stack">
                        <strong>{item.project || item.projectId}</strong>
                        <span className="muted">{item.ownerEmail || "-"}</span>
                      </div>
                    </td>
                    <td>{item.reason}</td>
                    <td>{item.hint}</td>
                    <td>{item.createdAt ? formatDate(item.createdAt) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <div className="admin-chart-grid">
        <article className="admin-metric-card admin-metric-card-wide">
          <div className="admin-metric-head">
            <h3>Growth Timeline</h3>
            <span className="muted">Signups, projects, deployments</span>
          </div>
          <Suspense fallback={<p className="muted">Loading chart…</p>}>
            <AnalyticsBundle kind="admin-trend" points={points} />
          </Suspense>
        </article>
        <article className="admin-metric-card admin-metric-card-wide">
          <div className="admin-metric-head">
            <h3>Deployment Quality</h3>
            <span className="muted">Succeeded vs failed in {range}</span>
          </div>
          <Suspense fallback={<p className="muted">Loading chart…</p>}>
            <AnalyticsBundle kind="admin-quality" points={points} />
          </Suspense>
        </article>
      </div>

      <section className="admin-canisters">
        <div className="card-head">
          <h3>Host Canister Registry</h3>
          <span className="muted">{hostCanisterItems.length} configured</span>
        </div>
        <form className="admin-canister-form" onSubmit={handleCreateHostCanister}>
          <label>
            Alias (domain label)
            <input
              value={hostForm.alias}
              onChange={(event) => setHostForm((prev) => ({ ...prev, alias: event.target.value }))}
              placeholder="eu-host-1"
              required
            />
          </label>
          <label>
            Canister ID
            <input
              value={hostForm.canisterId}
              onChange={(event) =>
                setHostForm((prev) => ({ ...prev, canisterId: event.target.value }))
              }
              placeholder="t2ep4-sqaaa-aaaaa-qdjta-cai"
              required
            />
          </label>
          <label>
            Status
            <select
              value={hostForm.status}
              onChange={(event) => setHostForm((prev) => ({ ...prev, status: event.target.value }))}
            >
              {ADMIN_CANISTER_STATUSES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            Region
            <input
              value={hostForm.region}
              onChange={(event) => setHostForm((prev) => ({ ...prev, region: event.target.value }))}
              placeholder="global"
              required
            />
          </label>
          <label>
            Visibility
            <select
              value={hostForm.visibility}
              onChange={(event) =>
                setHostForm((prev) => ({ ...prev, visibility: event.target.value }))
              }
            >
              <option value="public">public</option>
              <option value="private">private</option>
            </select>
          </label>
          <label>
            Capacity (optional)
            <input
              value={hostForm.capacity}
              onChange={(event) =>
                setHostForm((prev) => ({ ...prev, capacity: event.target.value }))
              }
              placeholder="1000"
              inputMode="numeric"
            />
          </label>
          <button className="btn" type="submit" disabled={savingHostCanister}>
            {savingHostCanister ? "Adding..." : "Add host canister"}
          </button>
        </form>
        {hostCanisterError ? <p className="admin-error">{hostCanisterError}</p> : null}
        <article className="admin-metric-card">
          <div className="admin-metric-head">
            <h3>Websites per Host Canister</h3>
            <span className="muted">{canisterItems.length} with traffic</span>
          </div>
          <Suspense fallback={<p className="muted">Loading chart…</p>}>
            <AnalyticsBundle kind="admin-canister" items={canisterItems} />
          </Suspense>
        </article>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Alias</th>
                <th>Canister ID</th>
                <th>Route</th>
                <th>Websites</th>
                <th>Deployments ({range})</th>
                <th>Success Rate</th>
                <th>Status</th>
                <th>Region</th>
                <th>Visibility</th>
                <th>Capacity</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {hostCanisterItems.length === 0 ? (
                <tr>
                  <td colSpan={11} className="muted">
                    No host canisters configured yet.
                  </td>
                </tr>
              ) : (
                hostCanisterItems.map((item) => {
                  const stats = statsByCanisterId.get(String(item.canisterId || ""));
                  const savingStatus = savingStatusId === item.id;
                  return (
                    <tr key={item.id}>
                      <td>{item.alias || "-"}</td>
                      <td>{item.canisterId}</td>
                      <td>{item.alias ? `*--${item.alias}.<hosting-domain>` : "-"}</td>
                      <td>{stats?.websites ?? 0}</td>
                      <td>{stats?.deployments ?? 0}</td>
                      <td>
                        {Number.isFinite(stats?.successRatePct) ? `${stats.successRatePct}%` : "-"}
                      </td>
                      <td>
                        <select
                          value={statusDrafts[item.id] || item.status}
                          onChange={(event) =>
                            setStatusDrafts((prev) => ({
                              ...prev,
                              [item.id]: event.target.value,
                            }))
                          }
                        >
                          {ADMIN_CANISTER_STATUSES.map((statusItem) => (
                            <option key={statusItem} value={statusItem}>
                              {statusItem}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          value={regionDrafts[item.id] || item.region || "global"}
                          onChange={(event) =>
                            setRegionDrafts((prev) => ({
                              ...prev,
                              [item.id]: event.target.value,
                            }))
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={visibilityDrafts[item.id] || item.visibility || "public"}
                          onChange={(event) =>
                            setVisibilityDrafts((prev) => ({
                              ...prev,
                              [item.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="public">public</option>
                          <option value="private">private</option>
                        </select>
                      </td>
                      <td>{item.capacity ?? "-"}</td>
                      <td>
                        <button
                          type="button"
                          className="btn ghost btn-sm"
                          onClick={() => handleSaveHostStatus(item)}
                          disabled={
                            savingStatus ||
                            ((statusDrafts[item.id] || item.status) === item.status &&
                              (regionDrafts[item.id] || item.region || "global") ===
                                (item.region || "global") &&
                              (visibilityDrafts[item.id] || item.visibility || "public") ===
                                (item.visibility || "public"))
                          }
                        >
                          {savingStatus ? "Saving..." : "Save"}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-canisters">
        <div className="card-head">
          <h3>Deployed Projects by Owner</h3>
          <span className="muted">{deployedProjectItems.length} deployed projects</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Owner</th>
                <th>Provider</th>
                <th>Branch</th>
                <th>Deployments</th>
                <th>Last status</th>
                <th>Last deployed</th>
              </tr>
            </thead>
            <tbody>
              {deployedProjectItems.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    No deployed projects found.
                  </td>
                </tr>
              ) : (
                deployedProjectItems.map((item) => {
                  const projectLabel =
                    item.tenantSlug ||
                    item.githubFullName ||
                    item.gitlabPathWithNamespace ||
                    item.repoUrl ||
                    item.projectId;
                  const hostedHref = item.hostedUrl || "";
                  return (
                    <tr key={item.projectId}>
                      <td>
                        <div className="table-cell-stack">
                          <strong>{projectLabel}</strong>
                          {hostedHref ? (
                            <a href={hostedHref} target="_blank" rel="noopener noreferrer">
                              {hostedHref}
                            </a>
                          ) : (
                            <span className="muted">{item.projectId}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="table-cell-stack">
                          <strong>{item.owner?.name || item.owner?.email || "-"}</strong>
                          <span className="muted">{item.owner?.email || "-"}</span>
                        </div>
                      </td>
                      <td>{item.gitProvider || "-"}</td>
                      <td>{item.branch || "-"}</td>
                      <td>{item.deploymentsCount ?? 0}</td>
                      <td>{formatDeploymentStatus(item.lastDeploymentStatus || "queued")}</td>
                      <td>{item.lastDeployedAt ? formatDate(item.lastDeployedAt) : "-"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function NotificationsBell({
  notifications,
  unreadCount,
  onOpen,
  onReadOne,
  onDeleteOne,
  onGoToOverview,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      onOpen();
    }
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleOutsideMouseDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideMouseDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutsideMouseDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="notifications-wrap" ref={wrapRef}>
      <button className="notif-btn" type="button" onClick={toggle} aria-label="Notifications">
        <span aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M8 18h8m-7 0a3 3 0 1 0 6 0m4-2H5c1.2-1.4 2-3.3 2-5.4V9a5 5 0 1 1 10 0v1.6c0 2.1.8 4 2 5.4z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        {unreadCount > 0 ? <i>{unreadCount}</i> : null}
      </button>
      {open ? (
        <section className="notif-popover">
          <header>
            <strong>Notifications</strong>
          </header>
          <div className="notif-list">
            {notifications.length === 0 ? (
              <p className="muted">No notifications yet.</p>
            ) : (
              notifications.map((item) => (
                <article
                  key={item.id}
                  className={`notif-item ${item.readAt ? "" : "unread"} ${statusClass(item.type)}`}
                >
                  <div className="notif-row">
                    <button
                      type="button"
                      className="notif-main"
                      onClick={async () => {
                        await onReadOne(item.id);
                        onGoToOverview?.();
                        setOpen(false);
                      }}
                    >
                      <strong>{item.title}</strong>
                      <p>{item.body || ""}</p>
                      <span>{formatDate(item.createdAt)}</span>
                    </button>
                    <button
                      type="button"
                      className="notif-delete"
                      aria-label="Delete notification"
                      onClick={async () => {
                        await onDeleteOne(item.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Dashboard({
  session,
  onLogout,
  projects,
  deployments,
  repos,
  templates,
  githubInstallations,
  gitlabAccount,
  loadingRepos,
  loadingGitlabRepos,
  loadingTemplates,
  onReloadRepos,
  onReloadGitlabRepos,
  onEnsureRepos,
  onEnsureTemplates,
  onReloadTemplates,
  onProvisionTemplate,
  onConnectGitHubApp,
  onConnectGitLab,
  onDisconnectGitHubInstallation,
  onDisconnectGitLabAccount,
  onCreateProject,
  deploymentRegions,
  onReloadDeploymentRegions,
  onStartCheckout,
  onManageBilling,
  onRedeploy,
  onSaveAvatar,
  onResetPassword,
  busyProjectId,
  notifications,
  unreadNotifications,
  onOpenNotifications,
  onReadNotification,
  onDeleteNotification,
  onToast,
  adminRange,
  onAdminRangeChange,
  adminOverview,
  adminTimeseries,
  adminCanisters,
  adminHostCanisters,
  adminDeployedProjects,
  adminLoading,
  adminError,
  onRefreshAdminStats,
  onCreateHostCanister,
  onUpdateHostCanister,
  onProjectDeleted,
  onProjectUpdated,
}) {
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [forceCreateProjectFlow, setForceCreateProjectFlow] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const initializedFromUrlRef = useRef(false);
  const isAdmin = Boolean(session?.user?.isAdmin);
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "dark";
    const savedTheme = localStorage.getItem(THEME_KEY);
    return savedTheme === "light" ? "light" : "dark";
  });

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const tabs = useMemo(
    () => [
      { id: "overview", label: "Overview" },
      { id: "projects", label: "Projects" },
      { id: "deployments", label: "Deployments" },
      { id: "templates", label: "Templates" },
      { id: "integrations", label: "Integrations" },
      { id: "eject", label: "Eject" },
      { id: "settings", label: "Settings" },
      { id: "tier", label: "Plan" },
      ...(isAdmin ? [{ id: "admin", label: "Admin" }] : []),
    ],
    [isAdmin],
  );
  const activeTabMeta = tabs.find((tab) => tab.id === activeTab) || tabs[0];
  const topbarSubtitle =
    {
      overview: "Here's what's happening with your projects.",
      projects: "Configure builds, environment variables, and webhook settings.",
      deployments: "Inspect build and deploy history from your production pipeline.",
      templates: "Provision approved starter templates.",
      integrations: "Connect GitHub and GitLab providers.",
      eject: "Prepare ownership transfer tools for hosted ICP projects.",
      settings: "Profile, security, and dashboard preferences.",
      tier: "Manage billing, limits, and upgrade options.",
      admin: "Platform analytics and host canister controls.",
    }[activeTab] || "";

  const allowedTabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  useEffect(() => {
    if (initializedFromUrlRef.current) {
      return;
    }
    if (typeof window === "undefined") return;
    initializedFromUrlRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    const project = params.get("project");
    const onboarding = String(params.get("onboarding") || "")
      .trim()
      .toLowerCase();
    const normalizedTab =
      tab === "github"
        ? "integrations"
        : tab === "profile" || tab === "team"
          ? "settings"
          : tab === "analytics" || tab === "domains"
            ? "overview"
            : tab;
    if (normalizedTab && allowedTabIds.includes(normalizedTab)) {
      setActiveTab(normalizedTab);
    }
    if (project) {
      setSelectedProjectId(project);
    }
    if (onboarding === "connect-repo") {
      setActiveTab("overview");
      setForceCreateProjectFlow(true);
    }
    params.delete("onboarding");
    params.delete("provider");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [allowedTabIds]);

  useEffect(() => {
    if (activeTab === "admin" && !isAdmin) {
      setActiveTab("overview");
    }
  }, [activeTab, isAdmin]);

  useEffect(() => {
    if (activeTab !== "integrations") {
      return;
    }
    onEnsureRepos?.();
  }, [activeTab, onEnsureRepos]);

  useEffect(() => {
    if (activeTab !== "templates") {
      return;
    }
    onEnsureTemplates?.();
  }, [activeTab, onEnsureTemplates]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const safeTab = allowedTabIds.includes(activeTab) ? activeTab : "overview";
    const params = new URLSearchParams(window.location.search);
    params.set("tab", safeTab);
    if (selectedProjectId) {
      params.set("project", selectedProjectId);
    } else {
      params.delete("project");
    }
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) {
      window.history.replaceState({}, "", nextUrl);
    }
  }, [activeTab, allowedTabIds, selectedProjectId]);

  useEffect(() => {
    if (!projects.length) {
      setSelectedProjectId("");
      return;
    }
    if (!projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  function openProjectSettings(projectId) {
    setSelectedProjectId(projectId);
    setActiveTab("projects");
  }

  function openCreateProjectFlow() {
    setActiveTab("overview");
    setForceCreateProjectFlow(true);
    onEnsureRepos?.();
  }

  function toggleTheme() {
    setTheme((current) => (current === "light" ? "dark" : "light"));
  }

  return (
    <div className="app" data-theme={theme}>
      <aside className="sidebar">
        <div className="brand">
          <div className="wordmark">A3</div>
        </div>
        <nav className="nav">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="nav-icon">
                <SidebarTabIcon tabId={tab.id} />
              </span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-account">
          <button
            className="sidebar-account-main"
            type="button"
            onClick={() => setActiveTab("settings")}
          >
            <img
              src={
                session.user?.avatarUrl ||
                session.github?.avatarUrl ||
                session.gitlab?.avatarUrl ||
                DEFAULT_AVATAR
              }
              alt="avatar"
            />
            <span>
              <strong>{session.user?.displayName || session.user?.email}</strong>
              <em>
                {session.user?.isAdmin ? "Admin" : "Workspace"}
                {session.billing?.isPro ? <b className="account-pro-pill">A3 Pro</b> : null}
              </em>
            </span>
          </button>
          <button
            className="theme-toggle-btn"
            type="button"
            onClick={toggleTheme}
            aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            title={theme === "light" ? "Dark mode" : "Light mode"}
          >
            <ThemeModeIcon mode={theme === "light" ? "dark" : "light"} />
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>
              {activeTabMeta?.label || "Overview"}
              {session.billing?.isPro ? <span className="topbar-pro-pill">A3 Pro</span> : null}
            </h1>
            {topbarSubtitle ? <p>{topbarSubtitle}</p> : null}
          </div>
          {activeTab === "overview" ? (
            <div className="topbar-search">
              <span aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                  <path
                    d="m15.2 15.2 4.3 4.3"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <input
                value={globalSearch}
                onChange={(event) => setGlobalSearch(event.target.value)}
                placeholder="Search projects and deployments..."
              />
            </div>
          ) : (
            <div />
          )}
          <div className="topbar-actions">
            <NotificationsBell
              notifications={notifications}
              unreadCount={unreadNotifications}
              onOpen={onOpenNotifications}
              onReadOne={onReadNotification}
              onDeleteOne={onDeleteNotification}
              onGoToOverview={() => setActiveTab("overview")}
            />
            <button
              className="btn icp-rim new-project-top-btn"
              type="button"
              onClick={openCreateProjectFlow}
            >
              <span aria-hidden="true">+</span>
              New Project
            </button>
          </div>
        </header>

        <section id="content">
          {activeTab === "overview" ? (
            <OverviewTab
              projects={projects}
              deployments={deployments}
              repos={repos}
              githubLinked={githubInstallations.length > 0}
              gitlabLinked={Boolean(gitlabAccount?.connected)}
              onEnsureRepos={onEnsureRepos}
              forceCreateFlow={forceCreateProjectFlow}
              onCreateFlowConsumed={() => setForceCreateProjectFlow(false)}
              onCreateProject={onCreateProject}
              session={session}
              deploymentRegions={deploymentRegions}
              onReloadDeploymentRegions={onReloadDeploymentRegions}
              onRedeploy={onRedeploy}
              onOpenProjectSettings={openProjectSettings}
              busyProjectId={busyProjectId}
              onToast={onToast}
              selectedProjectId={selectedProjectId}
              setSelectedProjectId={setSelectedProjectId}
              globalSearch={globalSearch}
              onViewDeployments={() => setActiveTab("deployments")}
            />
          ) : null}
          {activeTab === "projects" ? (
            <ProjectsTab
              projects={projects}
              onToast={onToast}
              selectedProjectId={selectedProjectId}
              setSelectedProjectId={setSelectedProjectId}
              onProjectDeleted={onProjectDeleted}
              onProjectUpdated={onProjectUpdated}
              onRedeploy={onRedeploy}
            />
          ) : null}
          {activeTab === "deployments" ? <DeploymentsTab deployments={deployments} /> : null}
          {activeTab === "admin" && isAdmin ? (
            <AdminTab
              range={adminRange}
              onRangeChange={onAdminRangeChange}
              overview={adminOverview}
              timeseries={adminTimeseries}
              canisters={adminCanisters}
              hostCanisters={adminHostCanisters}
              deployedProjects={adminDeployedProjects}
              loading={adminLoading}
              error={adminError}
              onRefresh={onRefreshAdminStats}
              onCreateHostCanister={onCreateHostCanister}
              onUpdateHostCanister={onUpdateHostCanister}
            />
          ) : null}
          {activeTab === "integrations" ? (
            <GithubTab
              session={session}
              projects={projects}
              installations={githubInstallations}
              repos={repos}
              gitlabAccount={gitlabAccount}
              loadingRepos={loadingRepos}
              loadingGitlabRepos={loadingGitlabRepos}
              onReloadRepos={onReloadRepos}
              onReloadGitlabRepos={onReloadGitlabRepos}
              onConnectGitHubApp={onConnectGitHubApp}
              onConnectGitLab={onConnectGitLab}
              onDisconnectInstallation={onDisconnectGitHubInstallation}
              onDisconnectGitLabAccount={onDisconnectGitLabAccount}
            />
          ) : null}
          {activeTab === "templates" ? (
            <TemplatesTab
              session={session}
              templates={templates}
              installations={githubInstallations}
              loadingTemplates={loadingTemplates}
              onEnsureTemplates={onEnsureTemplates}
              onReloadTemplates={onReloadTemplates}
              onProvisionTemplate={onProvisionTemplate}
              onTemplateProvisioned={(project) => {
                if (project?.id) {
                  setSelectedProjectId(project.id);
                }
                setActiveTab("overview");
              }}
              onToast={onToast}
            />
          ) : null}
          {activeTab === "eject" ? <EjectTab /> : null}
          {activeTab === "tier" ? (
            <TierTab
              billing={session.billing}
              projects={projects}
              deployments={deployments}
              onStartCheckout={onStartCheckout}
              onManageBilling={onManageBilling}
              onToast={onToast}
            />
          ) : null}
          {activeTab === "settings" ? (
            <ProfileTab
              session={session}
              projects={projects}
              deployments={deployments}
              repos={repos}
              theme={theme}
              setTheme={setTheme}
              onSaveAvatar={onSaveAvatar}
              onResetPassword={onResetPassword}
              onLogout={onLogout}
              onToast={onToast}
            />
          ) : null}
        </section>
      </main>
    </div>
  );
}

function App() {
  const [sessionBootstrapStatus, setSessionBootstrapStatus] = useState(SESSION_BOOTSTRAP_UNKNOWN);
  const [session, setSession] = useState(() => createUnauthedSessionState());
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [authErrorMessage, setAuthErrorMessage] = useState("");

  const [projects, setProjects] = useState([]);
  const [deployments, setDeployments] = useState([]);
  const [deploymentsHydrated, setDeploymentsHydrated] = useState(false);
  const [repos, setRepos] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [githubInstallations, setGithubInstallations] = useState([]);
  const [gitlabAccount, setGitlabAccount] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [deploymentRegions, setDeploymentRegions] = useState({ public: [], private: [] });
  const [adminRange, setAdminRange] = useState("7d");
  const [adminOverview, setAdminOverview] = useState(null);
  const [adminTimeseries, setAdminTimeseries] = useState(null);
  const [adminCanisters, setAdminCanisters] = useState(null);
  const [adminHostCanisters, setAdminHostCanisters] = useState(null);
  const [adminDeployedProjects, setAdminDeployedProjects] = useState(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [loadingGitlabRepos, setLoadingGitlabRepos] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [busyProjectId, setBusyProjectId] = useState("");
  const [savingOnboarding, setSavingOnboarding] = useState(false);
  const [toasts, setToasts] = useState([]);
  const repoCacheRef = useRef({
    userId: null,
    gitlabEnabled: true,
    fetchedAt: 0,
    repos: [],
  });

  const authed = Boolean(session?.user?.email);
  const isAdmin = Boolean(session?.user?.isAdmin);
  const onboardingRequired = Boolean(authed && session?.user?.onboardingRequired);

  const unreadNotifications = notifications.filter((item) => !item.readAt).length;
  const stageStatusRef = useRef(new Map());
  const stageToastRef = useRef(new Set());
  const stageStatusBootstrappedRef = useRef(false);
  const toastTimersRef = useRef(new Map());
  const pendingNotificationDeleteIdsRef = useRef(new Set());

  const clearToastTimer = useCallback((id) => {
    const timerEntry = toastTimersRef.current.get(id);
    if (timerEntry?.timeoutId) {
      clearTimeout(timerEntry.timeoutId);
    }
    toastTimersRef.current.delete(id);
  }, []);

  const removeToast = useCallback(
    (id, options = {}) => {
      const immediate = Boolean(options.immediate);
      clearToastTimer(id);
      setToasts((prev) => {
        const index = prev.findIndex((item) => item.id === id);
        if (index === -1) {
          return prev;
        }
        if (immediate) {
          const next = [...prev];
          next.splice(index, 1);
          return next;
        }
        if (prev[index].closing) {
          return prev;
        }
        const next = [...prev];
        next[index] = { ...next[index], closing: true };
        return next;
      });
      if (!immediate) {
        window.setTimeout(() => {
          setToasts((prev) => prev.filter((item) => item.id !== id));
        }, TOAST_EXIT_MS);
      }
    },
    [clearToastTimer],
  );

  const pauseToastTimer = useCallback((id) => {
    const entry = toastTimersRef.current.get(id);
    if (!entry || !entry.running) {
      return;
    }
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
    const elapsed = Date.now() - entry.startedAt;
    const remainingMs = Math.max(0, entry.remainingMs - elapsed);
    toastTimersRef.current.set(id, {
      ...entry,
      timeoutId: null,
      remainingMs,
      running: false,
    });
  }, []);

  const resumeToastTimer = useCallback(
    (id) => {
      const entry = toastTimersRef.current.get(id);
      if (!entry || entry.running || entry.remainingMs <= 0) {
        return;
      }
      const timeoutId = window.setTimeout(() => {
        removeToast(id);
      }, entry.remainingMs);
      toastTimersRef.current.set(id, {
        ...entry,
        timeoutId,
        startedAt: Date.now(),
        running: true,
      });
    },
    [removeToast],
  );

  const invalidateRepoCache = useCallback(() => {
    repoCacheRef.current = {
      userId: null,
      gitlabEnabled: true,
      fetchedAt: 0,
      repos: [],
    };
  }, []);

  const pushToast = useCallback(
    (message, type = "info", options = {}) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const persistent = type === "error";
      const durationMs =
        Number.isFinite(options.durationMs) && options.durationMs > 0
          ? options.durationMs
          : TOAST_DEFAULT_DISMISS_MS;
      const nextToast = {
        id,
        message,
        type,
        actionLabel: options.actionLabel || null,
        onAction: typeof options.onAction === "function" ? options.onAction : null,
        persistent,
        closing: false,
      };

      setToasts((prev) => {
        const next = [...prev, nextToast];
        while (next.length > 3) {
          const removed = next.shift();
          if (removed?.id) {
            clearToastTimer(removed.id);
          }
        }
        return next;
      });

      if (!persistent) {
        const timeoutId = window.setTimeout(() => {
          removeToast(id);
        }, durationMs);
        toastTimersRef.current.set(id, {
          timeoutId,
          startedAt: Date.now(),
          remainingMs: durationMs,
          running: true,
        });
      }
      return id;
    },
    [clearToastTimer, removeToast],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("authError");
    if (!authError) {
      return;
    }
    const message = authErrorMessageForCode(authError);
    if (message) {
      setAuthErrorMessage(message);
    }
    params.delete("authError");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, []);

  useEffect(() => {
    if (!authErrorMessage) {
      return;
    }
    pushToast(authErrorMessage, "error", { persistent: true });
  }, [authErrorMessage, pushToast]);

  useEffect(() => {
    return () => {
      for (const timer of toastTimersRef.current.values()) {
        clearTimeout(timer);
      }
      toastTimersRef.current.clear();
      pendingNotificationDeleteIdsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!authed) {
      stageStatusRef.current = new Map();
      stageToastRef.current.clear();
      stageStatusBootstrappedRef.current = false;
      return;
    }

    const nextMap = new Map();
    for (const deployment of deployments) {
      const stages = normalizeDeploymentStages(deployment.stages);
      const currentStatuses = {};
      for (const stageName of DEPLOYMENT_STAGES) {
        const nextStatus = stages[stageName]?.status || "pending";
        currentStatuses[stageName] = nextStatus;
      }
      nextMap.set(deployment.id, currentStatuses);
    }
    if (!deploymentsHydrated) {
      return;
    }
    if (!stageStatusBootstrappedRef.current) {
      stageStatusRef.current = nextMap;
      stageStatusBootstrappedRef.current = true;
      return;
    }

    for (const deployment of deployments) {
      const currentStatuses = nextMap.get(deployment.id) || {};
      const previous = stageStatusRef.current.get(deployment.id) || {};

      for (const stageName of DEPLOYMENT_STAGES) {
        const nextStatus = currentStatuses[stageName] || "pending";
        const previousStatus = previous[stageName] || "pending";
        if (
          previousStatus !== nextStatus &&
          (nextStatus === "succeeded" || nextStatus === "failed")
        ) {
          const dedupeKey = `${deployment.id}:${stageName}:${nextStatus}`;
          if (!stageToastRef.current.has(dedupeKey)) {
            if (stageName === "deploy" && nextStatus === "succeeded") {
              const deploymentUrl = normalizeHostedExternalUrl(deployment.endpoint);
              pushToast("Deployment live", "success", {
                durationMs: TOAST_DEPLOY_SUCCESS_DISMISS_MS,
                actionLabel: deploymentUrl ? "Open" : null,
                onAction: deploymentUrl
                  ? () => window.open(deploymentUrl, "_blank", "noopener,noreferrer")
                  : null,
              });
            } else if (nextStatus === "failed") {
              const failureHint = inferDeploymentFailureHint(deployment, stageName);
              pushToast(
                `${DEPLOYMENT_STAGE_LABELS[stageName]} failed. ${failureHint.reason} ${failureHint.hint}`,
                "error",
                {
                  persistent: true,
                },
              );
            }
            stageToastRef.current.add(dedupeKey);
          }
        }
      }
    }
    stageStatusRef.current = nextMap;
  }, [authed, deployments, deploymentsHydrated, pushToast]);

  async function loadSession() {
    const res = await apiFetch("/session");
    if (!res.ok) throw new Error(await parseError(res, "Cannot load session."));
    const data = await res.json();
    setSession(data);
    setSessionBootstrapStatus(SESSION_BOOTSTRAP_READY);
    return data;
  }

  async function loadProjects() {
    if (!authed) return;
    const res = await apiFetch("/projects");
    if (!res.ok) throw new Error(await parseError(res, "Cannot load projects."));
    const data = await res.json();
    setProjects(Array.isArray(data) ? data : []);
  }

  async function loadDeployments() {
    if (!authed) return;
    const res = await apiFetch("/deployments");
    if (!res.ok) throw new Error(await parseError(res, "Cannot load deployments."));
    const data = await res.json();
    setDeployments(Array.isArray(data) ? data : []);
    setDeploymentsHydrated(true);
  }

  async function loadDeploymentRegions() {
    if (!authed) return { public: [], private: [] };
    const res = await apiFetch("/deployment-regions");
    if (!res.ok) throw new Error(await parseError(res, "Cannot load deployment regions."));
    const data = await res.json();
    const next = {
      public: Array.isArray(data?.public) ? data.public : [],
      private: Array.isArray(data?.private) ? data.private : [],
    };
    setDeploymentRegions(next);
    return next;
  }

  async function loadGitHubInstallations() {
    if (!authed) {
      setGithubInstallations([]);
      return;
    }
    const res = await apiFetch("/github/installations");
    if (res.status === 404) {
      setGithubInstallations([]);
      return;
    }
    if (!res.ok) throw new Error(await parseError(res, "Cannot load GitHub installations."));
    const data = await res.json();
    setGithubInstallations(Array.isArray(data) ? data : []);
  }

  async function loadGitLabAccount() {
    if (!authed || session?.gitlabAuthEnabled === false) {
      setGitlabAccount(null);
      return;
    }
    const res = await apiFetch("/gitlab/account");
    if (res.status === 404 || res.status === 403) {
      setGitlabAccount({ connected: false, identity: null });
      return;
    }
    if (!res.ok) throw new Error(await parseError(res, "Cannot load GitLab account."));
    const data = await res.json();
    setGitlabAccount({
      connected: Boolean(data?.connected),
      identity: data?.identity || null,
    });
  }

  async function loadTemplates({ force = false } = {}) {
    if (!authed) {
      setTemplates([]);
      return;
    }
    if (!force && templates.length > 0) {
      return;
    }
    setLoadingTemplates(true);
    try {
      const res = await apiFetch("/templates");
      if (res.status === 404) {
        setTemplates([]);
        return;
      }
      if (!res.ok) throw new Error(await parseError(res, "Cannot load templates."));
      const data = await res.json();
      setTemplates(Array.isArray(data) ? data : []);
    } finally {
      setLoadingTemplates(false);
    }
  }

  async function loadRepos({ force = false } = {}) {
    if (!authed) {
      setRepos([]);
      invalidateRepoCache();
      return;
    }
    const currentUserId = session?.user?.id || null;
    const gitlabEnabled = session?.gitlabAuthEnabled !== false;
    const cache = repoCacheRef.current;
    const cacheFresh =
      !force &&
      cache.userId === currentUserId &&
      cache.gitlabEnabled === gitlabEnabled &&
      cache.fetchedAt > 0 &&
      Date.now() - cache.fetchedAt < REPO_CACHE_TTL_MS;
    if (cacheFresh) {
      setRepos(cache.repos);
      return;
    }
    setLoadingRepos(true);
    setLoadingGitlabRepos(true);
    try {
      const [githubRes, gitlabRes] = await Promise.all([
        apiFetch("/github/repos"),
        gitlabEnabled ? apiFetch("/gitlab/repos") : Promise.resolve(null),
      ]);

      let githubRepos = [];
      if (githubRes?.ok) {
        const data = await githubRes.json();
        githubRepos = Array.isArray(data) ? data : [];
      } else if (githubRes && githubRes.status !== 404) {
        throw new Error(await parseError(githubRes, "Cannot load GitHub repositories."));
      }

      let gitlabRepos = [];
      if (gitlabRes?.ok) {
        const data = await gitlabRes.json();
        gitlabRepos = Array.isArray(data) ? data : [];
      } else if (
        gitlabRes &&
        gitlabRes.status !== 404 &&
        gitlabRes.status !== 403 &&
        gitlabRes.status !== 409
      ) {
        throw new Error(await parseError(gitlabRes, "Cannot load GitLab repositories."));
      }

      const merged = [...githubRepos, ...gitlabRepos];
      repoCacheRef.current = {
        userId: currentUserId,
        gitlabEnabled,
        fetchedAt: Date.now(),
        repos: merged,
      };
      setRepos(merged);
    } finally {
      setLoadingRepos(false);
      setLoadingGitlabRepos(false);
    }
  }

  async function loadNotifications() {
    if (!authed) {
      setNotifications([]);
      return;
    }
    const res = await apiFetch("/notifications?limit=20");
    if (res.status === 404) {
      setNotifications([]);
      return;
    }
    if (!res.ok) throw new Error(await parseError(res, "Cannot load notifications."));
    const data = await res.json();
    const pendingDeletes = pendingNotificationDeleteIdsRef.current;
    const normalized = Array.isArray(data) ? data : [];
    setNotifications(normalized.filter((item) => !pendingDeletes.has(item.id)));
  }

  async function loadAdminStats(range = adminRange, { silent = false } = {}) {
    if (!authed || !isAdmin) {
      setAdminOverview(null);
      setAdminTimeseries(null);
      setAdminCanisters(null);
      setAdminHostCanisters(null);
      setAdminDeployedProjects(null);
      setAdminError("");
      return;
    }
    if (!silent) {
      setAdminLoading(true);
    }
    try {
      const [overviewRes, timeseriesRes, canistersRes, hostCanistersRes, deployedProjectsRes] =
        await Promise.all([
          apiFetch(`/admin/stats/overview?range=${encodeURIComponent(range)}`),
          apiFetch(`/admin/stats/timeseries?range=${encodeURIComponent(range)}`),
          apiFetch(`/admin/stats/canisters?range=${encodeURIComponent(range)}`),
          apiFetch(`/admin/host-canisters`),
          apiFetch(`/admin/projects/deployed`),
        ]);
      if (!overviewRes.ok) {
        throw new Error(await parseError(overviewRes, "Cannot load admin overview."));
      }
      if (!timeseriesRes.ok) {
        throw new Error(await parseError(timeseriesRes, "Cannot load admin timeseries."));
      }
      if (!canistersRes.ok) {
        throw new Error(await parseError(canistersRes, "Cannot load canister analytics."));
      }
      if (!hostCanistersRes.ok) {
        throw new Error(await parseError(hostCanistersRes, "Cannot load host canisters."));
      }
      if (!deployedProjectsRes.ok) {
        throw new Error(
          await parseError(deployedProjectsRes, "Cannot load deployed projects list."),
        );
      }
      const [overview, timeseries, canisters, hostCanisters, deployedProjects] = await Promise.all([
        overviewRes.json(),
        timeseriesRes.json(),
        canistersRes.json(),
        hostCanistersRes.json(),
        deployedProjectsRes.json(),
      ]);
      setAdminOverview(overview || null);
      setAdminTimeseries(timeseries || null);
      setAdminCanisters(canisters || null);
      setAdminHostCanisters(hostCanisters || null);
      setAdminDeployedProjects(deployedProjects || null);
      setAdminError("");
    } catch (error) {
      setAdminError(error.message || "Failed to load admin analytics.");
    } finally {
      setAdminLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      setSessionBootstrapStatus(SESSION_BOOTSTRAP_UNKNOWN);
      try {
        const data = await loadSession();
        if (cancelled) return;
        setLoginName(data?.user?.displayName || "");
      } catch {
        if (!cancelled) {
          setSession(createUnauthedSessionState());
          setSessionBootstrapStatus(SESSION_BOOTSTRAP_ERROR);
        }
      }
    }
    boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authed) {
      setProjects([]);
      setDeployments([]);
      setDeploymentsHydrated(false);
      setRepos([]);
      setTemplates([]);
      setGithubInstallations([]);
      setGitlabAccount(null);
      setNotifications([]);
      setDeploymentRegions({ public: [], private: [] });
      setAdminOverview(null);
      setAdminTimeseries(null);
      setAdminCanisters(null);
      setAdminHostCanisters(null);
      setAdminError("");
      setLoadingRepos(false);
      setLoadingGitlabRepos(false);
      setLoadingTemplates(false);
      invalidateRepoCache();
      return;
    }

    let cancelled = false;
    async function loadInitialData() {
      try {
        await Promise.all([loadProjects(), loadDeployments()]);
        if (cancelled) {
          return;
        }
        await Promise.allSettled([
          loadGitHubInstallations(),
          loadGitLabAccount(),
          loadNotifications(),
          loadDeploymentRegions(),
        ]);
      } catch (error) {
        if (!cancelled) {
          console.error(error);
        }
      }
    }

    loadInitialData();

    return () => {
      cancelled = true;
    };
  }, [authed, invalidateRepoCache]);

  useEffect(() => {
    if (!authed) {
      return;
    }
    let cancelled = false;
    let timer = null;

    const runCorePoll = async () => {
      try {
        await Promise.all([loadProjects(), loadDeployments()]);
      } catch (error) {
        if (!cancelled) {
          console.error(error);
        }
      }
    };

    const schedule = () => {
      if (cancelled) {
        return;
      }
      const delay = getCorePollIntervalMs();
      timer = window.setTimeout(async () => {
        await runCorePoll();
        schedule();
      }, delay);
    };

    const onVisibilityChange = () => {
      if (cancelled) {
        return;
      }
      if (timer) {
        window.clearTimeout(timer);
      }
      schedule();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [authed]);

  useEffect(() => {
    if (!authed) {
      return;
    }
    const intervalId = window.setInterval(() => {
      loadNotifications().catch((error) => console.error(error));
    }, NOTIFICATIONS_POLL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [authed]);

  useEffect(() => {
    if (!authed || !isAdmin) {
      setAdminOverview(null);
      setAdminTimeseries(null);
      setAdminCanisters(null);
      setAdminHostCanisters(null);
      setAdminError("");
      return;
    }

    let cancelled = false;
    async function load() {
      try {
        await loadAdminStats(adminRange);
      } catch (error) {
        if (!cancelled) {
          console.error(error);
        }
      }
    }

    load();
    const intervalId = setInterval(() => {
      loadAdminStats(adminRange, { silent: true }).catch((error) => {
        if (!cancelled) {
          console.error(error);
        }
      });
    }, 30000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [authed, isAdmin, adminRange]);

  async function onAuthSubmit() {
    setLoading(true);
    try {
      const res = await apiFetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginName.trim(), password }),
      });
      if (!res.ok) {
        throw new Error(await parseError(res, "Sign in failed."));
      }
      await loadSession();
      setPassword("");
      setAuthErrorMessage("");
    } catch (error) {
      pushToast(error.message || "Authentication failed.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function onCompleteOnboarding(payload) {
    setSavingOnboarding(true);
    try {
      const res = await apiFetch("/profile/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await parseError(res, "Failed to save profile."));
      }
      const body = await res.json();
      setSession((prev) => {
        if (!prev?.user) {
          return prev;
        }
        return {
          ...prev,
          user: {
            ...prev.user,
            displayName: body?.displayName || payload?.displayName || prev.user.displayName,
            onboardingRequired: false,
          },
        };
      });
      try {
        await loadSession();
      } catch (sessionError) {
        console.error(sessionError);
      }
      pushToast("Profile setup complete.", "success");
    } catch (error) {
      pushToast(error.message || "Failed to save profile.", "error");
    } finally {
      setSavingOnboarding(false);
    }
  }

  async function onLogout() {
    try {
      await apiFetch("/logout", { method: "POST" });
    } catch (error) {
      console.error(error);
    }
    setSession({
      authenticated: false,
      user: null,
      github: null,
      gitlab: null,
      githubAuthEnabled: session?.githubAuthEnabled !== false,
      gitlabAuthEnabled: session?.gitlabAuthEnabled !== false,
      githubAppEnabled: Boolean(session?.githubAppEnabled),
      localAuthEnabled: Boolean(session?.localAuthEnabled ?? true),
    });
    setProjects([]);
    setDeployments([]);
    setDeploymentsHydrated(false);
    setRepos([]);
    setTemplates([]);
    setGithubInstallations([]);
    setGitlabAccount(null);
    setNotifications([]);
    setDeploymentRegions({ public: [], private: [] });
    setAdminOverview(null);
    setAdminTimeseries(null);
    setAdminCanisters(null);
    setAdminHostCanisters(null);
    setAdminDeployedProjects(null);
    setAdminError("");
    setLoadingRepos(false);
    setLoadingGitlabRepos(false);
    setLoadingTemplates(false);
    invalidateRepoCache();
  }

  async function onCreateProject(payload) {
    if (!payload.projectName) throw new Error("Project slug is required.");

    setBusyProjectId("__creating__");
    try {
      let repoConnected = false;
      const createRes = await apiFetch("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: payload.projectName,
          region: payload.region || "global",
          routingVisibility: payload.routingVisibility || "public",
          envVars: Array.isArray(payload.envVars) ? payload.envVars : [],
        }),
      });
      if (!createRes.ok) throw new Error(await parseError(createRes, "Failed to create project."));

      const project = await createRes.json();

      if (payload.repo) {
        const provider =
          String(payload.provider || "github").toLowerCase() === "gitlab" ? "gitlab" : "github";
        const connectPath = provider === "gitlab" ? "/gitlab/connect" : "/github/connect";
        const connectPayload = {
          projectId: project.id,
          repo: payload.repo,
          repoId: payload.repoId,
          branch: payload.branch || "main",
          ...payload.settings,
        };
        if (provider === "github") {
          connectPayload.installationId = payload.installationId;
        }
        const connectRes = await apiFetch(connectPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(connectPayload),
        });
        if (!connectRes.ok)
          throw new Error(await parseError(connectRes, "Failed to connect repository."));
        if (provider === "gitlab") {
          const connectedBody = await connectRes.json().catch(() => null);
          if (connectedBody?.gitlabWebhookSetup?.mode === "manual") {
            pushToast("Set GitLab webhook token.", "info", { persistent: true });
          }
        }
        repoConnected = true;
      }

      await Promise.all([loadProjects(), loadDeployments()]);
      if (repoConnected) {
        invalidateRepoCache();
        pushToast("Repo connected", "success", { persistent: true });
      } else {
        pushToast("Project created", "success");
      }
    } finally {
      setBusyProjectId("");
    }
  }

  async function onStartCheckout(interval) {
    const res = await apiFetch("/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interval }),
    });
    if (!res.ok) {
      throw new Error(await parseError(res, "Unable to start checkout."));
    }
    const data = await res.json();
    if (!data?.url) {
      throw new Error("Checkout URL was not returned.");
    }
    window.location.href = data.url;
  }

  async function onManageBilling() {
    const res = await apiFetch("/billing/portal", { method: "POST" });
    if (!res.ok) {
      throw new Error(await parseError(res, "Unable to open billing portal."));
    }
    const data = await res.json();
    if (!data?.url) {
      throw new Error("Billing portal URL was not returned.");
    }
    window.location.href = data.url;
  }

  async function onProvisionTemplate(payload) {
    const res = await apiFetch("/templates/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(body?.error || "Couldn't provision template.");
      if (body?.nextAction) {
        error.nextAction = body.nextAction;
      }
      if (body?.requiresUserRepoCreation) {
        error.requiresUserRepoCreation = true;
      }
      throw error;
    }
    const project = body && Object.keys(body).length ? body : null;
    await Promise.all([
      loadProjects(),
      loadDeployments(),
      loadGitHubInstallations(),
      loadGitLabAccount(),
      loadTemplates({ force: true }),
    ]);
    invalidateRepoCache();
    try {
      await loadRepos({ force: true });
    } catch (error) {
      console.error(error);
    }
    pushToast("Project created, first deploy queued.", "success", {
      persistent: true,
    });
    if (project?.gitlabWebhookSetup?.mode === "manual") {
      pushToast("Set GitLab webhook token.", "info", { persistent: true });
    }
    return project;
  }

  async function onRedeploy(projectId) {
    setBusyProjectId(projectId);
    try {
      const res = await apiFetch(`/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(await parseError(res, "Failed to trigger deploy."));
      await Promise.all([loadProjects(), loadDeployments()]);
      pushToast("Deployment queued.", "success");
    } catch (error) {
      pushToast(error.message || "Failed to trigger deployment.", "error");
    } finally {
      setBusyProjectId("");
    }
  }

  async function onSaveAvatar(avatarUrl) {
    const res = await apiFetch("/profile/avatar", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarUrl }),
    });
    if (!res.ok) throw new Error(await parseError(res, "Unable to update avatar."));
    await loadSession();
  }

  async function onResetPassword(payload) {
    const res = await apiFetch("/profile/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(await parseError(res, "Unable to update password."));
    }
  }

  async function onOpenNotifications() {
    try {
      if (unreadNotifications > 0) {
        const previous = notifications;
        const now = Date.now();
        setNotifications((prev) =>
          prev.map((item) => (item.readAt ? item : { ...item, readAt: now })),
        );
        const res = await apiFetch("/notifications/read-all", { method: "POST" });
        if (!res.ok) {
          setNotifications(previous);
          throw new Error(await parseError(res, "Couldn't update notifications."));
        }
      }
    } catch (error) {
      pushToast(error.message || "Couldn't update notifications.", "error");
    }
  }

  async function onReadNotification(id) {
    try {
      const previous = notifications;
      const now = Date.now();
      setNotifications((prev) =>
        prev.map((item) => (item.id === id ? { ...item, readAt: item.readAt || now } : item)),
      );
      const res = await apiFetch(`/notifications/${id}/read`, { method: "POST" });
      if (!res.ok) {
        setNotifications(previous);
        throw new Error(await parseError(res, "Couldn't update notification."));
      }
    } catch (error) {
      pushToast(error.message || "Couldn't update notification.", "error");
    }
  }

  async function onDeleteNotification(id) {
    const existing = notifications.find((item) => item.id === id);
    if (!existing) {
      return;
    }
    if (pendingNotificationDeleteIdsRef.current.has(id)) {
      return;
    }
    const index = notifications.findIndex((item) => item.id === id);
    setNotifications((prev) => prev.filter((item) => item.id !== id));
    pendingNotificationDeleteIdsRef.current.add(id);

    const restore = () => {
      pendingNotificationDeleteIdsRef.current.delete(id);
      setNotifications((prev) => {
        if (prev.some((item) => item.id === id)) {
          return prev;
        }
        const next = [...prev];
        const insertAt = index >= 0 && index <= next.length ? index : next.length;
        next.splice(insertAt, 0, existing);
        return next;
      });
    };
    try {
      const res = await apiFetch(`/notifications/${id}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error(await parseError(res, "Couldn't delete notification."));
      }
      pendingNotificationDeleteIdsRef.current.delete(id);
    } catch (error) {
      restore();
      pushToast(error.message || "Couldn't delete notification.", "error");
    }
  }

  async function onDisconnectGitHubInstallation(installationId) {
    const previousInstallations = githubInstallations;
    const previousProjects = projects;
    setGithubInstallations((prev) =>
      prev.filter((item) => Number(item.installationId) !== Number(installationId)),
    );
    setProjects((prev) =>
      prev.map((project) => {
        if (Number(project.github?.installationId) !== Number(installationId)) {
          return project;
        }
        return {
          ...project,
          repoUrl: null,
          github: null,
        };
      }),
    );
    try {
      const res = await apiFetch(`/github/installations/${encodeURIComponent(installationId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(await parseError(res, "Couldn't disconnect installation."));
      }
      await Promise.all([
        loadSession(),
        loadGitHubInstallations(),
        loadGitLabAccount(),
        loadProjects(),
      ]);
      invalidateRepoCache();
      pushToast("Disconnected", "success");
    } catch (error) {
      setGithubInstallations(previousInstallations);
      setProjects(previousProjects);
      pushToast(error.message || "Couldn't disconnect installation.", "error");
    }
  }

  async function onDisconnectGitLabAccount() {
    const previousAccount = gitlabAccount;
    const previousProjects = projects;
    const previousRepos = repos;
    setGitlabAccount({ connected: false, identity: null });
    setProjects((prev) =>
      prev.map((project) => {
        if (String(project?.gitProvider || "").toLowerCase() !== "gitlab") {
          return project;
        }
        return {
          ...project,
          repoUrl: null,
          gitProvider: "github",
          gitlab: null,
        };
      }),
    );
    setRepos((prev) =>
      prev.filter((repo) => String(repo?.provider || "github").toLowerCase() !== "gitlab"),
    );
    try {
      const res = await apiFetch("/gitlab/account", { method: "DELETE" });
      if (!res.ok) {
        throw new Error(await parseError(res, "Couldn't disconnect GitLab."));
      }
      await Promise.all([loadSession(), loadProjects(), loadGitLabAccount()]);
      invalidateRepoCache();
      pushToast("Disconnected", "success");
    } catch (error) {
      setGitlabAccount(previousAccount);
      setProjects(previousProjects);
      setRepos(previousRepos);
      pushToast(error.message || "Couldn't disconnect GitLab.", "error");
    }
  }

  function onConnectGitHubApp() {
    window.location.href = `${API_BASE}/github/app/install`;
  }

  function onConnectGitLab() {
    window.location.href = `${API_BASE}/auth/gitlab/link`;
  }

  async function onCreateHostCanister(payload) {
    const res = await apiFetch("/admin/host-canisters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(await parseError(res, "Cannot create host canister."));
    }
    pushToast("Host canister added.", "success");
    await loadAdminStats(adminRange, { silent: true });
  }

  async function onUpdateHostCanister(id, payload) {
    const res = await apiFetch(`/admin/host-canisters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(await parseError(res, "Cannot update host canister."));
    }
    pushToast("Host canister updated.", "success");
    await loadAdminStats(adminRange, { silent: true });
  }

  async function onProjectDeleted() {
    await Promise.all([loadProjects(), loadDeployments(), loadNotifications()]);
    if (isAdmin) {
      await loadAdminStats(adminRange, { silent: true });
    }
  }

  async function onProjectUpdated() {
    await Promise.all([loadProjects(), loadDeployments()]);
    if (isAdmin) {
      await loadAdminStats(adminRange, { silent: true });
    }
  }

  if (!authed) {
    return (
      <>
        <AuthCard
          loginName={loginName}
          password={password}
          setLoginName={setLoginName}
          setPassword={setPassword}
          onSubmit={onAuthSubmit}
          loading={loading}
          localAuthEnabled={Boolean(session?.localAuthEnabled ?? true)}
          githubAuthEnabled={session?.githubAuthEnabled !== false}
          gitlabAuthEnabled={session?.gitlabAuthEnabled !== false}
          authError={authErrorMessage}
          onGithubLogin={() => {
            window.location.href = `${API_BASE}/auth/github/login`;
          }}
          onGitlabLogin={() => {
            window.location.href = `${API_BASE}/auth/gitlab/login`;
          }}
        />
        {sessionBootstrapStatus === SESSION_BOOTSTRAP_UNKNOWN ? (
          <p className="muted auth-bootstrap-note">Checking session…</p>
        ) : null}
        <Toasts
          items={toasts}
          onClose={removeToast}
          onPause={pauseToastTimer}
          onResume={resumeToastTimer}
        />
      </>
    );
  }

  if (onboardingRequired) {
    return (
      <>
        <OnboardingCard
          session={session}
          loading={savingOnboarding}
          onSubmit={onCompleteOnboarding}
        />
        <Toasts
          items={toasts}
          onClose={removeToast}
          onPause={pauseToastTimer}
          onResume={resumeToastTimer}
        />
      </>
    );
  }

  return (
    <>
      <Dashboard
        session={session}
        onLogout={onLogout}
        projects={projects}
        deployments={deployments}
        repos={repos}
        templates={templates}
        githubInstallations={githubInstallations}
        gitlabAccount={gitlabAccount}
        loadingRepos={loadingRepos}
        loadingGitlabRepos={loadingGitlabRepos}
        loadingTemplates={loadingTemplates}
        onReloadRepos={() => loadRepos({ force: true })}
        onReloadGitlabRepos={() => loadRepos({ force: true })}
        onEnsureRepos={loadRepos}
        onEnsureTemplates={() => loadTemplates({ force: false })}
        onReloadTemplates={() => loadTemplates({ force: true })}
        onProvisionTemplate={onProvisionTemplate}
        onConnectGitHubApp={onConnectGitHubApp}
        onConnectGitLab={onConnectGitLab}
        onDisconnectGitHubInstallation={onDisconnectGitHubInstallation}
        onDisconnectGitLabAccount={onDisconnectGitLabAccount}
        onCreateProject={onCreateProject}
        deploymentRegions={deploymentRegions}
        onReloadDeploymentRegions={loadDeploymentRegions}
        onStartCheckout={onStartCheckout}
        onManageBilling={onManageBilling}
        onRedeploy={onRedeploy}
        onSaveAvatar={onSaveAvatar}
        onResetPassword={onResetPassword}
        busyProjectId={busyProjectId}
        notifications={notifications}
        unreadNotifications={unreadNotifications}
        onOpenNotifications={onOpenNotifications}
        onReadNotification={onReadNotification}
        onDeleteNotification={onDeleteNotification}
        onToast={pushToast}
        adminRange={adminRange}
        onAdminRangeChange={setAdminRange}
        adminOverview={adminOverview}
        adminTimeseries={adminTimeseries}
        adminCanisters={adminCanisters}
        adminHostCanisters={adminHostCanisters}
        adminDeployedProjects={adminDeployedProjects}
        adminLoading={adminLoading}
        adminError={adminError}
        onRefreshAdminStats={() => loadAdminStats(adminRange)}
        onCreateHostCanister={onCreateHostCanister}
        onUpdateHostCanister={onUpdateHostCanister}
        onProjectDeleted={onProjectDeleted}
        onProjectUpdated={onProjectUpdated}
      />
      <Toasts
        items={toasts}
        onClose={removeToast}
        onPause={pauseToastTimer}
        onResume={resumeToastTimer}
      />
    </>
  );
}

export default App;
