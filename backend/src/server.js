import "dotenv/config";
import express from "express";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  randomUUID,
  randomBytes,
  createHmac,
  timingSafeEqual,
  createHash,
  createPrivateKey,
  sign as signData,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import https from "node:https";
import { setTimeout as wait } from "node:timers/promises";
import cookie from "cookie";
import pino from "pino";
import argon2 from "argon2";
import Stripe from "stripe";
import { createDb } from "./db.js";
import {
  createApiRoutes,
  validateRequest,
  apiErrorHandler,
  HttpError,
  positiveId,
} from "./security/http-safety.js";
import { verifyUserInstallation, userInstallationRepositories } from "./security/github-access.js";
import runnerEnv from "./security/runner-env.cjs";
const { isSafeCustomerEnvKey, validateCustomerEnv } = runnerEnv;
import {
  decryptSecret as decryptEnvVarSecret,
  encryptSecret as encryptEnvVarSecret,
  getEnvVarsKmsKeyName,
  isEnvVarsKmsConfigured,
} from "./secrets/kms.js";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { singleLine: true, colorize: true },
        },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const k8sNamespace =
  process.env.WORKSPACE_NAMESPACE || process.env.POD_NAMESPACE || "workspace-alpha";
const useJobRunner = (process.env.DEPLOY_MODE || "").toLowerCase() === "job";
const runnerJobImage = process.env.DEPLOY_JOB_IMAGE || "a3-backend:local";
const runnerImagePullSecret = process.env.DEPLOY_IMAGE_PULL_SECRET ?? "";
const runnerBuildServiceAccount =
  process.env.DEPLOY_BUILD_SERVICE_ACCOUNT || "workspace-alpha-build-runner";
const runnerDeployServiceAccount =
  process.env.DEPLOY_DEPLOY_SERVICE_ACCOUNT || "workspace-alpha-deploy-runner";
const DEPLOYMENT_STAGE_ORDER = Object.freeze(["build", "deploy"]);
const DEPLOYMENT_STAGE_TERMINAL = new Set(["succeeded", "failed"]);
const DEFAULT_BUILD_CONFIG = Object.freeze({
  framework: "auto",
  rootDir: null,
  installCommand: null,
  buildCommand: null,
  outputDir: null,
});
const TEMPLATE_BUILD_DEFAULTS = Object.freeze({
  static: Object.freeze({ framework: "static" }),
  react: Object.freeze({ framework: "vite" }),
  nextjs: Object.freeze({ framework: "nextjs" }),
});
const TEMPLATE_CATALOG = Object.freeze([
  Object.freeze({
    id: "a3-static-template-external-api",
    name: "A3 Static Template External API",
    providerSource: "https://github.com/BorisStoyanv/A3-template-static",
    providerSourceGitUrl: "https://github.com/BorisStoyanv/A3-template-static.git",
    defaultBuildConfig: TEMPLATE_BUILD_DEFAULTS.static,
  }),
  Object.freeze({
    id: "a3-react-template",
    name: "A3 React Template",
    providerSource: "https://github.com/BorisStoyanv/A3-template-react",
    providerSourceGitUrl: "https://github.com/BorisStoyanv/A3-template-react.git",
    defaultBuildConfig: TEMPLATE_BUILD_DEFAULTS.react,
  }),
  Object.freeze({
    id: "a3-nextjs-template",
    name: "A3 Next.js Template",
    providerSource: "https://github.com/BorisStoyanv/A3-template-nextjs",
    providerSourceGitUrl: "https://github.com/BorisStoyanv/A3-template-nextjs.git",
    defaultBuildConfig: TEMPLATE_BUILD_DEFAULTS.nextjs,
  }),
]);
const TEMPLATE_REPO_NAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,98}[a-zA-Z0-9])?$/;
const TEMPLATE_GITLAB_IMPORT_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.TEMPLATE_GITLAB_IMPORT_TIMEOUT_MS,
  2 * 60 * 1000,
);
const TEMPLATE_GITLAB_IMPORT_POLL_MS = parsePositiveIntEnv(
  process.env.TEMPLATE_GITLAB_IMPORT_POLL_MS,
  2000,
);
const ALLOWED_BUILD_FRAMEWORKS = new Set([
  "auto",
  "static",
  "nextjs",
  "cra",
  "vite",
  "nuxt",
  "sveltekit",
]);
const MAX_BUILD_PATH_LEN = 255;
const MAX_BUILD_COMMAND_LEN = 240;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const MAX_ENV_VARS_PER_PROJECT = 100;
const MAX_ENV_VALUE_LEN = 8192;

const FREE_PROJECT_LIMIT = 3;
const PRO_PROJECT_LIMIT = 50;

const SLUG_MAX_LEN = 63;
const ANALYTICS_RANGE_SPECS = Object.freeze({
  "24h": {
    durationMs: 24 * 60 * 60 * 1000,
    bucketInterval: "1 hour",
    bucketUnit: "hour",
  },
  "7d": {
    durationMs: 7 * 24 * 60 * 60 * 1000,
    bucketInterval: "1 day",
    bucketUnit: "day",
  },
  "30d": {
    durationMs: 30 * 24 * 60 * 60 * 1000,
    bucketInterval: "1 day",
    bucketUnit: "day",
  },
  "90d": {
    durationMs: 90 * 24 * 60 * 60 * 1000,
    bucketInterval: "1 day",
    bucketUnit: "day",
  },
});
const DEFAULT_ANALYTICS_RANGE = "7d";
const ADMIN_FAILURE_INSIGHT_SAMPLE_LIMIT = parsePositiveIntEnv(
  "ADMIN_FAILURE_INSIGHT_SAMPLE_LIMIT",
  250,
);
const RUNNER_LOG_STAGE_PREFIX_PATTERN = /^\s*\[(build|deploy)\]\s*/i;
// eslint-disable-next-line no-control-regex -- Strip ANSI terminal escapes from deployment logs.
const RUNNER_LOG_ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const DEPLOY_FAILURE_INSIGHT_RULES = Object.freeze([
  Object.freeze({
    id: "branch_missing",
    title: "Branch not found",
    hint: "Project branch is invalid. Update branch in Project Settings and redeploy.",
    pattern: /remote branch .* not found|couldn't find remote ref|pathspec .* did not match/i,
  }),
  Object.freeze({
    id: "repo_access",
    title: "Repository access denied",
    hint: "Reconnect provider and confirm repo access for the linked account.",
    pattern:
      /repository .* not found|resource not accessible by integration|not accessible through this installation|authentication failed|access denied/i,
  }),
  Object.freeze({
    id: "missing_build_command",
    title: "Missing build command",
    hint: "Set a valid Build Command in Project Settings, then redeploy.",
    pattern: /no "build" script defined|missing script:\s*build/i,
  }),
  Object.freeze({
    id: "missing_output_dir",
    title: "Output directory missing",
    hint: "Set the correct Output Directory in Project Settings (for example dist or build).",
    pattern:
      /unable to detect static assets|assets directory .* does not exist|output directory .* does not exist|build output .* not found/i,
  }),
  Object.freeze({
    id: "runner_startup",
    title: "Runner startup issue",
    hint: "Retry deployment. If repeated, check cluster capacity and node health.",
    pattern:
      /containercreating|container .* is waiting to start|unable to retrieve container logs|imagepullbackoff|errimagepull/i,
  }),
  Object.freeze({
    id: "timeout",
    title: "Deployment timeout",
    hint: "Build exceeded runtime limit. Reduce build/runtime workload and redeploy.",
    pattern: /timed out|deadline exceeded|activeDeadlineSeconds|context deadline exceeded/i,
  }),
  Object.freeze({
    id: "memory_limit",
    title: "Memory limit reached",
    hint: "Build process used too much memory. Optimize dependencies and build steps.",
    pattern: /exit(?:ed)? code 137|oomkilled|out of memory|killed process/i,
  }),
  Object.freeze({
    id: "dependency_or_script",
    title: "Dependency or script failure",
    hint: "Dependency install/build command failed. Verify lockfile and scripts.",
    pattern: /npm err!|pnpm .*err|yarn error/i,
  }),
]);
const HOST_CANISTER_ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_CANISTER_ID_PATTERN = /^[a-z0-9-]{5,128}$/;
const HOST_CANISTER_REGION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,31}[a-z0-9])?$/;
const HOST_CANISTER_STATUSES = new Set(["active", "draining", "full"]);
const HOST_CANISTER_VISIBILITIES = new Set(["public", "private"]);
const ACTIVE_PRO_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATE_LIMIT_ERROR_MESSAGE = "Too many requests. Please retry shortly.";
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const ACTIVE_DEPLOYMENT_STATUSES = Object.freeze(["queued", "processing"]);
const DEPLOY_MAX_ACTIVE_DEPLOYMENTS = parsePositiveIntEnv("DEPLOY_MAX_ACTIVE_DEPLOYMENTS", 3);

const DEPLOY_BUILD_ACTIVE_DEADLINE_SECONDS = parsePositiveIntEnv(
  "DEPLOY_BUILD_ACTIVE_DEADLINE_SECONDS",
  900,
);
const DEPLOY_DEPLOY_ACTIVE_DEADLINE_SECONDS = parsePositiveIntEnv(
  "DEPLOY_DEPLOY_ACTIVE_DEADLINE_SECONDS",
  600,
);
const DEPLOY_RUNNER_REQUEST_CPU = readEnvOrDefault("DEPLOY_RUNNER_REQUEST_CPU", "250m");
const DEPLOY_RUNNER_REQUEST_MEMORY = readEnvOrDefault("DEPLOY_RUNNER_REQUEST_MEMORY", "384Mi");
const DEPLOY_RUNNER_REQUEST_EPHEMERAL_STORAGE = readEnvOrDefault(
  "DEPLOY_RUNNER_REQUEST_EPHEMERAL_STORAGE",
  "512Mi",
);
const DEPLOY_RUNNER_LIMIT_CPU = readEnvOrDefault("DEPLOY_RUNNER_LIMIT_CPU", "1000m");
const DEPLOY_RUNNER_LIMIT_MEMORY = readEnvOrDefault("DEPLOY_RUNNER_LIMIT_MEMORY", "1024Mi");
const DEPLOY_RUNNER_LIMIT_EPHEMERAL_STORAGE = readEnvOrDefault(
  "DEPLOY_RUNNER_LIMIT_EPHEMERAL_STORAGE",
  "2Gi",
);
const DEPLOY_RUNNER_TMP_SIZE_LIMIT = readEnvOrDefault("DEPLOY_RUNNER_TMP_SIZE_LIMIT", "512Mi");
const DEPLOY_RUNNER_HOME_SIZE_LIMIT = readEnvOrDefault("DEPLOY_RUNNER_HOME_SIZE_LIMIT", "512Mi");
const DEPLOY_MAX_ARTIFACT_MB = parsePositiveIntEnv("DEPLOY_MAX_ARTIFACT_MB", 256);
const DEPLOY_MAX_WORKSPACE_MB = parsePositiveIntEnv(
  "DEPLOY_MAX_WORKSPACE_MB",
  DEPLOY_MAX_ARTIFACT_MB * 4,
);
const DEPLOY_WORKSPACE_STALE_MAX_AGE_MS = parsePositiveIntEnv(
  "DEPLOY_WORKSPACE_STALE_MAX_AGE_MS",
  6 * 60 * 60 * 1000,
);
const DEPLOY_WORKSPACE_CLEANUP_INTERVAL_MS = parsePositiveIntEnv(
  "DEPLOY_WORKSPACE_CLEANUP_INTERVAL_MS",
  10 * 60 * 1000,
);
const DEPLOY_QUEUE_POLL_INTERVAL_MS = parsePositiveIntEnv("DEPLOY_QUEUE_POLL_INTERVAL_MS", 3000);
const DEPLOY_RUNNER_COLOCATE_WITH_BACKEND =
  readEnvOrDefault("DEPLOY_RUNNER_COLOCATE_WITH_BACKEND", "true").toLowerCase() !== "false";
const DEPLOY_BACKEND_POD_LABEL_KEY = readEnvOrDefault("DEPLOY_BACKEND_POD_LABEL_KEY", "app");
const DEPLOY_BACKEND_POD_LABEL_VALUE = readEnvOrDefault(
  "DEPLOY_BACKEND_POD_LABEL_VALUE",
  "icp-backend",
);
const DEPLOY_RUNNER_COLOCATION_TOPOLOGY_KEY = readEnvOrDefault(
  "DEPLOY_RUNNER_COLOCATION_TOPOLOGY_KEY",
  "kubernetes.io/hostname",
);
const DEPLOY_PROCESSING_TIMEOUT_FLOOR_MS =
  (DEPLOY_BUILD_ACTIVE_DEADLINE_SECONDS + DEPLOY_DEPLOY_ACTIVE_DEADLINE_SECONDS + 120) * 1000;
const DEPLOY_PROCESSING_TIMEOUT_CONFIGURED_MS = parsePositiveIntEnv(
  "DEPLOY_PROCESSING_TIMEOUT_MS",
  DEPLOY_PROCESSING_TIMEOUT_FLOOR_MS,
);
const DEPLOY_PROCESSING_TIMEOUT_MS = Math.max(
  DEPLOY_PROCESSING_TIMEOUT_CONFIGURED_MS,
  DEPLOY_PROCESSING_TIMEOUT_FLOOR_MS,
);
const DEPLOY_TICKET_VERSION = "v1";
const RATE_LIMIT_RULES = Object.freeze({
  loginPerIpEmail: Object.freeze({ limit: 10, windowMs: 60 * 1000 }),
  loginPerIp: Object.freeze({ limit: 60, windowMs: 60 * 1000 }),
  deployPerUserMinute: Object.freeze({ limit: 6, windowMs: 60 * 1000 }),
  deployPerUserDay: Object.freeze({ limit: 80, windowMs: 24 * 60 * 60 * 1000 }),
  deployPerProjectMinute: Object.freeze({ limit: 6, windowMs: 60 * 1000 }),
  webhookPerIpMinute: Object.freeze({ limit: 120, windowMs: 60 * 1000 }),
  webhookPerProjectMinute: Object.freeze({ limit: 40, windowMs: 60 * 1000 }),
});
const GITHUB_REPO_FULL_NAME_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const GITLAB_REPO_PATH_PATTERN = /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/;

const GITHUB_APP_JWT_TTL_SECONDS = 9 * 60;
const GITHUB_APP_STATE_TTL_MS = 10 * 60 * 1000;
const GITHUB_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GITLAB_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const SESSION_COOKIE = "icp_session";
const CSRF_COOKIE = "icp_csrf";
const CSRF_HEADER = "x-csrf-token";
const CSRF_EXEMPT_PATHS = new Set(["/github/webhook", "/gitlab/webhook", "/webhooks/stripe"]);
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SESSION_TOUCH_MS = 1000 * 60 * 5;
const SESSION_ADMIN_REFRESH_MS = parsePositiveIntEnv("SESSION_ADMIN_REFRESH_MS", 15 * 60 * 1000);
const LOCAL_AUTH_ENABLED = (process.env.LOCAL_AUTH_ENABLED ?? "true").toLowerCase() !== "false";
const EJECT_ENABLED = (process.env.EJECT_ENABLED ?? "false").toLowerCase() === "true";
const SESSION_COOKIE_SECURE = (process.env.SESSION_COOKIE_SECURE ?? "").toLowerCase() === "true";
const SESSION_COOKIE_DOMAIN_RAW = (process.env.SESSION_COOKIE_DOMAIN ?? "").trim();
const SESSION_COOKIE_DOMAIN = resolveSessionCookieDomain({
  rawDomain: SESSION_COOKIE_DOMAIN_RAW,
  isProduction: process.env.NODE_ENV === "production",
});
const CSRF_COOKIE_DOMAIN = resolveCsrfCookieDomain(process.env.CSRF_COOKIE_DOMAIN);
const SESSION_COOKIE_SAMESITE = (() => {
  const raw = (process.env.SESSION_COOKIE_SAMESITE ?? "lax").toLowerCase();
  if (raw === "lax" || raw === "strict" || raw === "none") return raw;
  return "lax";
})();
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS || "");

const defaultIdentity = resolveIdentity();
const githubAppId = (process.env.GITHUB_APP_ID || "").trim();
const githubAppSlug = (process.env.GITHUB_APP_SLUG || "").trim();
const githubAppClientId = (process.env.GITHUB_APP_CLIENT_ID || "").trim();
const githubAppClientSecret = (process.env.GITHUB_APP_CLIENT_SECRET || "").trim();
const githubAppWebhookSecret = (process.env.GITHUB_APP_WEBHOOK_SECRET || "").trim();
const githubAppPrivateKey = loadGitHubAppPrivateKey(process.env.GITHUB_APP_PRIVATE_KEY_PEM);
const githubAppStateSecret = (process.env.GITHUB_APP_STATE_SECRET || githubAppClientSecret).trim();
const gitlabEnabled = (process.env.GITLAB_ENABLED ?? "false").toLowerCase() === "true";
const gitlabClientId = (process.env.GITLAB_CLIENT_ID || "").trim();
const gitlabClientSecret = (process.env.GITLAB_CLIENT_SECRET || "").trim();
const gitlabStateSecret = (process.env.GITLAB_OAUTH_STATE_SECRET || gitlabClientSecret).trim();
const gitlabBaseUrl = normalizeGitLabBaseUrl(process.env.GITLAB_BASE_URL || "https://gitlab.com");
const gitlabBetaAllowlist = parseEmailAllowlist(process.env.GITLAB_BETA_ALLOWLIST || "");
const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
const stripeWebhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
const stripeProPriceIds = Object.freeze({
  monthly: (process.env.STRIPE_PRO_MONTHLY_PRICE_ID || "").trim(),
  yearly: (process.env.STRIPE_PRO_YEARLY_PRICE_ID || "").trim(),
});
const appPublicUrl = normalizeOriginValue(process.env.APP_PUBLIC_URL || "");
const stripeClient = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const deployTicketEnabled = (process.env.DEPLOY_TICKET_ENABLED ?? "true").toLowerCase() !== "false";
const deployTicketGuardrailStrict =
  (process.env.DEPLOY_TICKET_GUARDRAIL_STRICT ?? "false").toLowerCase() === "true";
const deployTicketKeyIdRaw = (process.env.DEPLOY_TICKET_KEY_ID ?? "").trim();
const deployTicketTtlMs = Math.max(
  60_000,
  Number.parseInt(process.env.DEPLOY_TICKET_TTL_MS ?? "600000", 10) || 600_000,
);
const deployTicketPrivateKey = loadDeployTicketPrivateKey(
  process.env.DEPLOY_TICKET_PRIVATE_KEY_PEM,
);

let pool;
let lastRateLimitCleanupAt = 0;
let runnerWorkspaceCleanupTimer = null;
let deploymentQueueTimer = null;
let deploymentQueueCycleRunning = false;
const app = express();

if (process.argv[1] && resolvePath(process.argv[1]) === __filename) {
  configure().catch((err) => {
    logger.error({ errorType: err?.name }, "Failed to start backend");
    process.exitCode = 1;
  });
}

export async function configure({ database = null, listen = true } = {}) {
  pool = database || (await createDb(logger));
  const routes = createApiRoutes(app);
  if (process.env.NODE_ENV === "production" && ALLOWED_ORIGINS.size === 0) {
    throw new Error(
      "ALLOWED_ORIGINS is required in production and must include your control-plane origin(s).",
    );
  }
  if (process.env.NODE_ENV === "production" && SESSION_COOKIE_DOMAIN_RAW) {
    logger.warn(
      { configuredCookieDomain: SESSION_COOKIE_DOMAIN_RAW },
      "SESSION_COOKIE_DOMAIN is ignored in production. Using host-only session cookies.",
    );
  }
  if (process.env.NODE_ENV === "production" && !CSRF_COOKIE_DOMAIN) {
    logger.warn(
      "CSRF_COOKIE_DOMAIN is not set. Cross-subdomain control plane UIs may fail CSRF checks because icp_csrf cannot be read outside the API host.",
    );
  }
  if (!EJECT_ENABLED) {
    logger.info("Eject API is disabled by EJECT_ENABLED=false.");
  }
  if (!stripeClient) {
    logger.warn(
      "Stripe billing is not configured. Set STRIPE_SECRET_KEY to enable A3 Pro checkout.",
    );
  } else if (!stripeWebhookSecret) {
    logger.warn("STRIPE_WEBHOOK_SECRET is not configured. Stripe webhooks will be rejected.");
  }
  if (!stripeProPriceIds.monthly || !stripeProPriceIds.yearly) {
    logger.warn(
      "A3 Pro billing requires STRIPE_PRO_MONTHLY_PRICE_ID and STRIPE_PRO_YEARLY_PRICE_ID.",
    );
  }
  if (deployTicketEnabled && (!deployTicketKeyIdRaw || !deployTicketPrivateKey)) {
    logger.warn(
      "Deploy ticket signing is enabled but key config is incomplete. Hosted deploy jobs will fail until DEPLOY_TICKET_KEY_ID and DEPLOY_TICKET_PRIVATE_KEY_PEM are configured.",
    );
  }
  if (deployTicketEnabled && !deployTicketGuardrailStrict) {
    logger.warn(
      "DEPLOY_TICKET_GUARDRAIL_STRICT is disabled. Hosted deploy preflight failures will be logged but will not block deploy starts.",
    );
  }
  if (!isGitHubAppConfigured()) {
    logger.warn(
      "GitHub App is not fully configured. Repo integration endpoints will return configuration errors until GITHUB_APP_* env vars are set.",
    );
  }
  const githubAuthConfigSummary = getGitHubAuthConfigSummary();
  if (
    !githubAuthConfigSummary.hasClientId ||
    !githubAuthConfigSummary.hasAppId ||
    !githubAuthConfigSummary.hasAppSlug
  ) {
    logger.warn(
      { githubAuthConfigSummary },
      "GitHub OAuth/App identifiers are missing or inconsistent. Verify GITHUB_APP_CLIENT_ID, GITHUB_APP_ID, and GITHUB_APP_SLUG.",
    );
  }
  if (gitlabEnabled && !isGitLabAuthConfigured()) {
    logger.warn(
      "GitLab OAuth is enabled but not fully configured. Set GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET.",
    );
  }
  if (gitlabEnabled && !isGitLabHostScopeSupported()) {
    logger.warn(
      { gitlabBaseUrl },
      "GitLab integration is launch-scoped to gitlab.com. Unsupported host configured; runtime will reject GitLab routes.",
    );
  }
  if (useJobRunner) {
    if (DEPLOY_PROCESSING_TIMEOUT_CONFIGURED_MS < DEPLOY_PROCESSING_TIMEOUT_FLOOR_MS) {
      logger.warn(
        {
          configuredProcessingTimeoutMs: DEPLOY_PROCESSING_TIMEOUT_CONFIGURED_MS,
          minimumProcessingTimeoutMs: DEPLOY_PROCESSING_TIMEOUT_FLOOR_MS,
          effectiveProcessingTimeoutMs: DEPLOY_PROCESSING_TIMEOUT_MS,
        },
        "DEPLOY_PROCESSING_TIMEOUT_MS is below build+deploy stage minimum. Using minimum floor.",
      );
    }
    logger.info(
      {
        deployMaxActive: DEPLOY_MAX_ACTIVE_DEPLOYMENTS,
        buildDeadlineSeconds: DEPLOY_BUILD_ACTIVE_DEADLINE_SECONDS,
        deployDeadlineSeconds: DEPLOY_DEPLOY_ACTIVE_DEADLINE_SECONDS,
        maxArtifactMb: DEPLOY_MAX_ARTIFACT_MB,
        maxWorkspaceMb: DEPLOY_MAX_WORKSPACE_MB,
        queuePollIntervalMs: DEPLOY_QUEUE_POLL_INTERVAL_MS,
        runnerColocateWithBackend: DEPLOY_RUNNER_COLOCATE_WITH_BACKEND,
        runnerColocationLabelKey: DEPLOY_BACKEND_POD_LABEL_KEY,
        runnerColocationLabelValue: DEPLOY_BACKEND_POD_LABEL_VALUE,
        runnerColocationTopologyKey: DEPLOY_RUNNER_COLOCATION_TOPOLOGY_KEY,
        processingTimeoutFloorMs: DEPLOY_PROCESSING_TIMEOUT_FLOOR_MS,
        processingTimeoutConfiguredMs: DEPLOY_PROCESSING_TIMEOUT_CONFIGURED_MS,
        processingTimeoutMs: DEPLOY_PROCESSING_TIMEOUT_MS,
      },
      "Runner hardening limits configured",
    );
  }

  app.disable("x-powered-by");
  app.set("etag", false);
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use((req, res, next) => {
    const origin = normalizeOriginValue(req.get("origin"));
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        req.get("access-control-request-headers") ||
          "content-type,stripe-signature,x-github-event,x-hub-signature-256,x-gitlab-event,x-gitlab-token",
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        req.get("access-control-request-method") || "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
    }
    if (req.method === "OPTIONS") {
      if (origin && !isAllowedOrigin(origin)) {
        return res.status(403).json({ error: "Origin not allowed." });
      }
      return res.status(204).end();
    }
    next();
  });

  app.use(
    express.json({
      limit: "2mb",
      verify: (_req, _res, buf) => {
        if (buf?.length) {
          _req.rawBody = buf.toString();
        }
      },
    }),
  );
  app.use(validateRequest);
  app.use(
    express.static(join(__dirname, "..", "..", "frontend"), {
      extensions: ["html"],
    }),
  );
  routes.post("/webhooks/stripe", handleStripeWebhook);
  app.use(sessionMiddleware);
  app.use(sessionMutationProtectionMiddleware);
  routes.get("/healthz", (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  routes.get("/session", async (req, res) => {
    const authedUser = req.user || null;
    const [githubIdentity, githubInstallation, gitlabIdentity] = authedUser
      ? await Promise.all([
          getGitHubIdentityByUserId(authedUser.id),
          getLatestGitHubInstallationForUser(authedUser.id),
          getGitLabIdentityByUserId(authedUser.id),
        ])
      : [null, null, null];
    const avatarUrl = req.user?.avatar_url || null;
    const isAdmin = Boolean(req.session?.isAdmin);
    const displayName = req.user
      ? resolveUserDisplayName(req.user, githubIdentity, githubInstallation, gitlabIdentity)
      : null;
    const onboardingRequired = req.user ? isUserOnboardingRequired(req.user) : false;
    res.json({
      authenticated: Boolean(req.user),
      localAuthEnabled: LOCAL_AUTH_ENABLED,
      githubAuthEnabled: isGitHubUserAuthConfigured(),
      githubAppEnabled: isGitHubAppConfigured(),
      gitlabAuthEnabled: isGitLabAuthEnabledForSession(req.user),
      user: req.user
        ? {
            id: req.user.id,
            email: req.user.email,
            username: req.user.username ?? null,
            avatarUrl,
            isAdmin,
            displayName,
            onboardingRequired,
          }
        : null,
      billing: req.user ? billingStateToResponse(req.user) : null,
      github: githubIdentity
        ? {
            login: githubIdentity.login,
            name: githubIdentity.name || githubIdentity.login,
            avatarUrl: githubIdentity.avatarUrl || null,
          }
        : githubInstallation
          ? {
              login: githubInstallation.accountLogin,
              name: githubInstallation.accountLogin,
              avatarUrl: null,
            }
          : null,
      githubInstallation: githubInstallation
        ? {
            installationId: githubInstallation.installationId,
            accountLogin: githubInstallation.accountLogin,
          }
        : null,
      gitlab: gitlabIdentity
        ? {
            username: gitlabIdentity.username,
            name: gitlabIdentity.name || gitlabIdentity.username,
            avatarUrl: gitlabIdentity.avatarUrl || null,
          }
        : null,
      identity: defaultIdentity,
    });
  });

  routes.post("/billing/checkout", requireAuth, async (req, res) => {
    if (!stripeClient) {
      return res.status(503).json({ error: "Stripe billing is not configured." });
    }
    const interval = normalizeBillingInterval(req.body?.interval);
    const priceId = stripeProPriceIds[interval];
    if (!priceId) {
      return res.status(503).json({ error: "A3 Pro price is not configured." });
    }
    if (isUserPro(req.user)) {
      return res.status(409).json({ error: "A3 Pro is already active." });
    }

    try {
      const customerId = await ensureStripeCustomerForUser(req.user);
      const returnBase = getFrontendBaseUrl(req);
      const checkoutSession = await stripeClient.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        payment_method_types: ["card"],
        client_reference_id: req.user.id,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${returnBase}/?tab=tier&checkout=success`,
        cancel_url: `${returnBase}/?tab=tier&checkout=cancelled`,
        metadata: {
          userId: req.user.id,
          plan: "pro",
          interval,
        },
        subscription_data: {
          metadata: {
            userId: req.user.id,
            plan: "pro",
            interval,
          },
        },
      });
      return res.json({ url: checkoutSession.url });
    } catch (error) {
      logger.error({ err: error, userId: req.user.id }, "Failed to create Stripe Checkout session");
      return res.status(502).json({ error: "Unable to start checkout." });
    }
  });

  routes.post("/billing/portal", requireAuth, async (req, res) => {
    if (!stripeClient) {
      return res.status(503).json({ error: "Stripe billing is not configured." });
    }
    const customerId = String(req.user?.stripeCustomerId || "").trim();
    if (!customerId) {
      return res.status(409).json({ error: "No billing customer exists for this account." });
    }
    try {
      const portalSession = await stripeClient.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${getFrontendBaseUrl(req)}/?tab=tier`,
      });
      return res.json({ url: portalSession.url });
    } catch (error) {
      logger.error({ err: error, userId: req.user.id }, "Failed to create Stripe portal session");
      return res.status(502).json({ error: "Unable to open billing portal." });
    }
  });

  routes.get("/deployment-regions", requireAuth, async (_req, res) => {
    const regions = await listDeploymentRegions();
    res.json(regions);
  });

  routes.post("/auth/register", async (req, res) => {
    if (!LOCAL_AUTH_ENABLED) {
      return res.status(403).json({ error: "Local auth is disabled." });
    }
    return res.status(403).json({
      error: "Direct sign-up is disabled. Continue with GitHub to create an account.",
    });
  });

  routes.post("/auth/login", async (req, res) => {
    if (!LOCAL_AUTH_ENABLED) {
      return res.status(403).json({ error: "Local auth is disabled." });
    }
    const usernameInput = req.body?.username ?? req.body?.name ?? req.body?.displayName ?? null;
    const password = req.body?.password;
    const normalizedUsername = normalizeUsername(usernameInput);
    if (!normalizedUsername || typeof password !== "string") {
      return res.status(400).json({ error: "Username and password are required." });
    }
    if (
      !(await enforceRequestRateLimits(req, res, [
        {
          key: rateLimitKey("auth", "login", "ip-username", getClientIp(req), normalizedUsername),
          ...RATE_LIMIT_RULES.loginPerIpEmail,
          label: "auth:login:ip-username",
        },
        {
          key: rateLimitKey("auth", "login", "ip", getClientIp(req)),
          ...RATE_LIMIT_RULES.loginPerIp,
          label: "auth:login:ip",
        },
      ]))
    ) {
      return;
    }
    const user = await getUserByUsername(normalizedUsername);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    if (!user?.password_hash) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    let ok;
    try {
      ok = await argon2.verify(user.password_hash, password);
    } catch (error) {
      logger.warn(
        { err: error, userId: user.id },
        "Password verification failed due to malformed stored hash",
      );
      ok = false;
    }
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    await pool.query("update users set last_login_at = now(), updated_at = now() where id = $1", [
      user.id,
    ]);
    const sessionToken = await createSession(user.id);
    setSessionCookie(res, sessionToken);
    res.json({ user: { id: user.id, email: user.email } });
  });

  routes.post("/logout", async (req, res) => {
    const cookies = cookie.parse(req.headers?.cookie ?? "");
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const tokenHash = hashSessionToken(token);
      await pool.query("delete from sessions where token_hash = $1", [tokenHash]);
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  routes.get("/auth/github/login", (req, res) => {
    logOAuthAuthInit(req, {
      provider: "github",
      intent: "login",
      result: isGitHubUserAuthConfigured() ? "init_ok" : "not_configured",
    });
    if (!isGitHubUserAuthConfigured()) {
      return redirectToFrontendAuthError(req, res, "github_not_configured");
    }
    const state = signGitHubOAuthState({
      intent: "login",
      userId: null,
      issuedAtMs: Date.now(),
    });
    const redirectUri = `${getApiBaseUrl(req)}/auth/github/callback`;
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", githubAppClientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "read:user user:email");
    authorizeUrl.searchParams.set("state", state);
    logOAuthAuthInit(req, {
      provider: "github",
      intent: "login",
      result: "redirecting_to_provider",
      redirectUri,
    });
    res.redirect(authorizeUrl.toString());
  });
  routes.get("/auth/github/signup", (_req, res) => {
    res.redirect(302, "/auth/github/login");
  });
  routes.get("/auth/github/link", requireAuth, (req, res) => {
    logOAuthAuthInit(req, {
      provider: "github",
      intent: "link",
      result: isGitHubUserAuthConfigured() ? "init_ok" : "not_configured",
      userId: req.user?.id || null,
    });
    if (!isGitHubUserAuthConfigured()) {
      return res.status(500).json({
        error: "GitHub auth is not configured on the server.",
      });
    }
    const state = signGitHubOAuthState({
      intent: "link",
      userId: req.user.id,
      issuedAtMs: Date.now(),
    });
    const redirectUri = `${getApiBaseUrl(req)}/auth/github/callback`;
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", githubAppClientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "read:user user:email");
    authorizeUrl.searchParams.set("state", state);
    logOAuthAuthInit(req, {
      provider: "github",
      intent: "link",
      result: "redirecting_to_provider",
      userId: req.user?.id || null,
      redirectUri,
    });
    res.redirect(authorizeUrl.toString());
  });
  routes.get("/auth/github/callback", async (req, res) => {
    try {
      if (!isGitHubUserAuthConfigured()) {
        return res.status(500).send("GitHub auth is not configured on the server.");
      }
      const oauthError = String(req.query?.error || "").trim();
      if (oauthError) {
        return res.status(400).send(`GitHub authorization failed: ${oauthError}`);
      }
      const code = String(req.query?.code || "").trim();
      const state = String(req.query?.state || "").trim();
      if (!code || !state) {
        return res.status(400).send("Missing GitHub callback parameters.");
      }
      const parsedState = verifyGitHubOAuthState(state);
      if (!parsedState) {
        return res.status(400).send("Invalid or expired GitHub auth state.");
      }
      if (parsedState.intent === "link") {
        if (!req.user) {
          return res.status(401).send("Sign in before linking your GitHub account.");
        }
        if (parsedState.userId !== req.user.id) {
          return res.status(403).send("GitHub linking state does not match your account.");
        }
      }

      const redirectUri = `${getApiBaseUrl(req)}/auth/github/callback`;
      const accessToken = await exchangeGitHubOAuthCodeForToken({
        code,
        redirectUri,
      });
      const githubUser = await getGitHubOAuthUser(accessToken);
      const githubEmail = await getGitHubOAuthVerifiedEmail(accessToken, githubUser.email);
      const resolvedGitHubEmail =
        githubEmail || `github-${githubUser.id}@users.noreply.a3icp.local`;
      if (!githubEmail) {
        logger.warn(
          { githubUserId: githubUser.id, githubLogin: githubUser.login },
          "GitHub OAuth returned no verified email; using deterministic noreply fallback",
        );
      }

      const existingIdentity = await getGitHubIdentityByGithubUserId(githubUser.id);
      let user = null;
      let createdNewAccount = false;

      if (parsedState.intent === "link") {
        user = req.user;
        if (existingIdentity && existingIdentity.userId !== user.id) {
          return res.status(409).send("This GitHub account is already linked to another user.");
        }
      } else if (existingIdentity) {
        user = await getUserById(existingIdentity.userId);
      }

      if (!user) {
        user = await getUserByEmail(resolvedGitHubEmail);
      }

      if (!user) {
        const userId = randomUUID();
        const randomPassword = randomUUID();
        const passwordHash = await argon2.hash(randomPassword, {
          type: argon2.argon2id,
        });
        await pool.query(
          `insert into users (id, email, password_hash, password_set_by_user, avatar_url, created_at, updated_at, last_login_at)
           values ($1, $2, $3, false, $4, now(), now(), now())`,
          [userId, resolvedGitHubEmail, passwordHash, githubUser.avatarUrl || null],
        );
        user = await getUserById(userId);
        createdNewAccount = true;
      }

      if (!user) {
        return res.status(500).send("Failed to resolve user account.");
      }

      await upsertGitHubIdentity({
        userId: user.id,
        githubUserId: githubUser.id,
        login: githubUser.login,
        name: githubUser.name || null,
        avatarUrl: githubUser.avatarUrl || null,
      });

      await storeGitHubUserToken(user.id, accessToken);

      await pool.query(
        `update users
         set email = coalesce($2, email),
             avatar_url = coalesce($3, avatar_url),
             updated_at = now(),
             last_login_at = now()
         where id = $1`,
        [user.id, resolvedGitHubEmail, githubUser.avatarUrl || null],
      );

      const sessionToken = await createSession(user.id);
      setSessionCookie(res, sessionToken);

      const frontendBaseUrl = getFrontendBaseUrl(req);
      const target = new URL("/", frontendBaseUrl);
      target.searchParams.set("tab", parsedState.intent === "link" ? "profile" : "overview");
      if (parsedState.intent === "login") {
        const connectedRepoCount = await countConnectedReposForUser(user.id);
        if (createdNewAccount || connectedRepoCount === 0) {
          if (isGitHubAppConfigured()) {
            const installations = await listGitHubAppInstallations(user.id);
            if (!installations.length) {
              const installTarget = new URL("/github/app/install", getApiBaseUrl(req));
              installTarget.searchParams.set("onboarding", "connect-repo");
              installTarget.searchParams.set("provider", "github");
              installTarget.searchParams.set("tab", "overview");
              return res.redirect(installTarget.toString());
            }
          }
          target.searchParams.set("onboarding", "connect-repo");
          target.searchParams.set("provider", "github");
        }
      }
      res.redirect(target.toString());
    } catch (error) {
      logger.error({ err: error }, "GitHub callback failed");
      res
        .status(502)
        .send("GitHub authentication failed on the server. Please retry in a few seconds.");
    }
  });
  routes.get("/auth/gitlab/login", (req, res) => {
    if (!isGitLabAuthEnabledForSession(null)) {
      return res.status(403).json({
        error: "GitLab auth is not enabled on the server.",
      });
    }
    const state = signGitLabOAuthState({
      intent: "login",
      userId: null,
      issuedAtMs: Date.now(),
    });
    const redirectUri = `${getApiBaseUrl(req)}/auth/gitlab/callback`;
    const authorizeUrl = new URL("/oauth/authorize", gitlabBaseUrl);
    authorizeUrl.searchParams.set("client_id", gitlabClientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "read_user api");
    authorizeUrl.searchParams.set("state", state);
    res.redirect(authorizeUrl.toString());
  });
  routes.get("/auth/gitlab/signup", (_req, res) => {
    res.redirect(302, "/auth/gitlab/login");
  });
  routes.get("/auth/gitlab/link", requireAuth, (req, res) => {
    if (!isGitLabAuthEnabledForSession(req.user)) {
      return res.status(403).json({
        error: "GitLab auth is not enabled for this account.",
      });
    }
    const state = signGitLabOAuthState({
      intent: "link",
      userId: req.user.id,
      issuedAtMs: Date.now(),
    });
    const redirectUri = `${getApiBaseUrl(req)}/auth/gitlab/callback`;
    const authorizeUrl = new URL("/oauth/authorize", gitlabBaseUrl);
    authorizeUrl.searchParams.set("client_id", gitlabClientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "read_user api");
    authorizeUrl.searchParams.set("state", state);
    res.redirect(authorizeUrl.toString());
  });
  routes.get("/auth/gitlab/callback", async (req, res) => {
    try {
      if (!isGitLabAuthEnabledForSession(req.user || null)) {
        return res.status(403).send("GitLab auth is not enabled on the server.");
      }
      const oauthError = String(req.query?.error || "").trim();
      if (oauthError) {
        return res.status(400).send(`GitLab authorization failed: ${oauthError}`);
      }
      const code = String(req.query?.code || "").trim();
      const state = String(req.query?.state || "").trim();
      if (!code || !state) {
        return res.status(400).send("Missing GitLab callback parameters.");
      }
      const parsedState = verifyGitLabOAuthState(state);
      if (!parsedState) {
        return res.status(400).send("Invalid or expired GitLab auth state.");
      }
      if (parsedState.intent === "link") {
        if (!req.user) {
          return res.status(401).send("Sign in before linking your GitLab account.");
        }
        if (parsedState.userId !== req.user.id) {
          return res.status(403).send("GitLab linking state does not match your account.");
        }
      }

      const redirectUri = `${getApiBaseUrl(req)}/auth/gitlab/callback`;
      const tokenPayload = await exchangeGitLabOAuthCodeForToken({
        code,
        redirectUri,
      });
      const accessToken = tokenPayload.accessToken;
      const gitlabUser = await getGitLabOAuthUser(accessToken);
      const gitlabEmail = await getGitLabOAuthVerifiedEmail(accessToken, gitlabUser.email);
      const resolvedGitLabEmail =
        gitlabEmail || `gitlab-${gitlabUser.id}@users.noreply.a3icp.local`;

      if (!gitlabEmail) {
        logger.warn(
          { gitlabUserId: gitlabUser.id, gitlabUsername: gitlabUser.username },
          "GitLab OAuth returned no verified email; using deterministic noreply fallback",
        );
      }

      if (!isGitLabEmailAllowlisted(resolvedGitLabEmail)) {
        return res.status(403).send("GitLab beta access is not enabled for this email.");
      }

      const existingIdentity = await getGitLabIdentityByGitLabUserId(gitlabUser.id);
      let user = null;

      if (parsedState.intent === "link") {
        user = req.user;
        if (existingIdentity && existingIdentity.userId !== user.id) {
          return res.status(409).send("This GitLab account is already linked to another user.");
        }
      } else if (existingIdentity) {
        user = await getUserById(existingIdentity.userId);
      }

      if (!user) {
        user = await getUserByEmail(resolvedGitLabEmail);
      }

      if (!user) {
        const userId = randomUUID();
        const randomPassword = randomUUID();
        const passwordHash = await argon2.hash(randomPassword, {
          type: argon2.argon2id,
        });
        await pool.query(
          `insert into users (id, email, password_hash, password_set_by_user, avatar_url, created_at, updated_at, last_login_at)
           values ($1, $2, $3, false, $4, now(), now(), now())`,
          [userId, resolvedGitLabEmail, passwordHash, gitlabUser.avatarUrl || null],
        );
        user = await getUserById(userId);
      }

      if (!user) {
        return res.status(500).send("Failed to resolve user account.");
      }

      await upsertGitLabIdentity({
        userId: user.id,
        gitlabUserId: gitlabUser.id,
        username: gitlabUser.username,
        name: gitlabUser.name || null,
        avatarUrl: gitlabUser.avatarUrl || null,
      });
      await upsertGitLabAccountToken({
        userId: user.id,
        accessToken,
        scope: tokenPayload.scope || null,
        tokenType: tokenPayload.tokenType || null,
      });

      await pool.query(
        `update users
         set email = coalesce($2, email),
             avatar_url = coalesce($3, avatar_url),
             updated_at = now(),
             last_login_at = now()
         where id = $1`,
        [user.id, resolvedGitLabEmail, gitlabUser.avatarUrl || null],
      );

      const sessionToken = await createSession(user.id);
      setSessionCookie(res, sessionToken);

      const frontendBaseUrl = getFrontendBaseUrl(req);
      const target = new URL("/", frontendBaseUrl);
      target.searchParams.set("tab", parsedState.intent === "link" ? "profile" : "overview");
      res.redirect(target.toString());
    } catch (error) {
      logger.error({ err: error }, "GitLab callback failed");
      res
        .status(502)
        .send("GitLab authentication failed on the server. Please retry in a few seconds.");
    }
  });
  routes.get("/gitlab/account", requireAuth, async (req, res) => {
    if (!isGitLabAuthEnabledForSession(req.user)) {
      return res.status(403).json({ error: "GitLab auth is not enabled for this account." });
    }
    const identity = await getGitLabIdentityByUserId(req.user.id);
    const account = await getGitLabAccountToken(req.user.id);
    res.json({
      connected: Boolean(identity && account?.accessToken),
      identity: identity
        ? {
            username: identity.username,
            name: identity.name || identity.username,
            avatarUrl: identity.avatarUrl || null,
          }
        : null,
    });
  });
  routes.delete("/gitlab/account", requireAuth, async (req, res) => {
    await deleteGitLabAccount(req.user.id);
    await pool.query(`delete from user_gitlab_identities where user_id = $1`, [req.user.id]);
    await pool.query(
      `update projects
       set repo_url = null,
           git_provider = 'github',
           gitlab_project_id = null,
           gitlab_path_with_namespace = null,
           gitlab_webhook_id = null,
           gitlab_webhook_secret = null,
           updated_at = now()
       where user_id = $1 and git_provider = 'gitlab'`,
      [req.user.id],
    );
    res.status(204).end();
  });
  routes.get("/gitlab/repos", requireAuth, async (req, res) => {
    if (!isGitLabAuthEnabledForSession(req.user)) {
      return res.status(403).json({ error: "GitLab auth is not enabled for this account." });
    }
    try {
      const repos = await listGitLabReposForUser(req.user.id);
      res.json(repos);
    } catch (error) {
      if (error?.name === "GitLabAccountMissingError") {
        return res.status(409).json({ error: "Connect your GitLab account first." });
      }
      logger.error({ err: error, userId: req.user.id }, "Failed to list GitLab repositories");
      return res.status(502).json({ error: "Unable to list GitLab repositories." });
    }
  });
  routes.post("/gitlab/connect", requireAuth, async (req, res) => {
    if (!isGitLabAuthEnabledForSession(req.user)) {
      return res.status(403).json({ error: "GitLab auth is not enabled for this account." });
    }
    const isAdmin = await isUserAdminEmail(req.user.email);
    const { repo, branch, projectId, repoId } = req.body ?? {};
    const buildConfigInput = sanitizeBuildConfig(req.body);
    const buildConfigError = validateBuildConfigInput(buildConfigInput);
    if (buildConfigError) {
      return res.status(400).json({ error: buildConfigError });
    }
    if (!repo || typeof repo !== "string") {
      return res.status(400).json({ error: "Missing or invalid GitLab repository path." });
    }
    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({ error: "projectId is required." });
    }

    let project = await findProjectById(req.user.id, projectId);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    const tenant = await getTenantByProjectId(project.id);
    if (!tenant) {
      return res.status(409).json({ error: "Tenant mapping required before connecting repo." });
    }

    let selectedRepo;
    try {
      selectedRepo = await findGitLabRepoForUser(req.user.id, {
        pathWithNamespace: repo,
        projectId: repoId,
      });
    } catch (error) {
      if (error?.name === "GitLabAccountMissingError") {
        return res.status(409).json({ error: "Connect your GitLab account first." });
      }
      logger.warn(
        {
          err: error,
          userId: req.user.id,
          repo,
          repoId: repoId ?? null,
        },
        "GitLab repository resolution failed during connect",
      );
      return res
        .status(404)
        .json({ error: "Repository is not accessible through your linked GitLab account." });
    }

    const normalizedPath = normalizeGitLabRepoPath(selectedRepo.pathWithNamespace);
    if (!normalizedPath) {
      return res.status(400).json({ error: "Repository path is invalid." });
    }

    const refBranch = branch || selectedRepo.defaultBranch || "main";
    const repoUrl = selectedRepo.cloneUrl || `https://gitlab.com/${normalizedPath}.git`;

    if (!isAdmin) {
      const existingByRepo = await findProjectByRepo(req.user.id, repoUrl);
      if (existingByRepo && existingByRepo.id !== project.id) {
        return res.status(409).json({ error: "Repository already connected to another project." });
      }
    }

    project.branch = refBranch;
    project.repoUrl = repoUrl;
    project.gitProvider = "gitlab";
    project.github = null;
    const webhookSecret = project.gitlab?.webhookSecret || generateToken();
    project.gitlab = {
      projectId: selectedRepo.id,
      pathWithNamespace: normalizedPath,
      webhookId: null,
      webhookSecret,
    };
    project.identity = project.identity ?? defaultIdentity;
    if (hasBuildOverrides(buildConfigInput)) {
      project.settings = mergeBuildConfig(project.settings, buildConfigInput);
    }

    const webhookUrl = `${getApiBaseUrl(req)}/gitlab/webhook`;
    let gitlabWebhookSetup = { mode: "manual", reason: "auto_create_failed" };
    try {
      const hook = await createGitLabProjectWebhook({
        userId: req.user.id,
        gitlabProjectId: selectedRepo.id,
        webhookUrl,
        webhookSecret,
      });
      project.gitlab.webhookId = hook?.id ?? null;
      gitlabWebhookSetup = { mode: "auto" };
    } catch (error) {
      logger.warn(
        {
          err: error,
          userId: req.user.id,
          projectId: project.id,
          gitlabProjectId: selectedRepo.id,
        },
        "Failed to auto-create GitLab webhook; manual setup required",
      );
    }

    project = await saveProject(project);
    project.tenant = tenant;

    let deployment;
    try {
      deployment = await triggerDeployment(project, {
        branch: refBranch,
        source: "gitlab:connect",
        metadata: {
          initiator: req.user.email,
          gitlabProjectId: selectedRepo.id,
        },
      });
    } catch (error) {
      if (replyDeploymentAdmissionError(res, error)) {
        return;
      }
      logger.error(
        { err: error, projectId: project.id },
        "GitLab connect deployment admission failed",
      );
      return res.status(500).json({ error: "Failed to start deployment." });
    }

    const payload = projectToResponse(req, project, deployment);
    payload.gitlabWebhookSetup = gitlabWebhookSetup;
    return res.status(201).json(payload);
  });
  routes.get("/templates", requireAuth, (_req, res) => {
    res.json(templateCatalogToResponse());
  });
  routes.post("/templates/provision", requireAuth, async (req, res) => {
    const isAdmin = await isUserAdminEmail(req.user.email);
    const templateId = String(req.body?.templateId || "")
      .trim()
      .toLowerCase();
    const provider = normalizeGitProvider(req.body?.provider);
    const repoName = normalizeTemplateRepoName(req.body?.repoName);
    const projectSlug = normalizeSlug(req.body?.projectSlug);
    const githubInstallationId = parseGitHubAppInstallationId(req.body?.githubInstallationId);
    const template = getTemplateById(templateId);
    if (!template) {
      return res.status(404).json({ error: "Unknown template." });
    }
    if (!repoName) {
      return res.status(400).json({
        error: "repoName may only include letters, numbers, dashes, dots, and underscores.",
      });
    }
    const slugError = validateSlug(projectSlug);
    if (slugError) {
      return res.status(400).json({ error: slugError });
    }
    const existingTemplateProject = await findProjectByTemplateId(req.user.id, template.id);
    if (existingTemplateProject) {
      return res.status(409).json({
        error: "You already used this template. Delete that project first to use it again.",
      });
    }
    if (!isAdmin) {
      try {
        await enforceProjectLimit(req.user.id);
      } catch (error) {
        return res.status(409).json({ error: error?.message || "Project limit reached." });
      }
    }

    let provisionedRepo;
    if (provider === "github") {
      if (!isGitHubAppConfigured()) {
        return res.status(403).json({ error: "GitHub App is not configured." });
      }
      if (!githubInstallationId) {
        return res
          .status(400)
          .json({ error: "githubInstallationId is required for GitHub templates." });
      }
      const installations = await listGitHubAppInstallations(req.user.id);
      const selectedInstallation =
        installations.find(
          (item) => Number(item.installationId) === Number(githubInstallationId),
        ) || null;
      if (!selectedInstallation) {
        return res.status(404).json({
          error: "Selected GitHub installation is not linked to your account.",
        });
      }
      let templateTargetOwner = String(selectedInstallation.accountLogin || "").trim();
      if (!templateTargetOwner) {
        try {
          const installation = await getGitHubAppInstallation(githubInstallationId);
          templateTargetOwner = String(installation?.accountLogin || "").trim();
          if (templateTargetOwner) {
            await upsertGitHubAppInstallation({
              userId: req.user.id,
              installationId: githubInstallationId,
              accountLogin: installation.accountLogin,
              accountType: installation.accountType,
              accountId: installation.accountId,
            });
          }
        } catch (error) {
          logger.warn(
            { err: error, userId: req.user.id, githubInstallationId },
            "Failed to refresh GitHub installation owner login for template provisioning",
          );
        }
      }
      if (!templateTargetOwner) {
        return res.status(409).json({
          error:
            "Selected GitHub installation owner is unknown. Reconnect GitHub App and try again.",
        });
      }
      const targetRepoFullName = normalizeGitHubRepoKey(`${templateTargetOwner}/${repoName}`);
      if (!targetRepoFullName) {
        return res.status(400).json({
          error: "Repository name is invalid for the selected GitHub installation owner.",
        });
      }
      try {
        provisionedRepo = await findGitHubAppRepoForUser(req.user.id, {
          repoFullName: targetRepoFullName,
          installationId: githubInstallationId,
        });
      } catch (error) {
        logger.info(
          {
            err: error,
            userId: req.user.id,
            githubInstallationId,
            repoFullName: targetRepoFullName,
          },
          "Template provisioning cannot access requested GitHub repository",
        );
        return res.status(404).json({
          error: `Repository ${targetRepoFullName} not found in this installation. Open template, create repo, then retry.`,
          requiresUserRepoCreation: true,
          nextAction: {
            type: "open_github_template",
            repoFullName: targetRepoFullName,
            url: buildGitHubTemplateGenerateUrl(
              template.providerSource,
              repoName,
              templateTargetOwner,
            ),
          },
        });
      }
    } else {
      if (!isGitLabAuthEnabledForSession(req.user)) {
        return res.status(403).json({ error: "GitLab auth is not enabled for this account." });
      }
      try {
        provisionedRepo = await createGitLabRepoFromTemplate({
          userId: req.user.id,
          templateSourceGitUrl: template.providerSourceGitUrl,
          repoName,
          privateRepo: true,
        });
      } catch (error) {
        if (error?.name === "GitLabAccountMissingError") {
          return res.status(409).json({ error: "Connect your GitLab account first." });
        }
        const message = String(error?.message || "Failed to create GitLab repository.");
        const normalizedMessage = message.toLowerCase();
        const code =
          normalizedMessage.includes("already been taken") ||
          normalizedMessage.includes("already exists")
            ? 409
            : 502;
        return res.status(code).json({ error: message });
      }
    }

    let project;
    try {
      project = await createProject(
        req.user.id,
        { repoUrl: null, branch: null },
        {
          settings: template.defaultBuildConfig || {},
          templateId: template.id,
          templateName: template.name,
        },
      );
    } catch (error) {
      if (isTemplateReuseConflict(error)) {
        return res.status(409).json({
          error: "You already used this template. Delete that project first to use it again.",
        });
      }
      throw error;
    }

    try {
      project.tenant = await ensureTenantForProject(project.id, projectSlug);
    } catch (error) {
      await pool.query("delete from projects where id = $1", [project.id]);
      return res.status(409).json({ error: error?.message || "Tenant creation failed." });
    }

    if (provider === "github") {
      const repoFullName = normalizeGitHubRepoKey(provisionedRepo.fullName);
      if (!repoFullName) {
        return res.status(502).json({ error: "GitHub repository metadata is invalid." });
      }
      const [owner, repo] = repoFullName.split("/");
      const refBranch = provisionedRepo.defaultBranch || "main";
      project.branch = refBranch;
      project.repoUrl = provisionedRepo.cloneUrl || `https://github.com/${repoFullName}.git`;
      project.gitProvider = "github";
      project.github = {
        owner,
        repo,
        fullName: repoFullName,
        defaultBranch: provisionedRepo.defaultBranch || null,
        webhookSecret: null,
        webhookId: null,
        installationId: provisionedRepo.installationId,
        repoId: provisionedRepo.id,
      };
      project.gitlab = null;
      project = await saveProject(project);
      project.tenant = project.tenant || (await getTenantByProjectId(project.id));
      let deployment;
      try {
        deployment = await triggerDeployment(project, {
          branch: refBranch,
          source: "github:template",
          metadata: {
            initiator: req.user.email,
            githubInstallationId: provisionedRepo.installationId,
            templateId: template.id,
          },
        });
      } catch (error) {
        if (replyDeploymentAdmissionError(res, error)) {
          return;
        }
        logger.error(
          { err: error, projectId: project.id },
          "GitHub template deployment admission failed",
        );
        return res.status(500).json({ error: "Failed to start deployment." });
      }
      return res.status(201).json(projectToResponse(req, project, deployment));
    }

    const refBranch = provisionedRepo.defaultBranch || "main";
    const normalizedPath = normalizeGitLabRepoPath(provisionedRepo.pathWithNamespace);
    if (!normalizedPath) {
      return res.status(502).json({ error: "GitLab repository metadata is invalid." });
    }
    const webhookSecret = generateToken();
    project.branch = refBranch;
    project.repoUrl = provisionedRepo.cloneUrl || `https://gitlab.com/${normalizedPath}.git`;
    project.gitProvider = "gitlab";
    project.github = null;
    project.gitlab = {
      projectId: provisionedRepo.id,
      pathWithNamespace: normalizedPath,
      webhookId: null,
      webhookSecret,
    };
    let gitlabWebhookSetup = { mode: "manual", reason: "auto_create_failed" };
    const webhookUrl = `${getApiBaseUrl(req)}/gitlab/webhook`;
    try {
      const hook = await createGitLabProjectWebhook({
        userId: req.user.id,
        gitlabProjectId: provisionedRepo.id,
        webhookUrl,
        webhookSecret,
      });
      project.gitlab.webhookId = hook?.id ?? null;
      gitlabWebhookSetup = { mode: "auto" };
    } catch (error) {
      logger.warn(
        {
          err: error,
          userId: req.user.id,
          projectId: project.id,
          gitlabProjectId: provisionedRepo.id,
        },
        "Failed to auto-create GitLab webhook for template project; manual setup required",
      );
    }
    project = await saveProject(project);
    project.tenant = project.tenant || (await getTenantByProjectId(project.id));
    let deployment;
    try {
      deployment = await triggerDeployment(project, {
        branch: refBranch,
        source: "gitlab:template",
        metadata: {
          initiator: req.user.email,
          gitlabProjectId: provisionedRepo.id,
          templateId: template.id,
        },
      });
    } catch (error) {
      if (replyDeploymentAdmissionError(res, error)) {
        return;
      }
      logger.error(
        { err: error, projectId: project.id },
        "GitLab template deployment admission failed",
      );
      return res.status(500).json({ error: "Failed to start deployment." });
    }
    const payload = projectToResponse(req, project, deployment);
    payload.gitlabWebhookSetup = gitlabWebhookSetup;
    return res.status(201).json(payload);
  });
  routes.get("/github/access", (_req, res) => {
    res.status(410).json({ error: "GitHub allowlist access mode is deprecated." });
  });
  routes.put("/github/access/mode", (_req, res) => {
    res.status(410).json({ error: "GitHub allowlist access mode is deprecated." });
  });
  routes.post("/github/access/allowlist", (_req, res) => {
    res.status(410).json({ error: "GitHub allowlist access mode is deprecated." });
  });
  routes.delete("/github/access/allowlist/:repoKey", (_req, res) => {
    res.status(410).json({ error: "GitHub allowlist access mode is deprecated." });
  });

  routes.get("/github/app/install", requireAuth, async (req, res) => {
    if (!isGitHubAppConfigured()) {
      return res.status(500).json({ error: "GitHub App is not configured on the server." });
    }
    const onboarding = normalizeGitHubAppInstallOnboardingIntent(req.query?.onboarding);
    const provider = normalizeGitProvider(req.query?.provider);
    const targetTab = normalizeGitHubAppInstallTargetTab(
      req.query?.tab,
      onboarding === "connect-repo" ? "overview" : "github",
    );
    const state = signGitHubAppInstallState({
      userId: req.user.id,
      issuedAtMs: Date.now(),
      onboarding,
      provider,
      targetTab,
    });
    const installUrl = new URL(
      `https://github.com/apps/${encodeURIComponent(githubAppSlug)}/installations/new`,
    );
    installUrl.searchParams.set("state", state);
    installUrl.searchParams.set("redirect_uri", `${getBaseUrl(req)}/github/app/callback`);
    if (githubAppClientId) {
      installUrl.searchParams.set("client_id", githubAppClientId);
    }
    res.redirect(installUrl.toString());
  });

  routes.get("/github/app/callback", requireAuth, async (req, res) => {
    if (!isGitHubAppConfigured()) {
      return res.status(500).send("GitHub App is not configured on the server.");
    }
    const state = String(req.query?.state || "").trim();
    const installationIdRaw = String(req.query?.installation_id || "").trim();
    const setupAction = String(req.query?.setup_action || "")
      .trim()
      .toLowerCase();

    if (!state || !installationIdRaw) {
      return res.status(400).send("Missing installation callback parameters.");
    }
    const installationId = positiveId(installationIdRaw);
    if (!installationId) {
      return res.status(400).send("Invalid installation id.");
    }
    const parsedState = verifyGitHubAppInstallState(state);
    if (!parsedState) {
      return res.status(400).send("Invalid or expired installation state.");
    }
    if (parsedState.userId !== req.user.id) {
      return res.status(403).send("Installation state does not match your account.");
    }

    const installation = await requireGitHubInstallationAccess(req.user.id, installationId);
    if (!installation) {
      return res.status(404).send("GitHub installation not found.");
    }

    const linked = await upsertGitHubAppInstallation({
      userId: req.user.id,
      installationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      accountId: installation.accountId,
      setupAction: setupAction || null,
    });
    logger.info(
      {
        userId: req.user.id,
        installationId: linked.installationId,
        accountLogin: linked.accountLogin,
        setupAction: setupAction || null,
      },
      "Linked GitHub App installation",
    );

    const frontendBaseUrl = getFrontendBaseUrl(req);
    const target = new URL("/", frontendBaseUrl);
    target.searchParams.set("tab", parsedState.targetTab || "github");
    if (parsedState.onboarding === "connect-repo") {
      target.searchParams.set("onboarding", "connect-repo");
      target.searchParams.set("provider", parsedState.provider || "github");
    }
    res.redirect(target.toString());
  });

  routes.get("/github/installations", requireAuth, async (req, res) => {
    const items = await listGitHubAppInstallations(req.user.id);
    res.json(items);
  });

  routes.delete("/github/installations/:installationId", requireAuth, async (req, res) => {
    const installationId = Number.parseInt(String(req.params.installationId || "").trim(), 10);
    if (!Number.isFinite(installationId)) {
      return res.status(400).json({ error: "Invalid installation id." });
    }
    const deleted = await unlinkGitHubAppInstallation(req.user.id, installationId);
    if (!deleted) {
      return res.status(404).json({ error: "Installation not found." });
    }
    await pool.query(
      `update projects
       set github_installation_id = null,
           github_repo_id = null,
           github_webhook_id = null,
           github_webhook_secret = null,
           updated_at = now()
       where user_id = $1 and github_installation_id = $2`,
      [req.user.id, installationId],
    );
    res.status(204).end();
  });

  routes.patch("/profile/avatar", requireAuth, async (req, res) => {
    const raw = (req.body?.avatarUrl ?? "").trim();
    const avatarUrl =
      raw.length === 0
        ? null
        : raw.length <= 2048 && (/^https?:\/\//i.test(raw) || /^data:image\//i.test(raw))
          ? raw
          : null;
    if (raw && avatarUrl === null) {
      return res.status(400).json({
        error: "Avatar must be http(s) or data:image/... and under 2048 chars.",
      });
    }
    const result = await pool.query(
      "update users set avatar_url = $2, updated_at = now() where id = $1 returning avatar_url",
      [req.user.id, avatarUrl],
    );
    const updated = result.rows[0];
    req.user.avatar_url = updated?.avatar_url ?? null;
    res.json({ avatarUrl: req.user.avatar_url });
  });
  routes.post("/profile/password", requireAuth, async (req, res) => {
    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;
    if (
      typeof currentPassword !== "string" ||
      !currentPassword ||
      typeof newPassword !== "string" ||
      newPassword.length < 8
    ) {
      return res.status(400).json({
        error: "currentPassword and newPassword (min 8 chars) are required.",
      });
    }

    const user = await getUserById(req.user.id);
    if (!user?.password_hash) {
      return res.status(400).json({ error: "Password login is not available for this account." });
    }

    let validCurrent;
    try {
      validCurrent = await argon2.verify(user.password_hash, currentPassword);
    } catch (error) {
      logger.warn(
        { err: error, userId: req.user.id },
        "Current password verification failed due to malformed stored hash",
      );
      validCurrent = false;
    }
    if (!validCurrent) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    const nextHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await pool.query(
      `update users
       set password_hash = $2,
           password_set_by_user = true,
           updated_at = now()
       where id = $1`,
      [req.user.id, nextHash],
    );
    req.user.password_hash = nextHash;
    req.user.password_set_by_user = true;
    res.status(204).end();
  });
  routes.post("/profile/onboarding", requireAuth, async (req, res) => {
    const displayName = normalizeDisplayName(req.body?.displayName);
    const username = normalizeUsername(req.body?.displayName);
    const onboardingSource = normalizeOnboardingSource(req.body?.howHeard);
    const password = req.body?.password;
    if (!displayName || displayName.length < 2) {
      return res.status(400).json({ error: "displayName must be at least 2 characters." });
    }
    if (!username) {
      return res.status(400).json({ error: "displayName must be valid." });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters." });
    }
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    let result;
    try {
      result = await pool.query(
        `update users
       set display_name = $2,
           username = $3,
           onboarding_source = $4,
           password_hash = $5,
           password_set_by_user = true,
           onboarding_completed_at = now(),
           updated_at = now()
       where id = $1
       returning display_name, username, onboarding_source, onboarding_completed_at`,
        [req.user.id, displayName, username, onboardingSource, passwordHash],
      );
    } catch (error) {
      if (
        error?.code === "23505" &&
        String(error?.message || "")
          .toLowerCase()
          .includes("users_username_lower_unique_idx")
      ) {
        return res.status(409).json({ error: "Name is already in use. Choose a different one." });
      }
      throw error;
    }
    const row = result.rows[0];
    req.user.display_name = row?.display_name ?? displayName;
    req.user.username = row?.username ?? username;
    req.user.onboarding_source = row?.onboarding_source ?? onboardingSource;
    req.user.onboarding_completed_at = row?.onboarding_completed_at ?? null;
    req.user.password_set_by_user = true;
    res.json({
      displayName: req.user.display_name,
      onboardingSource: req.user.onboarding_source ?? null,
      onboardingCompletedAt: toMillis(req.user.onboarding_completed_at),
    });
  });
  routes.get("/github/repos", requireAuth, async (req, res) => {
    try {
      const repos = await listGitHubAppReposForUser(req.user.id);
      res.json(repos);
    } catch (error) {
      logger.error({ err: error, userId: req.user.id }, "Failed to list GitHub App repositories");
      return res.status(502).json({ error: "Unable to list GitHub repositories." });
    }
  });

  routes.post("/github/connect", requireAuth, async (req, res) => {
    const isAdmin = await isUserAdminEmail(req.user.email);
    const { repo, branch, projectId, repoId, installationId } = req.body ?? {};
    const buildConfigInput = sanitizeBuildConfig(req.body);
    const buildConfigError = validateBuildConfigInput(buildConfigInput);
    if (buildConfigError) {
      return res.status(400).json({ error: buildConfigError });
    }
    if (!repo || typeof repo !== "string" || !repo.includes("/")) {
      return res.status(400).json({ error: "Missing or invalid repo name." });
    }
    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({ error: "projectId is required." });
    }

    let project = await findProjectById(req.user.id, projectId);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    const tenant = await getTenantByProjectId(project.id);
    if (!tenant) {
      return res.status(409).json({ error: "Tenant mapping required before connecting repo." });
    }
    let selectedRepo;
    try {
      selectedRepo = await findGitHubAppRepoForUser(req.user.id, {
        repoFullName: repo,
        repoId,
        installationId,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          userId: req.user.id,
          repo,
          repoId: repoId ?? null,
          installationId: installationId ?? null,
        },
        "GitHub App repository resolution failed during connect",
      );
      return res
        .status(404)
        .json({ error: "Repository is not accessible through your GitHub App installations." });
    }
    const repoFullName = normalizeGitHubRepoKey(selectedRepo.fullName);
    if (!repoFullName) {
      return res.status(400).json({ error: "Repository full name is invalid." });
    }
    const refBranch = branch || selectedRepo.defaultBranch || "main";
    const repoUrl = selectedRepo.cloneUrl || `https://github.com/${repoFullName}.git`;
    const [owner, repoName] = repoFullName.split("/");

    if (!isAdmin) {
      const existingByRepo = await findProjectByRepo(req.user.id, repoUrl);
      if (existingByRepo && existingByRepo.id !== project.id) {
        return res.status(409).json({ error: "Repository already connected to another project." });
      }
    }

    project.branch = refBranch;
    project.repoUrl = repoUrl;
    project.gitProvider = "github";
    project.github = {
      owner,
      repo: repoName,
      fullName: repoFullName,
      defaultBranch: selectedRepo.defaultBranch || null,
      webhookSecret: null,
      webhookId: null,
      installationId: selectedRepo.installationId,
      repoId: selectedRepo.id,
    };
    project.gitlab = null;
    project.identity = project.identity ?? defaultIdentity;
    if (hasBuildOverrides(buildConfigInput)) {
      project.settings = mergeBuildConfig(project.settings, buildConfigInput);
    }
    project = await saveProject(project);
    project.tenant = tenant;

    let deployment;
    try {
      deployment = await triggerDeployment(project, {
        branch: refBranch,
        source: "github:connect",
        metadata: {
          initiator: req.user.email,
          githubInstallationId: selectedRepo.installationId,
        },
      });
    } catch (error) {
      if (replyDeploymentAdmissionError(res, error)) {
        return;
      }
      logger.error(
        { err: error, projectId: project.id },
        "GitHub connect deployment admission failed",
      );
      return res.status(500).json({ error: "Failed to start deployment." });
    }

    res.status(201).json(projectToResponse(req, project, deployment));
  });

  routes.get("/projects", requireAuth, async (req, res) => {
    const items = (await listProjects(req.user.id)).map((project) =>
      projectToResponse(req, project),
    );
    res.json(items);
  });

  routes.post("/tenants", requireAuth, async (req, res) => {
    const { projectId, slug } = req.body ?? {};
    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({ error: "projectId is required." });
    }
    if (!slug || typeof slug !== "string") {
      return res.status(400).json({ error: "slug is required." });
    }
    const normalizedSlug = normalizeSlug(slug);
    const slugError = validateSlug(normalizedSlug);
    if (slugError) {
      return res.status(400).json({ error: slugError });
    }

    const project = await findProjectById(req.user.id, projectId);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }

    let tenant;
    try {
      tenant = await ensureTenantForProject(projectId, normalizedSlug);
    } catch (error) {
      return res.status(409).json({ error: error?.message || "Tenant creation failed." });
    }
    const hostedUrl = buildHostedUrl({
      slug: tenant.slug,
      domainMode: tenant.domainMode,
      hostCanisterAlias: tenant.hostCanisterAlias,
    });
    res.status(201).json({
      id: tenant.id,
      slug: tenant.slug,
      domainMode: tenant.domainMode ?? "legacy",
      projectId,
      hostCanisterId: tenant.hostCanisterId,
      hostCanisterAlias: tenant.hostCanisterAlias ?? null,
      hostCanisterRegion: tenant.hostCanisterRegion ?? "global",
      hostCanisterVisibility: tenant.hostCanisterVisibility ?? "public",
      hostedUrl,
    });
  });

  routes.get("/tenants/:tenantId", requireAuth, async (req, res) => {
    const tenant = await getTenantById(req.params.tenantId);
    if (!tenant) {
      return res.status(404).json({ error: "Unknown tenant." });
    }
    const project = await findProjectById(req.user.id, tenant.projectId);
    if (!project) {
      const isAdmin = await isUserAdminEmail(req.user.email);
      if (!isAdmin) {
        return res.status(404).json({ error: "Unknown tenant." });
      }
    }
    const hostedUrl = buildHostedUrl({
      slug: tenant.slug,
      domainMode: tenant.domainMode,
      hostCanisterAlias: tenant.hostCanisterAlias,
    });
    res.json({
      id: tenant.id,
      slug: tenant.slug,
      domainMode: tenant.domainMode ?? "legacy",
      projectId: tenant.projectId,
      hostCanisterId: tenant.hostCanisterId,
      hostCanisterAlias: tenant.hostCanisterAlias ?? null,
      hostCanisterRegion: tenant.hostCanisterRegion ?? "global",
      hostCanisterVisibility: tenant.hostCanisterVisibility ?? "public",
      hostedUrl,
    });
  });

  routes.get("/projects/:id/tenant", requireAuth, async (req, res) => {
    const project = await findProjectById(req.user.id, req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    const tenant = await getTenantByProjectId(project.id);
    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found for project." });
    }
    const hostedUrl = buildHostedUrl({
      slug: tenant.slug,
      domainMode: tenant.domainMode,
      hostCanisterAlias: tenant.hostCanisterAlias,
    });
    res.json({
      id: tenant.id,
      slug: tenant.slug,
      domainMode: tenant.domainMode ?? "legacy",
      projectId: tenant.projectId,
      hostCanisterId: tenant.hostCanisterId,
      hostCanisterAlias: tenant.hostCanisterAlias ?? null,
      hostCanisterRegion: tenant.hostCanisterRegion ?? "global",
      hostCanisterVisibility: tenant.hostCanisterVisibility ?? "public",
      hostedUrl,
    });
  });

  routes.post("/projects", requireAuth, async (req, res) => {
    const isAdmin = await isUserAdminEmail(req.user.email);
    const { repoUrl, branch, slug, envVars } = req.body ?? {};
    let routing;
    try {
      routing = resolveRequestedProjectRouting(req.user, req.body ?? {});
    } catch (error) {
      return res
        .status(Number.isFinite(error?.statusCode) ? error.statusCode : 400)
        .json({ error: error?.message || "Invalid deployment region." });
    }
    const buildConfigInput = sanitizeBuildConfig(req.body);
    const buildConfigError = validateBuildConfigInput(buildConfigInput);
    if (buildConfigError) {
      return res.status(400).json({ error: buildConfigError });
    }
    if (!slug || typeof slug !== "string") {
      return res.status(400).json({ error: "slug is required." });
    }
    const normalizedSlug = normalizeSlug(slug);
    const slugError = validateSlug(normalizedSlug);
    if (slugError) {
      return res.status(400).json({ error: slugError });
    }

    const hasRepo = typeof repoUrl === "string" && repoUrl.trim().length > 0;
    const trimmedRepoUrl = hasRepo ? repoUrl.trim() : null;
    if (repoUrl !== undefined && !hasRepo) {
      return res.status(400).json({ error: "Invalid repoUrl." });
    }

    if (hasRepo && !isAdmin) {
      let project = await findProjectByRepo(req.user.id, trimmedRepoUrl);
      if (project) {
        const tenant = await getTenantByProjectId(project.id);
        if (tenant && tenant.slug !== normalizedSlug) {
          return res.status(409).json({ error: "Project already has a different slug." });
        }
        if (!tenant) {
          try {
            project.tenant = await ensureTenantForProject(project.id, normalizedSlug, routing);
            project.region = routing.region;
          } catch (error) {
            return res.status(409).json({ error: error?.message || "Tenant creation failed." });
          }
        } else {
          project.tenant = tenant;
        }
        if (branch && branch !== project.branch) {
          project.branch = branch;
        }
        if (hasBuildOverrides(buildConfigInput)) {
          project.settings = mergeBuildConfig(project.settings, buildConfigInput);
        }
        project = await saveProject(project);
        if (Array.isArray(envVars) && envVars.length > 0) {
          try {
            const normalizedEnvVars = normalizeProjectEnvVarInputs(envVars);
            await replaceProjectEnvVars(req.user.id, project.id, normalizedEnvVars);
          } catch (error) {
            return res
              .status(statusForEnvVarError(error))
              .json({ error: error?.message || "Failed to save env vars." });
          }
        }
        return res.status(200).json(projectToResponse(req, project));
      }
    }

    if (!isAdmin) {
      try {
        await enforceProjectLimit(req.user.id);
      } catch (error) {
        return res.status(409).json({ error: error?.message || "Project limit reached." });
      }
    }

    const resolvedBranch = hasRepo ? branch || "main" : null;
    let project = await createProject(
      req.user.id,
      { repoUrl: trimmedRepoUrl, branch: resolvedBranch },
      { settings: buildConfigInput, region: routing.region },
    );
    try {
      project.tenant = await ensureTenantForProject(project.id, normalizedSlug, routing);
      project.region = routing.region;
      if (Array.isArray(envVars) && envVars.length > 0) {
        const normalizedEnvVars = normalizeProjectEnvVarInputs(envVars);
        await replaceProjectEnvVars(req.user.id, project.id, normalizedEnvVars);
      }
    } catch (error) {
      await pool.query("delete from projects where id = $1", [project.id]);
      const msg = error?.message || "Project creation failed.";
      if (statusForEnvVarError(error, 400) === 500) {
        return res.status(500).json({ error: msg });
      }
      const code =
        msg.includes("required") || msg.includes("must") || msg.includes("max") ? 400 : 409;
      return res.status(code).json({ error: msg });
    }
    res.status(201).json(projectToResponse(req, project));
  });

  routes.patch("/projects/:id/settings", requireAuth, async (req, res) => {
    let project = await findProjectById(req.user.id, req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    const buildConfigInput = sanitizeBuildConfig(req.body);
    if (!hasBuildOverrides(buildConfigInput)) {
      return res.status(400).json({ error: "No build settings were provided." });
    }
    const buildConfigError = validateBuildConfigInput(buildConfigInput);
    if (buildConfigError) {
      return res.status(400).json({ error: buildConfigError });
    }
    project.settings = mergeBuildConfig(project.settings, buildConfigInput);
    project = await saveProject(project);
    project.tenant = await getTenantByProjectId(project.id);
    return res.json(projectToResponse(req, project));
  });

  routes.post("/projects/:id/delete", requireAuth, async (req, res) => {
    const providedConfirm = String(req.body?.confirm || "").trim();
    if (!providedConfirm) {
      return res.status(400).json({ error: "confirm is required." });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const projectRes = await client.query(
        `select id, user_id, repo_url
         from projects
         where id = $1 and user_id = $2
         for update`,
        [req.params.id, req.user.id],
      );
      const projectRow = projectRes.rows[0];
      if (!projectRow) {
        await client.query("rollback");
        return res.status(404).json({ error: "Unknown project." });
      }

      const tenantRes = await client.query(
        `select id, slug
         from tenants
         where project_id = $1
         limit 1`,
        [projectRow.id],
      );
      const tenantRow = tenantRes.rows[0] || null;
      const expectedConfirm = tenantRow?.slug || projectRow.id;
      if (providedConfirm !== expectedConfirm) {
        await client.query("rollback");
        return res.status(400).json({
          error: `Confirmation mismatch. Type exactly: ${expectedConfirm}`,
        });
      }

      const hasActiveDeployment = await hasProjectActiveDeployment(projectRow.id, client);
      if (hasActiveDeployment) {
        await client.query("rollback");
        return res.status(409).json({
          error: "Project has an active deployment. Wait for it to finish, then retry deletion.",
        });
      }

      if (tenantRow?.id) {
        await client.query(
          `update projects
           set tenant_id = null, updated_at = now()
           where id = $1`,
          [projectRow.id],
        );
        await client.query(
          `delete from tenants
           where project_id = $1`,
          [projectRow.id],
        );
      }

      const deletedProject = await client.query(
        `delete from projects
         where id = $1 and user_id = $2
         returning id, repo_url`,
        [projectRow.id, req.user.id],
      );
      if (!deletedProject.rows[0]) {
        throw new Error("Project delete failed.");
      }

      await client.query("commit");
      res.json({
        deleted: true,
        id: deletedProject.rows[0].id,
        repoUrl: deletedProject.rows[0].repo_url,
        slug: tenantRow?.slug ?? null,
      });
    } catch (error) {
      await client.query("rollback");
      logger.error(
        { err: error, projectId: req.params.id, userId: req.user.id },
        "Project deletion failed",
      );
      return res.status(500).json({
        error: "Couldn't delete project. Please retry.",
      });
    } finally {
      client.release();
    }
  });

  routes.get("/projects/:id/env-vars", requireAuth, async (req, res) => {
    const project = await findProjectById(req.user.id, req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    const includeValues = String(req.query?.includeValues ?? "false").toLowerCase() === "true";
    try {
      const vars = await listProjectEnvVars(project.id, { includeValues });
      res.json(vars);
    } catch (error) {
      logger.error({ error }, "Failed to list project env vars");
      res
        .status(statusForEnvVarError(error, 500))
        .json({ error: error?.message || "Failed to list env vars." });
    }
  });

  routes.post("/projects/:id/env-vars", requireAuth, async (req, res) => {
    const project = await findProjectById(req.user.id, req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    try {
      const normalized = normalizeProjectEnvVarInput(req.body ?? {});
      const saved = await upsertProjectEnvVar({
        userId: req.user.id,
        projectId: project.id,
        key: normalized.key,
        value: normalized.value,
        isSecret: normalized.isSecret,
      });
      res.status(201).json(saved);
    } catch (error) {
      res
        .status(statusForEnvVarError(error))
        .json({ error: error?.message || "Invalid env var payload." });
    }
  });

  routes.patch("/projects/:id/env-vars/:varId", requireAuth, async (req, res) => {
    const project = await findProjectById(req.user.id, req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    try {
      const updated = await patchProjectEnvVar({
        userId: req.user.id,
        projectId: project.id,
        envVarId: req.params.varId,
        input: req.body ?? {},
      });
      if (!updated) {
        return res.status(404).json({ error: "Env var not found." });
      }
      res.json(updated);
    } catch (error) {
      res
        .status(statusForEnvVarError(error))
        .json({ error: error?.message || "Failed to update env var." });
    }
  });

  routes.delete("/projects/:id/env-vars/:varId", requireAuth, async (req, res) => {
    const project = await findProjectById(req.user.id, req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    const deleted = await deleteProjectEnvVar(project.id, req.params.varId);
    if (!deleted) {
      return res.status(404).json({ error: "Env var not found." });
    }
    res.status(204).end();
  });

  routes.post("/projects/:id/env-vars/import", requireAuth, async (req, res) => {
    const project = await findProjectById(req.user.id, req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    try {
      const content = String(req.body?.content ?? "");
      if (!content) {
        return res.status(400).json({ error: "content is required." });
      }
      const preview = await buildEnvImportPreview(project.id, content);
      res.json(preview);
    } catch (error) {
      res.status(400).json({ error: error?.message || "Failed to parse .env content." });
    }
  });

  routes.post("/projects/:id/env-vars/import/commit", requireAuth, async (req, res) => {
    const project = await findProjectById(req.user.id, req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    try {
      const conflictPolicy =
        String(req.body?.conflictPolicy || "replace").toLowerCase() === "skip" ? "skip" : "replace";
      const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      const normalized = normalizeProjectEnvVarInputs(entries);
      const result = await commitEnvImport({
        userId: req.user.id,
        projectId: project.id,
        entries: normalized,
        conflictPolicy,
      });
      res.json(result);
    } catch (error) {
      res
        .status(statusForEnvVarError(error))
        .json({ error: error?.message || "Failed to import env vars." });
    }
  });

  routes.post("/projects/:id/deploy", requireAuth, async (req, res) => {
    const project = await findProjectById(req.user.id, req.params.id);
    if (!project) {
      return res.status(404).json({ error: "Unknown project" });
    }
    if (!project.repoUrl) {
      return res.status(409).json({ error: "Project has no repository connected." });
    }
    if (!(await enforceDeployRateLimits(req, res, req.user.id, project.id))) {
      return;
    }
    const branch = req.body?.branch ?? project.branch;
    let deployment;
    try {
      deployment = await triggerDeployment(project, {
        branch,
        source: "manual",
      });
    } catch (error) {
      if (replyDeploymentAdmissionError(res, error)) {
        return;
      }
      logger.error({ err: error, projectId: project.id }, "Manual deploy failed");
      return res.status(500).json({ error: error?.message || "Failed to start deployment." });
    }
    res.status(202).json(deployment);
  });

  routes.post("/eject", requireAuth, async (req, res) => {
    if (!EJECT_ENABLED) {
      return res.status(403).json({ error: "Eject is disabled in this environment." });
    }
    const { projectId, targetPrincipal, branch } = req.body ?? {};
    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({ error: "projectId is required." });
    }
    if (!targetPrincipal || typeof targetPrincipal !== "string") {
      return res.status(400).json({ error: "targetPrincipal is required." });
    }

    const project = await findProjectById(req.user.id, projectId);
    if (!project) {
      return res.status(404).json({ error: "Unknown project." });
    }
    if (!(await enforceDeployRateLimits(req, res, req.user.id, project.id))) {
      return;
    }
    const tenant = await getTenantByProjectId(project.id);
    if (!tenant) {
      return res.status(409).json({ error: "Tenant mapping required for eject." });
    }

    const ejectRequestId = randomUUID();
    await pool.query(
      `insert into eject_requests (id, tenant_id, status, target_principal, created_at)
       values ($1, $2, 'requested', $3, now())`,
      [ejectRequestId, tenant.id, targetPrincipal.trim()],
    );

    let deployment;
    try {
      deployment = await triggerDeployment(project, {
        branch: branch ?? project.branch,
        source: "eject",
        deployMode: "eject",
        metadata: {
          ejectRequestId,
          targetPrincipal: targetPrincipal.trim(),
        },
      });
    } catch (error) {
      if (replyDeploymentAdmissionError(res, error)) {
        await setEjectRequestStatus(ejectRequestId, "failed");
        return;
      }
      logger.error({ err: error, projectId: project.id }, "Eject deploy trigger failed");
      await setEjectRequestStatus(ejectRequestId, "failed");
      return res.status(500).json({ error: "Failed to start eject deployment." });
    }

    await setEjectRequestStatus(ejectRequestId, "running");

    res.status(202).json({
      ejectRequestId,
      deployment,
    });
  });

  routes.post("/deploy", requireAuth, async (req, res) => {
    const isAdmin = await isUserAdminEmail(req.user.email);
    const { repoUrl, branch = "main", slug } = req.body ?? {};
    let routing;
    try {
      routing = resolveRequestedProjectRouting(req.user, req.body ?? {});
    } catch (error) {
      return res
        .status(Number.isFinite(error?.statusCode) ? error.statusCode : 400)
        .json({ error: error?.message || "Invalid deployment region." });
    }
    const buildConfigInput = sanitizeBuildConfig(req.body);
    const buildConfigError = validateBuildConfigInput(buildConfigInput);
    if (buildConfigError) {
      return res.status(400).json({ error: buildConfigError });
    }
    if (!repoUrl || typeof repoUrl !== "string") {
      return res.status(400).json({ error: "Missing repoUrl" });
    }
    const trimmedRepoUrl = repoUrl.trim();
    if (!trimmedRepoUrl) {
      return res.status(400).json({ error: "Invalid repoUrl" });
    }
    if (!slug || typeof slug !== "string") {
      return res.status(400).json({ error: "slug is required." });
    }
    const normalizedSlug = normalizeSlug(slug);
    const slugError = validateSlug(normalizedSlug);
    if (slugError) {
      return res.status(400).json({ error: slugError });
    }
    if (!(await enforceDeployUserRateLimits(req, res, req.user.id))) {
      return;
    }

    let project;
    if (!isAdmin) {
      project = await findProjectByRepo(req.user.id, trimmedRepoUrl);
    }
    const createdNewProject = !project;
    if (!project) {
      if (!isAdmin) {
        try {
          await enforceProjectLimit(req.user.id);
        } catch (error) {
          return res.status(409).json({ error: error?.message || "Project limit reached." });
        }
      }
      project = await createProject(
        req.user.id,
        { repoUrl: trimmedRepoUrl, branch },
        { settings: buildConfigInput, region: routing.region },
      );
    }
    try {
      project.tenant = await ensureTenantForProject(project.id, normalizedSlug, routing);
      project.region = routing.region;
    } catch (error) {
      if (createdNewProject) {
        await pool.query("delete from projects where id = $1", [project.id]);
      }
      return res.status(409).json({ error: error?.message || "Tenant creation failed." });
    }
    if (hasBuildOverrides(buildConfigInput)) {
      project.settings = mergeBuildConfig(project.settings, buildConfigInput);
      project = await saveProject(project);
    }
    if (!(await enforceDeployProjectRateLimit(req, res, project.id))) {
      return;
    }
    let deployment;
    try {
      deployment = await triggerDeployment(project, {
        branch,
        source: "api",
      });
    } catch (error) {
      if (replyDeploymentAdmissionError(res, error)) {
        return;
      }
      logger.error({ err: error, projectId: project.id }, "API deploy failed");
      return res.status(500).json({ error: error?.message || "Failed to start deployment." });
    }
    res.status(202).json(deployment);
  });

  routes.get("/deployments", requireAuth, async (req, res) => {
    const items = await listDeployments(req.user.id);
    res.json(items);
  });

  routes.get("/notifications", requireAuth, async (req, res) => {
    const limitRaw = Number.parseInt(String(req.query?.limit ?? "20"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 100)) : 20;
    const unreadOnly = String(req.query?.unreadOnly ?? "false").toLowerCase() === "true";
    const items = await listNotifications(req.user.id, { limit, unreadOnly });
    res.json(items);
  });

  routes.post("/notifications/:id/read", requireAuth, async (req, res) => {
    const updated = await markNotificationRead(req.user.id, req.params.id);
    if (!updated) {
      return res.status(404).json({ error: "Notification not found." });
    }
    res.json(updated);
  });

  routes.post("/notifications/read-all", requireAuth, async (req, res) => {
    const count = await markAllNotificationsRead(req.user.id);
    res.json({ updated: count });
  });

  routes.delete("/notifications/:id", requireAuth, async (req, res) => {
    const deleted = await deleteNotification(req.user.id, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Notification not found." });
    }
    res.status(204).end();
  });

  routes.get("/admin/stats/overview", requireAuth, requireAdmin, async (req, res) => {
    const range = parseAnalyticsRange(req.query?.range);
    const data = await getAdminOverviewStats(range);
    res.json(data);
  });

  routes.get("/admin/stats/timeseries", requireAuth, requireAdmin, async (req, res) => {
    const range = parseAnalyticsRange(req.query?.range);
    const data = await getAdminTimeseriesStats(range);
    res.json(data);
  });

  routes.get("/admin/stats/canisters", requireAuth, requireAdmin, async (req, res) => {
    const range = parseAnalyticsRange(req.query?.range);
    const data = await getAdminCanisterStats(range);
    res.json(data);
  });

  routes.get("/admin/projects/deployed", requireAuth, requireAdmin, async (_req, res) => {
    const items = await listAdminDeployedProjects();
    res.json({ items });
  });

  routes.get("/admin/host-canisters", requireAuth, requireAdmin, async (_req, res) => {
    const items = await listAdminHostCanisters();
    res.json({ items });
  });

  routes.post("/admin/host-canisters", requireAuth, requireAdmin, async (req, res) => {
    const parsed = parseHostCanisterPayload(req.body ?? {}, { partial: false });
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    try {
      const item = await createHostCanister(parsed.value);
      return res.status(201).json(item);
    } catch (error) {
      if (error?.code === "23505") {
        return res.status(409).json({
          error: "Host canister alias or canister id already exists.",
        });
      }
      if (error?.code === "23514") {
        return res.status(400).json({ error: "Host canister format is invalid." });
      }
      logger.error({ err: error }, "Failed to create host canister");
      return res.status(500).json({ error: "Failed to create host canister." });
    }
  });

  routes.patch("/admin/host-canisters/:id", requireAuth, requireAdmin, async (req, res) => {
    const hostCanisterId = String(req.params?.id || "").trim();
    if (!UUID_PATTERN.test(hostCanisterId)) {
      return res.status(400).json({ error: "Invalid host canister id." });
    }
    const parsed = parseHostCanisterPayload(req.body ?? {}, { partial: true });
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    try {
      const item = await updateHostCanister(hostCanisterId, parsed.value);
      if (!item) {
        return res.status(404).json({ error: "Host canister not found." });
      }
      return res.json(item);
    } catch (error) {
      if (error?.code === "23505") {
        return res.status(409).json({
          error: "Host canister alias or canister id already exists.",
        });
      }
      if (error?.code === "23514") {
        return res.status(400).json({ error: "Host canister format is invalid." });
      }
      logger.error({ err: error }, "Failed to update host canister");
      return res.status(500).json({ error: "Failed to update host canister." });
    }
  });

  routes.get("/routing/canisters/:alias", async (req, res) => {
    const alias = normalizeHostCanisterAlias(req.params?.alias);
    if (!HOST_CANISTER_ALIAS_PATTERN.test(alias)) {
      return res.status(400).json({ error: "Invalid alias format." });
    }
    const item = await resolveHostCanisterAlias(alias);
    if (!item) {
      return res.status(404).json({ error: "Alias not found." });
    }
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json(item);
  });

  routes.post("/gitlab/webhook", async (req, res) => {
    const event = String(req.get("x-gitlab-event") || "")
      .trim()
      .toLowerCase();
    if (event && event !== "push hook" && event !== "system hook") {
      logger.debug({ event }, "Ignoring unsupported GitLab webhook event");
      return res.status(202).json({ acknowledged: true });
    }
    if (
      !(await enforceRequestRateLimits(req, res, [
        {
          key: rateLimitKey("gitlab", "webhook", "ip", getClientIp(req)),
          ...RATE_LIMIT_RULES.webhookPerIpMinute,
          label: "gitlab:webhook:ip",
        },
      ]))
    ) {
      return;
    }

    const payload = req.body ?? {};
    const gitlabProjectId = parseGitLabProjectId(payload.project?.id ?? payload.project_id);
    if (!gitlabProjectId) {
      return res.status(400).json({ error: "Webhook payload missing project id." });
    }

    const ref = String(payload.ref || "").trim();
    const pushedBranch = extractGitHeadBranchFromRef(ref);
    if (!pushedBranch) {
      return res.status(202).json({
        acknowledged: true,
        ignored: true,
        reason: "unsupported_ref",
      });
    }

    const projects = await findProjectsForGitLabWebhook({
      gitlabProjectId,
      branch: pushedBranch,
    });
    if (projects.length === 0) {
      return res.status(202).json({
        acknowledged: true,
        ignored: true,
        reason: "no_matching_projects",
      });
    }

    const providedToken = String(req.get("x-gitlab-token") || "").trim();
    if (!providedToken) {
      return res.status(401).json({ error: "Missing webhook token." });
    }

    const authorizedProjects = projects.filter((project) => {
      const expected = String(project.gitlab?.webhookSecret || "");
      return expected.length > 0 && verifyGitLabWebhookToken(providedToken, expected);
    });
    if (authorizedProjects.length === 0) {
      return res.status(401).json({ error: "Invalid webhook token." });
    }

    const repoUrl = payload.project?.git_http_url ?? null;
    const commit = payload.checkout_sha ?? payload.after ?? null;
    const metadata = {
      author: payload.user_username ?? null,
      message: payload.commits?.[0]?.message ?? null,
      gitlabProjectId,
    };

    const deploymentIds = [];
    const skipped = [];
    for (const project of authorizedProjects) {
      try {
        const deployment = await triggerDeployment(project, {
          branch: pushedBranch,
          repoUrlOverride: repoUrl || project.repoUrl,
          source: "gitlab:webhook",
          commit,
          metadata,
        });
        deploymentIds.push(deployment.id);
      } catch (error) {
        if (isDeploymentAdmissionError(error)) {
          skipped.push({
            projectId: project.id,
            reason: error.reason || "admission_rejected",
          });
          logger.info(
            {
              projectId: project.id,
              gitlabProjectId,
              reason: error.reason || "admission_rejected",
            },
            "Skipping GitLab webhook-triggered deployment due to admission control",
          );
          continue;
        }
        logger.error(
          {
            err: error,
            projectId: project.id,
            gitlabProjectId,
          },
          "GitLab webhook deployment trigger failed",
        );
      }
    }

    return res.status(202).json({
      acknowledged: true,
      deployments: deploymentIds,
      skipped,
    });
  });

  routes.post("/github/webhook", async (req, res) => {
    const event = req.get("x-github-event");
    if (event && event !== "push" && event !== "ping") {
      logger.debug({ event }, "Ignoring unsupported GitHub webhook event");
      return res.status(202).json({ acknowledged: true });
    }
    if (
      !(await enforceRequestRateLimits(req, res, [
        {
          key: rateLimitKey("github", "webhook", "ip", getClientIp(req)),
          ...RATE_LIMIT_RULES.webhookPerIpMinute,
          label: "github:webhook:ip",
        },
      ]))
    ) {
      return;
    }

    const raw = req.rawBody ?? JSON.stringify(req.body ?? {});
    const signature = req.get("x-hub-signature-256");
    if (!signature) {
      return res.status(401).json({ error: "Missing signature." });
    }
    if (!verifyGitHubSignature(signature, raw, githubAppWebhookSecret)) {
      return res.status(401).json({ error: "Invalid signature." });
    }
    const payload = req.body ?? {};
    const repoFullName = String(payload.repository?.full_name || "").trim();
    const installationId = Number.parseInt(String(payload.installation?.id || "").trim(), 10);
    if (!Number.isFinite(installationId) || !repoFullName) {
      return res.status(400).json({
        error: "Webhook payload missing installation id or repository identity.",
      });
    }

    if (event === "ping") {
      return res.status(202).json({ acknowledged: true, installationId });
    }

    const ref = String(payload.ref || "").trim();
    const pushedBranch = extractGitHeadBranchFromRef(ref);
    if (!pushedBranch) {
      return res.status(202).json({
        acknowledged: true,
        ignored: true,
        reason: "unsupported_ref",
      });
    }
    const repoUrl = payload.repository?.clone_url ?? null;
    const commit = payload.after ?? payload.head_commit?.id ?? null;
    const metadata = {
      author: payload.head_commit?.author?.name ?? null,
      message: payload.head_commit?.message ?? null,
      githubInstallationId: installationId,
      githubRepositoryId: payload.repository?.id ?? null,
    };

    const projects = await findProjectsForGitHubAppWebhook({
      installationId,
      repoFullName,
      branch: pushedBranch,
    });
    if (projects.length === 0) {
      return res.status(202).json({
        acknowledged: true,
        ignored: true,
        reason: "no_matching_projects",
      });
    }

    const deploymentIds = [];
    const skipped = [];
    for (const project of projects) {
      try {
        const deployment = await triggerDeployment(project, {
          branch: pushedBranch,
          repoUrlOverride: repoUrl || project.repoUrl,
          source: "github:webhook",
          commit,
          metadata,
        });
        deploymentIds.push(deployment.id);
      } catch (error) {
        if (isDeploymentAdmissionError(error)) {
          skipped.push({
            projectId: project.id,
            reason: error.reason || "admission_rejected",
          });
          logger.info(
            {
              projectId: project.id,
              installationId,
              repoFullName,
              reason: error.reason || "admission_rejected",
            },
            "Skipping webhook-triggered deployment due to admission control",
          );
          continue;
        }
        logger.error(
          {
            err: error,
            projectId: project.id,
            installationId,
            repoFullName,
          },
          "Failed to start deployment from GitHub App webhook",
        );
      }
    }
    res.status(202).json({
      acknowledged: true,
      deploymentIds,
      matchedProjects: projects.length,
      triggered: deploymentIds.length,
      skipped,
    });
  });

  app.use(apiErrorHandler(logger));
  if (!listen) return app;
  const port = process.env.PORT || 3000;
  return app.listen(port, () => {
    logger.info(`ICP deployer backend listening on :${port}`);
    if (useJobRunner) {
      startRunnerWorkspaceCleanupLoop();
    }
    startDeploymentQueueLoop();
  });
}
async function sessionMiddleware(req, res, next) {
  try {
    await attachSession(req, res);
    next();
  } catch (err) {
    next(err);
  }
}

async function attachSession(req, res) {
  const cookies = cookie.parse(req.headers?.cookie ?? "");
  const token = cookies[SESSION_COOKIE];
  if (!token) {
    return;
  }
  const session = await getSessionByToken(token);
  if (!session) {
    clearSessionCookie(res);
    return;
  }
  req.session = session;
  req.user = session.user;
  if (shouldRefreshSessionAdmin(session)) {
    const isAdmin = await isUserAdminEmail(session.user.email);
    const adminCheckedAt = Date.now();
    req.session.isAdmin = isAdmin;
    req.session.adminCheckedAt = adminCheckedAt;
    await pool.query("update sessions set is_admin = $2, admin_checked_at = now() where id = $1", [
      session.id,
      isAdmin,
    ]);
  }
  if (Date.now() - session.lastSeenAt > SESSION_TOUCH_MS) {
    await pool.query("update sessions set last_seen_at = now() where id = $1", [session.id]);
  }
}

function sessionMutationProtectionMiddleware(req, res, next) {
  if (!isMutatingMethod(req.method)) {
    return next();
  }
  if (CSRF_EXEMPT_PATHS.has(req.path)) {
    return next();
  }
  if (!req.user || !req.session) {
    return next();
  }

  const requestOrigin = getRequestOrigin(req);
  if (!requestOrigin || !isAllowedOrigin(requestOrigin)) {
    logger.warn(
      {
        path: req.path,
        method: req.method,
        userId: req.user.id,
        requestOrigin: requestOrigin || null,
      },
      "Rejected mutating session request due to disallowed origin",
    );
    return res.status(403).json({ error: "Origin not allowed." });
  }

  const cookies = cookie.parse(req.headers?.cookie ?? "");
  const csrfCookie = String(cookies[CSRF_COOKIE] || "").trim();
  const csrfHeader = String(req.get(CSRF_HEADER) || "").trim();
  if (!csrfCookie || !csrfHeader || !safeCompare(csrfCookie, csrfHeader)) {
    return res.status(403).json({ error: "Invalid CSRF token." });
  }
  const csrfHash = hashCsrfToken(csrfHeader);
  if (!req.session.csrfTokenHash || !safeCompare(req.session.csrfTokenHash, csrfHash)) {
    return res.status(403).json({ error: "Invalid CSRF token." });
  }
  return next();
}

function getRequestOrigin(req) {
  const origin = normalizeOriginValue(req.get("origin"));
  if (origin) {
    return origin;
  }
  const referer = String(req.get("referer") || "").trim();
  if (!referer) {
    return null;
  }
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function shouldRefreshSessionAdmin(session) {
  if (!session?.user?.email) {
    return false;
  }
  if (!Number.isFinite(session.adminCheckedAt)) {
    return true;
  }
  return Date.now() - session.adminCheckedAt >= SESSION_ADMIN_REFRESH_MS;
}

function isMutatingMethod(method) {
  const normalized = String(method || "").toUpperCase();
  return (
    normalized === "POST" ||
    normalized === "PUT" ||
    normalized === "PATCH" ||
    normalized === "DELETE"
  );
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  return next();
}

async function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  try {
    const isAdmin = await isUserAdminEmail(req.user.email);
    if (!isAdmin) {
      return res.status(403).json({ error: "Admin access required." });
    }
    req.isAdmin = true;
    return next();
  } catch (error) {
    return next(error);
  }
}

function normalizePlan(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase() === "pro"
    ? "pro"
    : "free";
}

function isActiveProSubscriptionStatus(status) {
  return ACTIVE_PRO_SUBSCRIPTION_STATUSES.has(
    String(status || "")
      .trim()
      .toLowerCase(),
  );
}

function isUserPro(user) {
  return (
    normalizePlan(user?.plan) === "pro" &&
    isActiveProSubscriptionStatus(user?.stripeSubscriptionStatus)
  );
}

function billingStateToResponse(user) {
  const status = user?.stripeSubscriptionStatus ?? null;
  const isPro = isUserPro(user);
  return {
    plan: isPro ? "pro" : "free",
    isPro,
    subscriptionStatus: status,
    currentPeriodEnd: user?.stripeCurrentPeriodEnd ?? null,
    cancelAtPeriodEnd: user?.stripeCancelAtPeriodEnd === true,
  };
}

function normalizeBillingInterval(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase() === "yearly"
    ? "yearly"
    : "monthly";
}

async function ensureStripeCustomerForUser(user) {
  const existing = String(user?.stripeCustomerId || "").trim();
  if (existing) {
    return existing;
  }
  const customer = await stripeClient.customers.create({
    email: user.email,
    metadata: { userId: user.id },
  });
  await pool.query(
    `update users
     set stripe_customer_id = $2,
         updated_at = now()
     where id = $1`,
    [user.id, customer.id],
  );
  user.stripeCustomerId = customer.id;
  return customer.id;
}

async function handleStripeWebhook(req, res) {
  if (!stripeClient || !stripeWebhookSecret) {
    return res.status(503).json({ error: "Stripe webhook is not configured." });
  }
  const signature = req.get("stripe-signature");
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(
      req.rawBody || JSON.stringify(req.body ?? {}),
      signature,
      stripeWebhookSecret,
    );
  } catch (error) {
    logger.warn({ err: error }, "Rejected Stripe webhook signature");
    return res.status(400).json({ error: "Invalid Stripe signature." });
  }

  const inserted = await pool.query(
    `insert into stripe_events (id, type, created_at)
     values ($1, $2, now())
     on conflict (id) do nothing`,
    [event.id, event.type],
  );
  if (inserted.rowCount === 0) {
    return res.json({ received: true, duplicate: true });
  }

  try {
    await processStripeEvent(event);
    return res.json({ received: true });
  } catch (error) {
    await pool.query("delete from stripe_events where id = $1", [event.id]).catch(() => {});
    logger.error(
      { err: error, stripeEventId: event.id, type: event.type },
      "Stripe webhook failed",
    );
    return res.status(500).json({ error: "Stripe webhook failed." });
  }
}

async function processStripeEvent(event) {
  const object = event?.data?.object;
  switch (event.type) {
    case "checkout.session.completed": {
      if (object?.mode !== "subscription" || !object?.subscription) {
        return;
      }
      const subscription = await stripeClient.subscriptions.retrieve(String(object.subscription));
      await syncStripeSubscription(subscription, {
        userId: object.client_reference_id || object.metadata?.userId || null,
        customerId: object.customer || null,
      });
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncStripeSubscription(object);
      return;
    default:
      return;
  }
}

async function syncStripeSubscription(subscription, fallback = {}) {
  if (!subscription?.id) {
    return;
  }
  const status = String(subscription.status || "")
    .trim()
    .toLowerCase();
  const active = isActiveProSubscriptionStatus(status);
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id || fallback.customerId || null;
  const rawMetadataUserId = subscription.metadata?.userId || fallback.userId || null;
  const metadataUserId =
    typeof rawMetadataUserId === "string" && UUID_PATTERN.test(rawMetadataUserId)
      ? rawMetadataUserId
      : null;
  const currentPeriodEnd = Number.isFinite(subscription.current_period_end)
    ? new Date(subscription.current_period_end * 1000)
    : null;
  const cancelAtPeriodEnd = subscription.cancel_at_period_end === true;
  const values = [
    active ? "pro" : "free",
    subscription.id,
    status || null,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    customerId,
    metadataUserId,
  ];
  const res = await pool.query(
    `update users
     set plan = $1,
         stripe_subscription_id = $2,
         stripe_subscription_status = $3,
         stripe_current_period_end = $4,
         stripe_cancel_at_period_end = $5,
         stripe_customer_id = coalesce(stripe_customer_id, $6),
         plan_updated_at = now(),
         updated_at = now()
     where ($7::uuid is not null and id = $7::uuid)
        or ($6::text is not null and stripe_customer_id = $6::text)
        or stripe_subscription_id = $2`,
    values,
  );
  if (res.rowCount === 0) {
    logger.warn(
      { subscriptionId: subscription.id, customerId, metadataUserId },
      "Stripe subscription did not match a local user",
    );
  }
}

async function getUserBillingState(userId) {
  const res = await pool.query(
    `select plan, stripe_subscription_status
     from users
     where id = $1
     limit 1`,
    [userId],
  );
  const row = res.rows[0];
  return {
    plan: normalizePlan(row?.plan),
    stripeSubscriptionStatus: row?.stripe_subscription_status ?? null,
  };
}

async function getProjectLimitForUser(userId) {
  const billing = await getUserBillingState(userId);
  return isUserPro(billing) ? PRO_PROJECT_LIMIT : FREE_PROJECT_LIMIT;
}

async function resolveDeploymentPriorityForUser(userId) {
  if (!userId) {
    return "normal";
  }
  const billing = await getUserBillingState(userId);
  return isUserPro(billing) ? "pro" : "normal";
}

async function getSessionByToken(token) {
  const tokenHash = hashSessionToken(token);
  const res = await pool.query(
    `select s.*,
            u.email,
            u.username,
            u.password_hash,
            u.password_set_by_user,
            u.avatar_url,
            u.display_name,
            u.onboarding_source,
            u.onboarding_completed_at,
            u.plan,
            u.stripe_customer_id,
            u.stripe_subscription_id,
            u.stripe_subscription_status,
            u.stripe_current_period_end,
            u.stripe_cancel_at_period_end,
            u.plan_updated_at
     from sessions s
     join users u on u.id = s.user_id
     where s.token_hash = $1`,
    [tokenHash],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  const expires = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expires) || expires < Date.now()) {
    await pool.query("delete from sessions where id = $1", [row.id]);
    return null;
  }
  return {
    id: row.id,
    user: {
      id: row.user_id,
      email: row.email,
      username: row.username ?? null,
      password_hash: row.password_hash,
      password_set_by_user: row.password_set_by_user !== false,
      avatar_url: row.avatar_url ?? null,
      display_name: row.display_name ?? null,
      onboarding_source: row.onboarding_source ?? null,
      onboarding_completed_at: row.onboarding_completed_at ?? null,
      plan: normalizePlan(row.plan),
      stripeCustomerId: row.stripe_customer_id ?? null,
      stripeSubscriptionId: row.stripe_subscription_id ?? null,
      stripeSubscriptionStatus: row.stripe_subscription_status ?? null,
      stripeCurrentPeriodEnd: toMillis(row.stripe_current_period_end),
      stripeCancelAtPeriodEnd: row.stripe_cancel_at_period_end === true,
      planUpdatedAt: toMillis(row.plan_updated_at),
    },
    csrfTokenHash: row.csrf_token_hash ?? null,
    isAdmin: row.is_admin === true,
    adminCheckedAt: toMillis(row.admin_checked_at),
    createdAt: toMillis(row.created_at),
    expiresAt: expires,
    lastSeenAt: toMillis(row.last_seen_at) ?? Date.now(),
  };
}

async function createSession(userId, options = {}) {
  const token = randomUUID();
  const csrfToken = generateCsrfToken();
  const tokenHash = hashSessionToken(token);
  const csrfTokenHash = hashCsrfToken(csrfToken);
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  const isAdmin =
    typeof options?.isAdmin === "boolean" ? options.isAdmin : await resolveSessionAdminFlag(userId);
  await pool.query(
    `insert into sessions (
        id, user_id, token_hash, csrf_token_hash, is_admin, admin_checked_at,
        created_at, expires_at, last_seen_at
      )
     values ($1, $2, $3, $4, $5, now(), now(), $6, now())`,
    [randomUUID(), userId, tokenHash, csrfTokenHash, isAdmin, expires],
  );
  return { token, csrfToken };
}

async function resolveSessionAdminFlag(userId) {
  if (!userId) {
    return false;
  }
  const res = await pool.query("select email from users where id = $1 limit 1", [userId]);
  const email = res.rows[0]?.email ?? null;
  if (!email) {
    return false;
  }
  return isUserAdminEmail(email);
}

function setSessionCookie(res, session) {
  appendSetCookie(
    res,
    cookie.serialize(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: SESSION_COOKIE_SAMESITE,
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
      secure: SESSION_COOKIE_SECURE,
      domain: SESSION_COOKIE_DOMAIN,
    }),
  );
  appendSetCookie(
    res,
    cookie.serialize(CSRF_COOKIE, session.csrfToken, {
      httpOnly: false,
      sameSite: SESSION_COOKIE_SAMESITE,
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
      secure: SESSION_COOKIE_SECURE,
      domain: CSRF_COOKIE_DOMAIN,
    }),
  );
}

function clearSessionCookie(res) {
  appendSetCookie(
    res,
    cookie.serialize(SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: SESSION_COOKIE_SAMESITE,
      path: "/",
      maxAge: 0,
      secure: SESSION_COOKIE_SECURE,
      domain: SESSION_COOKIE_DOMAIN,
    }),
  );
  appendSetCookie(
    res,
    cookie.serialize(CSRF_COOKIE, "", {
      httpOnly: false,
      sameSite: SESSION_COOKIE_SAMESITE,
      path: "/",
      maxAge: 0,
      secure: SESSION_COOKIE_SECURE,
      domain: CSRF_COOKIE_DOMAIN,
    }),
  );
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function generateCsrfToken() {
  return randomBytes(32).toString("base64url");
}

function hashCsrfToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function appendSetCookie(res, serializedCookie) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", [serializedCookie]);
    return;
  }
  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, serializedCookie]);
    return;
  }
  res.setHeader("Set-Cookie", [String(current), serializedCookie]);
}

function normalizeEmail(email) {
  if (!email || typeof email !== "string") {
    return null;
  }
  const trimmed = email.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 80);
}

function normalizeUsername(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 80);
}

function normalizeOnboardingSource(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 120);
}

function isSyntheticUserEmail(email) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized && normalized.endsWith("@users.noreply.a3icp.local"));
}

function resolveUserDisplayName(user, githubIdentity, githubInstallation, gitlabIdentity = null) {
  const stored = normalizeDisplayName(user?.display_name);
  if (stored) {
    return stored;
  }
  const githubName = normalizeDisplayName(githubIdentity?.name);
  if (githubName) {
    return githubName;
  }
  const githubLogin = normalizeDisplayName(githubIdentity?.login);
  if (githubLogin) {
    return githubLogin;
  }
  const installLogin = normalizeDisplayName(githubInstallation?.accountLogin);
  if (installLogin) {
    return installLogin;
  }
  const gitlabName = normalizeDisplayName(gitlabIdentity?.name);
  if (gitlabName) {
    return gitlabName;
  }
  const gitlabLogin = normalizeDisplayName(gitlabIdentity?.username);
  if (gitlabLogin) {
    return gitlabLogin;
  }
  const email = normalizeEmail(user?.email);
  if (!email) {
    return null;
  }
  if (isSyntheticUserEmail(email)) {
    return "New user";
  }
  const emailPrefix = email.split("@")[0];
  return normalizeDisplayName(emailPrefix);
}

function isUserOnboardingRequired(user) {
  return (
    !normalizeDisplayName(user?.display_name) ||
    !normalizeUsername(user?.username) ||
    user?.password_set_by_user === false
  );
}

async function getUserByEmail(email) {
  const res = await pool.query("select * from users where lower(email) = lower($1) limit 1", [
    email,
  ]);
  return res.rows[0] ?? null;
}

async function getUserByUsername(username) {
  const res = await pool.query("select * from users where lower(username) = lower($1) limit 1", [
    username,
  ]);
  return res.rows[0] ?? null;
}

async function getUserById(id) {
  const res = await pool.query("select * from users where id = $1", [id]);
  return res.rows[0] ?? null;
}

async function getGitHubIdentityByUserId(userId) {
  const res = await pool.query(
    `select user_id, github_user_id, login, name, avatar_url, updated_at
     from user_github_identities
     where user_id = $1
     limit 1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    userId: row.user_id,
    githubUserId: Number(row.github_user_id),
    login: row.login,
    name: row.name ?? null,
    avatarUrl: row.avatar_url ?? null,
    updatedAt: toMillis(row.updated_at),
  };
}

async function getGitHubIdentityByGithubUserId(githubUserId) {
  const parsedGithubUserId = Number.parseInt(String(githubUserId || "").trim(), 10);
  if (!Number.isFinite(parsedGithubUserId)) {
    return null;
  }
  const res = await pool.query(
    `select user_id, github_user_id, login, name, avatar_url, updated_at
     from user_github_identities
     where github_user_id = $1
     limit 1`,
    [parsedGithubUserId],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    userId: row.user_id,
    githubUserId: Number(row.github_user_id),
    login: row.login,
    name: row.name ?? null,
    avatarUrl: row.avatar_url ?? null,
    updatedAt: toMillis(row.updated_at),
  };
}

async function upsertGitHubIdentity({
  userId,
  githubUserId,
  login,
  name = null,
  avatarUrl = null,
}) {
  const parsedGithubUserId = Number.parseInt(String(githubUserId || "").trim(), 10);
  if (!Number.isFinite(parsedGithubUserId)) {
    throw new Error("Invalid GitHub user id.");
  }
  await pool.query(
    `insert into user_github_identities
      (user_id, github_user_id, login, name, avatar_url, created_at, updated_at)
     values ($1, $2, $3, $4, $5, now(), now())
     on conflict (user_id) do update set
       github_user_id = excluded.github_user_id,
       login = excluded.login,
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       updated_at = now()`,
    [userId, parsedGithubUserId, login, name, avatarUrl],
  );
}

async function isUserAdminEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }
  const res = await pool.query(
    "select 1 from admin_allowlist_emails where lower(email) = lower($1) limit 1",
    [normalized],
  );
  return Boolean(res.rows[0]);
}

function normalizeGitHubRepoKey(input) {
  const normalized = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");
  return GITHUB_REPO_FULL_NAME_PATTERN.test(normalized) ? normalized : null;
}

function normalizeMultilineSecret(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function readEnvOrDefault(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { name, value: raw, fallback },
      "Invalid positive integer env var. Using fallback.",
    );
    return fallback;
  }
  return parsed;
}

function loadGitHubAppPrivateKey(raw) {
  if (!raw) {
    return null;
  }
  const normalized = normalizeMultilineSecret(raw).trim();
  if (!normalized) {
    return null;
  }
  try {
    return createPrivateKey(normalized);
  } catch (error) {
    logger.error({ error }, "Failed to parse GITHUB_APP_PRIVATE_KEY_PEM");
    return null;
  }
}

function isGitHubAppConfigured() {
  return Boolean(
    githubAppId &&
    githubAppSlug &&
    githubAppPrivateKey &&
    githubAppWebhookSecret &&
    githubAppStateSecret,
  );
}

function isGitHubUserAuthConfigured() {
  return Boolean(githubAppClientId && githubAppClientSecret && githubAppStateSecret);
}

function getGitHubAuthConfigSummary() {
  return {
    hasClientId: Boolean(githubAppClientId),
    hasClientSecret: Boolean(githubAppClientSecret),
    hasStateSecret: Boolean(githubAppStateSecret),
    hasAppId: Boolean(githubAppId),
    hasAppSlug: Boolean(githubAppSlug),
    hasPrivateKey: Boolean(githubAppPrivateKey),
    hasWebhookSecret: Boolean(githubAppWebhookSecret),
  };
}

function redirectToFrontendAuthError(req, res, errorCode) {
  const frontendBaseUrl = getFrontendBaseUrl(req);
  const target = new URL("/", frontendBaseUrl);
  target.searchParams.set("authError", String(errorCode || "auth_failed"));
  return res.redirect(target.toString());
}

function logOAuthAuthInit(
  req,
  { provider, intent, result, userId = null, redirectUri = null } = {},
) {
  logger.info(
    {
      provider: provider || "unknown",
      intent: intent || "unknown",
      result: result || "unknown",
      origin: normalizeOriginValue(req.get("origin")),
      referer: String(req.get("referer") || "").trim() || null,
      ip: getClientIp(req),
      userId,
      redirectUri,
    },
    "OAuth auth-init event",
  );
}

function toBase64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return buffer.toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function parseGitHubAppInstallationId(value) {
  return positiveId(value);
}

function parseGitHubRepoId(value) {
  return positiveId(value);
}

function normalizeTemplateRepoName(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return null;
  }
  return TEMPLATE_REPO_NAME_PATTERN.test(raw) ? raw : null;
}

function getTemplateById(templateId) {
  const normalizedId = String(templateId || "")
    .trim()
    .toLowerCase();
  if (!normalizedId) {
    return null;
  }
  return (
    TEMPLATE_CATALOG.find(
      (template) => String(template.id).trim().toLowerCase() === normalizedId,
    ) || null
  );
}

function templateCatalogToResponse() {
  return TEMPLATE_CATALOG.map((template) => ({
    id: template.id,
    name: template.name,
    providerSource: template.providerSource,
    defaultBuildConfig: mergeBuildConfig(DEFAULT_BUILD_CONFIG, template.defaultBuildConfig || {}),
  }));
}

function buildGitHubTemplateGenerateUrl(sourceUrl, repoName, ownerLogin = null) {
  try {
    const url = new URL(String(sourceUrl || "").trim());
    url.pathname = `${String(url.pathname || "").replace(/\/+$/, "")}/generate`;
    const normalizedRepoName = normalizeTemplateRepoName(repoName);
    if (normalizedRepoName) {
      url.searchParams.set("name", normalizedRepoName);
    }
    const normalizedOwner = String(ownerLogin || "").trim();
    if (normalizedOwner) {
      url.searchParams.set("owner", normalizedOwner);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isTemplateReuseConflict(error) {
  return Boolean(
    error?.code === "23505" &&
    String(error?.constraint || "") === "projects_user_template_unique_idx",
  );
}

function createGitHubAppJwt() {
  if (!isGitHubAppConfigured()) {
    throw new Error("GitHub App is not configured.");
  }
  const iat = Math.floor(Date.now() / 1000) - 30;
  const exp = iat + GITHUB_APP_JWT_TTL_SECONDS;
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      iat,
      exp,
      iss: githubAppId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = signData("RSA-SHA256", Buffer.from(unsigned, "utf8"), githubAppPrivateKey);
  return `${unsigned}.${toBase64Url(signature)}`;
}

function normalizeGitHubAppInstallOnboardingIntent(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "connect-repo" ? normalized : null;
}

function normalizeGitHubAppInstallTargetTab(value, fallback = "github") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "overview" || normalized === "github" || normalized === "profile") {
    return normalized;
  }
  return fallback;
}

function signGitHubAppInstallState({
  userId,
  issuedAtMs,
  onboarding = null,
  provider = "github",
  targetTab = "github",
}) {
  const normalizedOnboarding = normalizeGitHubAppInstallOnboardingIntent(onboarding);
  const normalizedProvider = normalizeGitProvider(provider);
  const normalizedTargetTab = normalizeGitHubAppInstallTargetTab(
    targetTab,
    normalizedOnboarding === "connect-repo" ? "overview" : "github",
  );
  const payload = JSON.stringify({
    v: 1,
    userId: String(userId || ""),
    issuedAtMs,
    onboarding: normalizedOnboarding,
    provider: normalizedProvider,
    targetTab: normalizedTargetTab,
    nonce: randomUUID(),
  });
  const payloadB64 = toBase64Url(payload);
  const signature = createHmac("sha256", githubAppStateSecret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${signature}`;
}

function verifyGitHubAppInstallState(state) {
  const [payloadB64, providedSig] = String(state || "").split(".");
  if (!payloadB64 || !providedSig) {
    return null;
  }
  const expectedSig = createHmac("sha256", githubAppStateSecret)
    .update(payloadB64)
    .digest("base64url");
  if (!safeCompare(providedSig, expectedSig)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fromBase64Url(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || parsed.v !== 1 || !parsed.userId || !parsed.issuedAtMs) {
    return null;
  }
  if (Date.now() - Number(parsed.issuedAtMs) > GITHUB_APP_STATE_TTL_MS) {
    return null;
  }
  const onboarding = normalizeGitHubAppInstallOnboardingIntent(parsed.onboarding);
  const provider = normalizeGitProvider(parsed.provider);
  const targetTab = normalizeGitHubAppInstallTargetTab(
    parsed.targetTab,
    onboarding === "connect-repo" ? "overview" : "github",
  );
  return {
    userId: String(parsed.userId),
    issuedAtMs: Number(parsed.issuedAtMs),
    onboarding,
    provider,
    targetTab,
  };
}

function signGitHubOAuthState({ intent, userId = null, issuedAtMs }) {
  const normalizedIntent = String(intent || "")
    .trim()
    .toLowerCase();
  if (normalizedIntent !== "login" && normalizedIntent !== "link") {
    throw new Error(`Unsupported GitHub OAuth intent "${intent}".`);
  }
  const payload = JSON.stringify({
    v: 1,
    intent: normalizedIntent,
    userId: userId ? String(userId) : null,
    issuedAtMs,
    nonce: randomUUID(),
  });
  const payloadB64 = toBase64Url(payload);
  const signature = createHmac("sha256", githubAppStateSecret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${signature}`;
}

function verifyGitHubOAuthState(state) {
  const [payloadB64, providedSig] = String(state || "").split(".");
  if (!payloadB64 || !providedSig) {
    return null;
  }
  const expectedSig = createHmac("sha256", githubAppStateSecret)
    .update(payloadB64)
    .digest("base64url");
  if (!safeCompare(providedSig, expectedSig)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fromBase64Url(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    !parsed.issuedAtMs ||
    (parsed.intent !== "login" && parsed.intent !== "link")
  ) {
    return null;
  }
  if (Date.now() - Number(parsed.issuedAtMs) > GITHUB_OAUTH_STATE_TTL_MS) {
    return null;
  }
  return {
    intent: parsed.intent,
    userId: parsed.userId ? String(parsed.userId) : null,
    issuedAtMs: Number(parsed.issuedAtMs),
  };
}

async function githubApiFetch(endpoint, options = {}) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://api.github.com/${endpoint.replace(/^\//, "")}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "icp-deployer-mvp",
    ...(options.headers || {}),
  };
  return fetch(url, {
    ...options,
    headers,
  });
}

async function githubAppApiFetch(endpoint, options = {}) {
  const jwt = createGitHubAppJwt();
  const headers = {
    Authorization: `Bearer ${jwt}`,
    ...options.headers,
  };
  return githubApiFetch(endpoint, { ...options, headers });
}

async function exchangeGitHubOAuthCodeForToken({ code, redirectUri }) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: githubAppClientId,
      client_secret: githubAppClientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload?.access_token) {
    throw new Error(
      `GitHub token exchange failed (${res.status}): ${payload?.error_description || payload?.error || "unknown error"}`,
    );
  }
  return String(payload.access_token);
}

async function getGitHubOAuthUser(accessToken) {
  const res = await githubApiFetch("user", {
    headers: { Authorization: `token ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to fetch GitHub user profile (${res.status}). ${body.slice(0, 300)}`);
  }
  const payload = await res.json();
  if (!payload?.id || !payload?.login) {
    throw new Error("GitHub profile payload is missing required fields.");
  }
  return {
    id: Number(payload.id),
    login: String(payload.login),
    name: payload.name ? String(payload.name) : null,
    avatarUrl: payload.avatar_url ? String(payload.avatar_url) : null,
    email: normalizeEmail(payload.email),
  };
}

async function getGitHubOAuthVerifiedEmail(accessToken, fallbackEmail = null) {
  const res = await githubApiFetch("user/emails", {
    headers: { Authorization: `token ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 403 || res.status === 404) {
      logger.warn(
        { status: res.status },
        "GitHub email endpoint is not accessible; falling back to profile email field",
      );
      return normalizeEmail(fallbackEmail);
    }
    throw new Error(`Failed to fetch GitHub emails (${res.status}). ${body.slice(0, 300)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return normalizeEmail(fallbackEmail);
  }
  const preferred =
    rows.find((item) => item?.verified && item?.primary) || rows.find((item) => item?.verified);
  return normalizeEmail(preferred?.email || fallbackEmail);
}

async function createGitHubInstallationToken(
  installationId,
  { userId, repositoryId = null, readOnly = false } = {},
) {
  if (!userId) throw new HttpError(403, "GitHub user authorization is required.");
  await requireGitHubInstallationAccess(userId, installationId);
  const parsedInstallationId = parseGitHubAppInstallationId(installationId);
  if (!parsedInstallationId) {
    throw new Error("Invalid GitHub App installation id.");
  }
  const res = await githubAppApiFetch(`app/installations/${parsedInstallationId}/access_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(repositoryId ? { repository_ids: [repositoryId] } : {}),
      ...(readOnly ? { permissions: { contents: "read", metadata: "read" } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to mint GitHub installation token (status ${res.status}). ${body.slice(0, 300)}`,
    );
  }
  const payload = await res.json();
  const token = String(payload?.token || "");
  if (!token) {
    throw new Error("GitHub App installation token response is missing token.");
  }
  return token;
}

async function storeGitHubUserToken(userId, accessToken) {
  const ciphertext = await encryptEnvVarSecret(accessToken, {
    projectId: userId,
    key: "GITHUB_USER_ACCESS_TOKEN",
  });
  await pool.query(
    `insert into user_github_oauth_accounts(user_id, access_token_ciphertext)
    values ($1, $2) on conflict (user_id) do update set
    access_token_ciphertext = excluded.access_token_ciphertext, updated_at = now()`,
    [userId, ciphertext],
  );
}

async function loadGitHubUserToken(userId) {
  const result = await pool.query(
    "select access_token_ciphertext from user_github_oauth_accounts where user_id = $1",
    [userId],
  );
  if (!result.rows[0]) throw new HttpError(403, "Reconnect GitHub to verify installation access.");
  return decryptEnvVarSecret(result.rows[0].access_token_ciphertext, {
    projectId: userId,
    key: "GITHUB_USER_ACCESS_TOKEN",
  });
}

async function requireGitHubInstallationAccess(userId, installationId) {
  const accessToken = await loadGitHubUserToken(userId);
  const installation = await verifyUserInstallation({
    apiFetch: githubApiFetch,
    accessToken,
    installationId,
    appId: githubAppId,
  });
  return {
    installationId: Number(installation.id),
    accountId: installation.account?.id ?? null,
    accountLogin: installation.account?.login ?? null,
    accountType: installation.account?.type ?? null,
  };
}

async function getGitHubAppInstallation(installationId) {
  const parsedInstallationId = parseGitHubAppInstallationId(installationId);
  if (!parsedInstallationId) {
    return null;
  }
  const res = await githubAppApiFetch(`app/installations/${parsedInstallationId}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to fetch GitHub installation ${parsedInstallationId} (status ${res.status}). ${body.slice(0, 300)}`,
    );
  }
  const payload = await res.json();
  return {
    installationId: parsedInstallationId,
    accountId: payload?.account?.id ?? null,
    accountLogin: payload?.account?.login ?? null,
    accountType: payload?.account?.type ?? null,
  };
}

async function upsertGitHubAppInstallation({
  userId,
  installationId,
  accountId,
  accountLogin,
  accountType,
}) {
  await requireGitHubInstallationAccess(userId, installationId);
  const res = await pool.query(
    `insert into github_app_installations (
       id,
       user_id,
       installation_id,
       account_id,
       account_login,
       account_type,
       created_at,
       updated_at,
       last_seen_at
     ) values ($1, $2, $3, $4, $5, $6, now(), now(), now())
     on conflict (user_id, installation_id)
     do update set
       account_id = excluded.account_id,
       account_login = excluded.account_login,
       account_type = excluded.account_type,
       updated_at = now(),
       last_seen_at = now()
     returning *`,
    [randomUUID(), userId, installationId, accountId, accountLogin, accountType],
  );
  return mapGitHubAppInstallationRow(res.rows[0]);
}

function mapGitHubAppInstallationRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    userId: row.user_id,
    installationId: Number(row.installation_id),
    accountId: row.account_id == null ? null : Number(row.account_id),
    accountLogin: row.account_login ?? null,
    accountType: row.account_type ?? null,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
    lastSeenAt: toMillis(row.last_seen_at),
  };
}

async function getLatestGitHubInstallationForUser(userId) {
  const res = await pool.query(
    `select *
     from github_app_installations
     where user_id = $1
     order by updated_at desc, created_at desc
     limit 1`,
    [userId],
  );
  return mapGitHubAppInstallationRow(res.rows[0]);
}

async function listGitHubAppInstallations(userId) {
  const res = await pool.query(
    `select *
     from github_app_installations
     where user_id = $1
     order by updated_at desc, created_at desc`,
    [userId],
  );
  return res.rows.map(mapGitHubAppInstallationRow);
}

async function unlinkGitHubAppInstallation(userId, installationId) {
  const parsedInstallationId = parseGitHubAppInstallationId(installationId);
  if (!parsedInstallationId) {
    return false;
  }
  const res = await pool.query(
    `delete from github_app_installations
     where user_id = $1 and installation_id = $2`,
    [userId, parsedInstallationId],
  );
  return (res.rowCount ?? 0) > 0;
}

async function listGitHubReposForInstallation(userId, installationId) {
  await requireGitHubInstallationAccess(userId, installationId);
  const accessToken = await loadGitHubUserToken(userId);
  const rows = await userInstallationRepositories({
    apiFetch: githubApiFetch,
    accessToken,
    installationId,
  });
  return rows.map((repo) => ({
    id: Number(repo.id),
    fullName: repo.full_name,
    defaultBranch: repo.default_branch || null,
    private: Boolean(repo.private),
    installationId: Number(installationId),
    cloneUrl: repo.clone_url || null,
    provider: "github",
  }));
}

async function listGitHubAppReposForUser(userId) {
  const installations = await listGitHubAppInstallations(userId);
  if (!installations.length) {
    return [];
  }
  const byRepoInstallation = new Map();
  for (const installation of installations) {
    let repos;
    try {
      repos = await listGitHubReposForInstallation(userId, installation.installationId);
    } catch (error) {
      logger.warn(
        {
          err: error,
          userId,
          installationId: installation.installationId,
        },
        "Skipping GitHub installation during repo list due to API error",
      );
      continue;
    }
    for (const repo of repos) {
      const key = `${repo.installationId}:${String(repo.fullName || "").toLowerCase()}`;
      if (!byRepoInstallation.has(key)) {
        byRepoInstallation.set(key, repo);
      }
    }
  }
  return Array.from(byRepoInstallation.values()).sort((a, b) =>
    String(a.fullName || "").localeCompare(String(b.fullName || "")),
  );
}

async function findGitHubAppRepoForUser(
  userId,
  { repoFullName, repoId = null, installationId = null } = {},
) {
  const normalizedRepoFullName = normalizeGitHubRepoKey(repoFullName);
  const parsedRepoId = parseGitHubRepoId(repoId);
  const parsedInstallationId = parseGitHubAppInstallationId(installationId);
  if (!normalizedRepoFullName && !parsedRepoId) {
    throw new Error("Either repo full name or repo id is required.");
  }

  const repos = await listGitHubAppReposForUser(userId);
  const match = repos.find((repo) => {
    if (parsedInstallationId && Number(repo.installationId) !== parsedInstallationId) {
      return false;
    }
    if (parsedRepoId && Number(repo.id) !== parsedRepoId) {
      return false;
    }
    if (
      normalizedRepoFullName &&
      normalizeGitHubRepoKey(repo.fullName) !== normalizedRepoFullName
    ) {
      return false;
    }
    return true;
  });
  if (!match) {
    throw new Error("Repository is not accessible via linked GitHub App installations.");
  }
  return match;
}

function normalizeGitProvider(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === "gitlab"
    ? "gitlab"
    : "github";
}

function normalizeGitLabRepoPath(input) {
  const normalized = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  return GITLAB_REPO_PATH_PATTERN.test(normalized) ? normalized : null;
}

function parseGitLabProjectId(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGitLabBaseUrl(raw) {
  try {
    const parsed = new URL(String(raw || "https://gitlab.com").trim());
    const protocol = parsed.protocol === "https:" ? parsed.protocol : "https:";
    return `${protocol}//${parsed.host}`;
  } catch {
    return "https://gitlab.com";
  }
}

function isGitLabHostScopeSupported() {
  try {
    const parsed = new URL(gitlabBaseUrl);
    return parsed.host.toLowerCase() === "gitlab.com";
  } catch {
    return false;
  }
}

function parseEmailAllowlist(raw) {
  const set = new Set();
  for (const item of String(raw || "").split(/[,\n]/)) {
    const email = normalizeEmail(item);
    if (email) {
      set.add(email);
    }
  }
  return set;
}

function isGitLabAuthConfigured() {
  return Boolean(gitlabClientId && gitlabClientSecret && gitlabStateSecret);
}

function isGitLabEmailAllowlisted(email) {
  if (gitlabBetaAllowlist.size === 0) {
    return true;
  }
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }
  return gitlabBetaAllowlist.has(normalized);
}

function isGitLabAuthEnabledForSession(user) {
  if (!gitlabEnabled || !isGitLabAuthConfigured() || !isGitLabHostScopeSupported()) {
    return false;
  }
  if (!user) {
    return true;
  }
  return isGitLabEmailAllowlisted(user.email);
}

function signGitLabOAuthState({ intent, userId = null, issuedAtMs }) {
  const normalizedIntent = String(intent || "")
    .trim()
    .toLowerCase();
  if (normalizedIntent !== "login" && normalizedIntent !== "link") {
    throw new Error(`Unsupported GitLab OAuth intent "${intent}".`);
  }
  const payload = JSON.stringify({
    v: 1,
    intent: normalizedIntent,
    userId: userId ? String(userId) : null,
    issuedAtMs,
    nonce: randomUUID(),
  });
  const payloadB64 = toBase64Url(payload);
  const signature = createHmac("sha256", gitlabStateSecret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

function verifyGitLabOAuthState(state) {
  const [payloadB64, providedSig] = String(state || "").split(".");
  if (!payloadB64 || !providedSig) {
    return null;
  }
  const expectedSig = createHmac("sha256", gitlabStateSecret)
    .update(payloadB64)
    .digest("base64url");
  if (!safeCompare(providedSig, expectedSig)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fromBase64Url(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    !parsed.issuedAtMs ||
    (parsed.intent !== "login" && parsed.intent !== "link")
  ) {
    return null;
  }
  if (Date.now() - Number(parsed.issuedAtMs) > GITLAB_OAUTH_STATE_TTL_MS) {
    return null;
  }
  return {
    intent: parsed.intent,
    userId: parsed.userId ? String(parsed.userId) : null,
    issuedAtMs: Number(parsed.issuedAtMs),
  };
}

async function gitlabApiFetch(endpoint, options = {}) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : new URL(`/api/v4/${endpoint.replace(/^\//, "")}`, gitlabBaseUrl).toString();
  const headers = {
    Accept: "application/json",
    "User-Agent": "icp-deployer-mvp",
    ...(options.headers || {}),
  };
  return fetch(url, {
    ...options,
    headers,
  });
}

async function exchangeGitLabOAuthCodeForToken({ code, redirectUri }) {
  const tokenUrl = new URL("/oauth/token", gitlabBaseUrl).toString();
  const params = new URLSearchParams({
    client_id: gitlabClientId,
    client_secret: gitlabClientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload?.access_token) {
    throw new Error(
      `GitLab token exchange failed (${res.status}): ${payload?.error_description || payload?.error || "unknown error"}`,
    );
  }
  return {
    accessToken: String(payload.access_token),
    scope: payload.scope ? String(payload.scope) : null,
    tokenType: payload.token_type ? String(payload.token_type) : null,
  };
}

async function getGitLabOAuthUser(accessToken) {
  const res = await gitlabApiFetch("user", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to fetch GitLab user profile (${res.status}). ${body.slice(0, 300)}`);
  }
  const payload = await res.json();
  if (!payload?.id || !payload?.username) {
    throw new Error("GitLab profile payload is missing required fields.");
  }
  return {
    id: Number(payload.id),
    username: String(payload.username),
    name: payload.name ? String(payload.name) : null,
    avatarUrl: payload.avatar_url ? String(payload.avatar_url) : null,
    email: normalizeEmail(payload.email || payload.public_email),
  };
}

async function getGitLabOAuthVerifiedEmail(accessToken, fallbackEmail = null) {
  const res = await gitlabApiFetch("user/emails", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 403 || res.status === 404) {
      logger.warn(
        { status: res.status },
        "GitLab email endpoint is not accessible; falling back to profile email field",
      );
      return normalizeEmail(fallbackEmail);
    }
    throw new Error(`Failed to fetch GitLab emails (${res.status}). ${body.slice(0, 300)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return normalizeEmail(fallbackEmail);
  }
  const preferred =
    rows.find((item) => item?.confirmed_at && item?.is_primary) ||
    rows.find((item) => item?.confirmed_at) ||
    rows.find((item) => item?.email);
  return normalizeEmail(preferred?.email || fallbackEmail);
}

async function getGitLabIdentityByUserId(userId) {
  const res = await pool.query(
    `select user_id, gitlab_user_id, username, name, avatar_url, updated_at
     from user_gitlab_identities
     where user_id = $1
     limit 1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    userId: row.user_id,
    gitlabUserId: Number(row.gitlab_user_id),
    username: row.username,
    name: row.name ?? null,
    avatarUrl: row.avatar_url ?? null,
    updatedAt: toMillis(row.updated_at),
  };
}

async function getGitLabIdentityByGitLabUserId(gitlabUserId) {
  const parsedGitLabUserId = parseGitLabProjectId(gitlabUserId);
  if (!parsedGitLabUserId) {
    return null;
  }
  const res = await pool.query(
    `select user_id, gitlab_user_id, username, name, avatar_url, updated_at
     from user_gitlab_identities
     where gitlab_user_id = $1
     limit 1`,
    [parsedGitLabUserId],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    userId: row.user_id,
    gitlabUserId: Number(row.gitlab_user_id),
    username: row.username,
    name: row.name ?? null,
    avatarUrl: row.avatar_url ?? null,
    updatedAt: toMillis(row.updated_at),
  };
}

async function upsertGitLabIdentity({
  userId,
  gitlabUserId,
  username,
  name = null,
  avatarUrl = null,
}) {
  const parsedGitLabUserId = parseGitLabProjectId(gitlabUserId);
  if (!parsedGitLabUserId) {
    throw new Error("Invalid GitLab user id.");
  }
  await pool.query(
    `insert into user_gitlab_identities
      (user_id, gitlab_user_id, username, name, avatar_url, created_at, updated_at)
     values ($1, $2, $3, $4, $5, now(), now())
     on conflict (user_id) do update set
       gitlab_user_id = excluded.gitlab_user_id,
       username = excluded.username,
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       updated_at = now()`,
    [userId, parsedGitLabUserId, username, name, avatarUrl],
  );
}

function createGitLabAccountMissingError(message = "GitLab account is not connected.") {
  const error = new Error(message);
  error.name = "GitLabAccountMissingError";
  return error;
}

async function upsertGitLabAccountToken({ userId, accessToken, scope = null, tokenType = null }) {
  if (!accessToken) {
    throw new Error("GitLab access token is required.");
  }
  const accessTokenCiphertext = await encryptEnvVarSecret(accessToken, {
    projectId: userId,
    key: "gitlab_oauth_token",
  });
  await pool.query(
    `insert into gitlab_accounts
      (user_id, access_token_ciphertext, scope, token_type, created_at, updated_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (user_id) do update set
       access_token_ciphertext = excluded.access_token_ciphertext,
       scope = excluded.scope,
       token_type = excluded.token_type,
       updated_at = now()`,
    [userId, accessTokenCiphertext, scope, tokenType],
  );
}

async function getGitLabAccountToken(userId) {
  const res = await pool.query(
    `select user_id, access_token_ciphertext, scope, token_type, updated_at
     from gitlab_accounts
     where user_id = $1
     limit 1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  let accessToken;
  try {
    accessToken = await decryptEnvVarSecret(row.access_token_ciphertext, {
      projectId: userId,
      key: "gitlab_oauth_token",
    });
  } catch (error) {
    logger.error({ err: error, userId }, "Failed to decrypt GitLab OAuth token");
    return null;
  }
  return {
    userId: row.user_id,
    accessToken,
    scope: row.scope ?? null,
    tokenType: row.token_type ?? null,
    updatedAt: toMillis(row.updated_at),
  };
}

async function deleteGitLabAccount(userId) {
  await pool.query("delete from gitlab_accounts where user_id = $1", [userId]);
}

async function listGitLabReposForUser(userId) {
  const account = await getGitLabAccountToken(userId);
  if (!account?.accessToken) {
    throw createGitLabAccountMissingError();
  }
  const repos = [];
  const byId = new Map();
  let page = 1;
  while (page <= 10) {
    const endpoint = `projects?membership=true&simple=true&per_page=100&page=${page}&order_by=last_activity_at&sort=desc`;
    const res = await gitlabApiFetch(endpoint, {
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Failed to list GitLab repositories (status ${res.status}). ${body.slice(0, 300)}`,
      );
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) {
      break;
    }
    for (const repo of rows) {
      const id = parseGitLabProjectId(repo?.id);
      const pathWithNamespace = normalizeGitLabRepoPath(repo?.path_with_namespace);
      if (!id || !pathWithNamespace) {
        continue;
      }
      if (byId.has(id)) {
        continue;
      }
      const item = {
        id,
        fullName: pathWithNamespace,
        pathWithNamespace,
        defaultBranch: repo.default_branch || null,
        private: String(repo.visibility || "").toLowerCase() === "private",
        cloneUrl: repo.http_url_to_repo || null,
        provider: "gitlab",
      };
      byId.set(id, item);
      repos.push(item);
    }
    if (rows.length < 100) {
      break;
    }
    page += 1;
  }
  return repos.sort((a, b) =>
    String(a.pathWithNamespace || "").localeCompare(String(b.pathWithNamespace || "")),
  );
}

async function findGitLabRepoForUser(userId, { pathWithNamespace = null, projectId = null } = {}) {
  const normalizedPath = normalizeGitLabRepoPath(pathWithNamespace);
  const parsedProjectId = parseGitLabProjectId(projectId);
  if (!normalizedPath && !parsedProjectId) {
    throw new Error("Either GitLab repository path or project id is required.");
  }
  const repos = await listGitLabReposForUser(userId);
  const match = repos.find((repo) => {
    if (parsedProjectId && Number(repo.id) !== parsedProjectId) {
      return false;
    }
    if (normalizedPath && normalizeGitLabRepoPath(repo.pathWithNamespace) !== normalizedPath) {
      return false;
    }
    return true;
  });
  if (!match) {
    throw new Error("Repository is not accessible via linked GitLab account.");
  }
  return match;
}

async function waitForGitLabTemplateImport({
  accessToken,
  projectId,
  timeoutMs = TEMPLATE_GITLAB_IMPORT_TIMEOUT_MS,
  pollMs = TEMPLATE_GITLAB_IMPORT_POLL_MS,
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await gitlabApiFetch(`projects/${encodeURIComponent(String(projectId))}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Failed to check GitLab import status (status ${res.status}). ${body.slice(0, 300)}`,
      );
    }
    const payload = await res.json();
    const importStatus = String(payload?.import_status || "none").toLowerCase();

    if (importStatus === "finished" || importStatus === "none") {
      return {
        id: parseGitLabProjectId(payload?.id),
        pathWithNamespace: normalizeGitLabRepoPath(payload?.path_with_namespace),
        defaultBranch: payload?.default_branch || "main",
        cloneUrl:
          payload?.http_url_to_repo ||
          (payload?.path_with_namespace
            ? `https://gitlab.com/${payload.path_with_namespace}.git`
            : null),
        private: String(payload?.visibility || "").toLowerCase() !== "public",
      };
    }
    if (importStatus === "failed") {
      throw new Error("GitLab template import failed.");
    }
    await wait(pollMs);
  }
  throw new Error(`GitLab template import timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
}

async function createGitLabRepoFromTemplate({
  userId,
  templateSourceGitUrl,
  repoName,
  privateRepo = true,
}) {
  const normalizedRepoName = normalizeTemplateRepoName(repoName);
  if (!normalizedRepoName) {
    throw new Error(
      "Repository name may only include letters, numbers, dashes, dots, and underscores.",
    );
  }
  const account = await getGitLabAccountToken(userId);
  if (!account?.accessToken) {
    throw createGitLabAccountMissingError();
  }
  const path = normalizedRepoName.toLowerCase().replace(/\.+/g, "-");
  const res = await gitlabApiFetch("projects", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: normalizedRepoName,
      path,
      visibility: privateRepo ? "private" : "public",
      import_url: String(templateSourceGitUrl || "").trim(),
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errorMessage =
      payload?.message || `GitLab template provisioning failed (status ${res.status}).`;
    throw new Error(typeof errorMessage === "string" ? errorMessage : JSON.stringify(errorMessage));
  }
  const projectId = parseGitLabProjectId(payload?.id);
  if (!projectId) {
    throw new Error("GitLab did not return a valid project id.");
  }
  const imported = await waitForGitLabTemplateImport({
    accessToken: account.accessToken,
    projectId,
  });
  if (!imported?.id || !imported.pathWithNamespace) {
    throw new Error("GitLab template import did not produce a valid repository.");
  }
  return imported;
}

async function createGitLabProjectWebhook({ userId, gitlabProjectId, webhookUrl, webhookSecret }) {
  const parsedGitLabProjectId = parseGitLabProjectId(gitlabProjectId);
  if (!parsedGitLabProjectId) {
    throw new Error("Invalid GitLab project id.");
  }
  if (!webhookUrl) {
    throw new Error("GitLab webhook URL is required.");
  }
  if (!webhookSecret) {
    throw new Error("GitLab webhook secret is required.");
  }

  const account = await getGitLabAccountToken(userId);
  if (!account?.accessToken) {
    throw createGitLabAccountMissingError();
  }
  const endpoint = `projects/${encodeURIComponent(parsedGitLabProjectId)}/hooks`;
  const payload = {
    url: webhookUrl,
    push_events: true,
    enable_ssl_verification: true,
    token: webhookSecret,
  };
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    "Content-Type": "application/json",
  };
  const res = await gitlabApiFetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    const body = await res.json();
    return {
      id: parseGitLabProjectId(body?.id),
      url: String(body?.url || webhookUrl),
    };
  }

  if (res.status === 400 || res.status === 409 || res.status === 422) {
    const hooksRes = await gitlabApiFetch(endpoint, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });
    if (hooksRes.ok) {
      const hooks = await hooksRes.json();
      if (Array.isArray(hooks)) {
        const existing = hooks.find(
          (hook) => String(hook?.url || "").trim() === String(webhookUrl).trim(),
        );
        if (existing) {
          return {
            id: parseGitLabProjectId(existing.id),
            url: String(existing.url || webhookUrl),
          };
        }
      }
    }
  }

  const body = await res.text().catch(() => "");
  throw new Error(`Failed to create GitLab webhook (status ${res.status}). ${body.slice(0, 300)}`);
}

function loadDeployTicketPrivateKey(raw) {
  if (!raw) {
    return null;
  }
  const normalized = normalizeMultilineSecret(raw).trim();
  if (!normalized) {
    return null;
  }
  try {
    const privateKey = createPrivateKey(normalized);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      logger.error(
        { keyType: privateKey.asymmetricKeyType },
        "DEPLOY_TICKET_PRIVATE_KEY_PEM must be an Ed25519 private key.",
      );
      return null;
    }
    return privateKey;
  } catch (error) {
    logger.error({ error }, "Failed to parse DEPLOY_TICKET_PRIVATE_KEY_PEM");
    return null;
  }
}

function buildDeployTicketCanonicalPayload({
  keyId,
  deploymentId,
  projectId,
  hostCanisterId,
  slug,
  issuedAtMs,
  expiresAtMs,
  nonce,
}) {
  return [
    DEPLOY_TICKET_VERSION,
    keyId,
    deploymentId,
    projectId,
    hostCanisterId,
    slug,
    String(issuedAtMs),
    String(expiresAtMs),
    nonce,
  ].join("|");
}

function parseDeployTicketStateOutput(output) {
  const raw = String(output || "");
  const enforceMatch = /enforce_deploy_ticket\s*=\s*(true|false)/i.exec(raw);
  if (!enforceMatch) {
    throw new Error("Unable to parse enforce_deploy_ticket from canister state.");
  }
  const keyIdsBlockMatch = /key_ids\s*=\s*vec\s*\{([^}]*)\}/is.exec(raw);
  const keyIds = [];
  if (keyIdsBlockMatch?.[1]) {
    for (const match of keyIdsBlockMatch[1].matchAll(/"([^"]+)"/g)) {
      keyIds.push(match[1]);
    }
  }
  return {
    enforceDeployTicket: enforceMatch[1].toLowerCase() === "true",
    keyIds,
  };
}

async function assertHostedDeployTicketGuardrail({
  deploymentId,
  projectId,
  hostCanisterId,
  network,
}) {
  if (!deployTicketEnabled) {
    return;
  }
  if (!hostCanisterId) {
    throw new Error("Hosted deployment is missing host canister id.");
  }
  if (!deployTicketKeyIdRaw) {
    throw new Error("DEPLOY_TICKET_KEY_ID must be configured for hosted deployments.");
  }

  const args = [
    "canister",
    "call",
    hostCanisterId,
    "get_deploy_ticket_state",
    "()",
    "--query",
    "--network",
    network,
  ];

  let parsedState;
  try {
    const rawState = await execDfxCommand(args, {
      // Guardrail checks should not depend on a mounted runtime identity in backend pods.
      env: {
        DFX_IDENTITY: "default",
        DEPLOY_IDENTITY_NAME: "default",
      },
    });
    parsedState = parseDeployTicketStateOutput(rawState);
  } catch (error) {
    const context = {
      deploymentId: deploymentId ?? null,
      projectId,
      hostCanisterId,
      network,
    };
    if (deployTicketGuardrailStrict) {
      logger.error({ err: error, ...context }, "Failed deploy-ticket guardrail preflight check");
      throw new Error(
        `Unable to verify deploy ticket enforcement on host canister ${hostCanisterId}.`,
        { cause: error },
      );
    }
    logger.warn(
      {
        err: error,
        ...context,
      },
      "Deploy-ticket guardrail preflight check failed (non-blocking mode)",
    );
    return;
  }

  if (!parsedState.enforceDeployTicket) {
    const context = {
      deploymentId: deploymentId ?? null,
      projectId,
      hostCanisterId,
      network,
    };
    if (deployTicketGuardrailStrict) {
      logger.error(context, "Hosted deployment blocked: deploy-ticket enforcement is disabled");
      throw new Error(
        "Hosted deployment blocked: deploy-ticket enforcement is disabled on host canister.",
      );
    }
    logger.warn(
      context,
      "Deploy-ticket enforcement is disabled on host canister (non-blocking mode)",
    );
    return;
  }
  if (!parsedState.keyIds.includes(deployTicketKeyIdRaw)) {
    const context = {
      deploymentId: deploymentId ?? null,
      projectId,
      hostCanisterId,
      network,
      requiredKeyId: deployTicketKeyIdRaw,
      configuredKeyIds: parsedState.keyIds,
    };
    if (deployTicketGuardrailStrict) {
      logger.error(context, "Hosted deployment blocked: deploy-ticket verifier key is missing");
      throw new Error(
        `Hosted deployment blocked: deploy-ticket verifier key "${deployTicketKeyIdRaw}" is not configured on host canister.`,
      );
    }
    logger.warn(
      {
        ...context,
      },
      "Deploy-ticket verifier key missing on host canister (non-blocking mode)",
    );
  }
}

function buildDeployTicketForDeployment(deployment) {
  if (!deployTicketEnabled) {
    return null;
  }
  if (!deployTicketKeyIdRaw || !deployTicketPrivateKey) {
    throw new Error(
      "Deploy ticket signing is not configured. Set DEPLOY_TICKET_KEY_ID and DEPLOY_TICKET_PRIVATE_KEY_PEM.",
    );
  }
  const slug = String(deployment?.metadata?.projectSlug || "")
    .trim()
    .toLowerCase();
  const hostCanisterId = String(deployment?.metadata?.hostCanisterId || "").trim();
  if (!slug || !hostCanisterId) {
    throw new Error(
      "Deploy ticket generation requires deployment metadata projectSlug and hostCanisterId.",
    );
  }
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + deployTicketTtlMs;
  const nonce = randomUUID();
  const payload = buildDeployTicketCanonicalPayload({
    keyId: deployTicketKeyIdRaw,
    deploymentId: deployment.id,
    projectId: deployment.projectId,
    hostCanisterId,
    slug,
    issuedAtMs,
    expiresAtMs,
    nonce,
  });
  const signature = signData(null, Buffer.from(payload, "utf8"), deployTicketPrivateKey);
  return {
    payload,
    signatureB64: signature.toString("base64"),
    keyId: deployTicketKeyIdRaw,
    expiresAtMs,
  };
}
async function findProjectByRepo(userId, repoUrl) {
  const res = await pool.query(
    "select * from projects where user_id = $1 and repo_url = $2 limit 1",
    [userId, repoUrl],
  );
  return mapProjectRow(res.rows[0]);
}

async function countProjectsForUser(userId) {
  const res = await pool.query("select count(*)::int as count from projects where user_id = $1", [
    userId,
  ]);
  return res.rows[0]?.count ?? 0;
}

async function countConnectedReposForUser(userId) {
  const res = await pool.query(
    `select count(*)::int as count
     from projects
     where user_id = $1
       and repo_url is not null
       and length(trim(repo_url)) > 0`,
    [userId],
  );
  const count = Number.parseInt(String(res.rows[0]?.count ?? 0), 10);
  return Number.isFinite(count) ? count : 0;
}

async function findProjectByTemplateId(userId, templateId) {
  const normalizedTemplateId = String(templateId || "")
    .trim()
    .toLowerCase();
  if (!normalizedTemplateId) {
    return null;
  }
  const res = await pool.query(
    `select *
     from projects
     where user_id = $1
       and lower(coalesce(template_id, '')) = $2
     order by updated_at desc
     limit 1`,
    [userId, normalizedTemplateId],
  );
  return mapProjectRow(res.rows[0]);
}

async function enforceProjectLimit(userId) {
  const count = await countProjectsForUser(userId);
  const limit = await getProjectLimitForUser(userId);
  if (count >= limit) {
    throw new Error(`Project limit reached. Max allowed is ${limit}.`);
  }
}

async function hasProjectActiveDeployment(projectId, queryable = pool) {
  const db = queryable && typeof queryable.query === "function" ? queryable : pool;
  const res = await db.query(
    `select 1
     from deployments
     where project_id = $1 and status = any($2::text[])
     limit 1`,
    [projectId, ACTIVE_DEPLOYMENT_STATUSES],
  );
  return Boolean(res.rows[0]);
}

function createDeploymentAdmissionError({ statusCode, reason, message, retryAfterSeconds = null }) {
  const error = new Error(message);
  error.name = "DeploymentAdmissionError";
  error.deploymentAdmission = true;
  error.statusCode = statusCode;
  error.reason = reason;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    error.retryAfterSeconds = Math.trunc(retryAfterSeconds);
  }
  return error;
}

function isDeploymentAdmissionError(error) {
  return Boolean(error?.deploymentAdmission);
}

function mapDeploymentInsertError(error) {
  if (error?.code !== "23505") {
    return null;
  }
  if (error.constraint === "deployments_active_project_unique_idx") {
    return createDeploymentAdmissionError({
      statusCode: 409,
      reason: "project_active",
      message: "Another deployment is already active for this project.",
    });
  }
  if (error.constraint === "deployments_active_host_canister_unique_idx") {
    return createDeploymentAdmissionError({
      statusCode: 409,
      reason: "host_canister_busy",
      message: "Host canister is busy with another active deployment.",
    });
  }
  return null;
}

function replyDeploymentAdmissionError(res, error) {
  if (!isDeploymentAdmissionError(error)) {
    return false;
  }
  if (Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0) {
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
  }
  res
    .status(Number.isFinite(error.statusCode) && error.statusCode >= 400 ? error.statusCode : 409)
    .json({ error: error.message || "Deployment admission rejected." });
  return true;
}

function startDeploymentQueueLoop() {
  if (deploymentQueueTimer) {
    return;
  }
  const runCycle = () => {
    void runDeploymentQueueCycle().catch((error) => {
      logger.error({ err: error }, "Deployment queue cycle failed");
    });
  };
  runCycle();
  deploymentQueueTimer = setInterval(runCycle, DEPLOY_QUEUE_POLL_INTERVAL_MS);
  if (typeof deploymentQueueTimer.unref === "function") {
    deploymentQueueTimer.unref();
  }
}

async function runDeploymentQueueCycle() {
  if (deploymentQueueCycleRunning) {
    return;
  }
  deploymentQueueCycleRunning = true;
  try {
    await failTimedOutProcessingDeployments();
    let dispatchBudget =
      DEPLOY_MAX_ACTIVE_DEPLOYMENTS > 0
        ? DEPLOY_MAX_ACTIVE_DEPLOYMENTS - (await countProcessingDeployments())
        : 32;
    if (!Number.isFinite(dispatchBudget) || dispatchBudget <= 0) {
      return;
    }
    while (dispatchBudget > 0) {
      const claimed = await claimNextQueuedDeployment();
      if (!claimed) {
        break;
      }
      dispatchBudget -= 1;
      logger.info(
        {
          event: "processing_start",
          deploymentId: claimed.id,
          projectId: claimed.projectId,
          assignedHostCanisterId: claimed.assignedHostCanisterId ?? null,
          priority: claimed.priority,
        },
        "Deployment queue claimed item",
      );
      void processQueuedDeployment(claimed).catch((error) => {
        logger.error(
          { err: error, deploymentId: claimed.id },
          "Queued deployment processing failed",
        );
      });
    }
  } finally {
    deploymentQueueCycleRunning = false;
  }
}

async function countProcessingDeployments() {
  const res = await pool.query(
    `select count(*)::int as count
     from deployments
     where status = 'processing'`,
  );
  const count = Number.parseInt(String(res.rows[0]?.count ?? 0), 10);
  return Number.isFinite(count) ? count : 0;
}

async function claimNextQueuedDeployment() {
  try {
    const res = await pool.query(
      `with candidate as (
       select ranked.id
       from (
         select d.id,
                d.queue_enqueued_at,
                d.created_at,
                case
                  when lower(coalesce(d.priority, 'normal')) = 'enterprise' then 0
                  when lower(coalesce(d.priority, 'normal')) = 'normal'
                    and row_number() over (
                      partition by coalesce(d.assigned_host_canister_id, '__global__'),
                                   case when lower(coalesce(d.priority, 'normal')) = 'normal' then 1 else 0 end
                      order by d.queue_enqueued_at asc, d.created_at asc, d.id asc
                    ) = 1 then 1
                  when lower(coalesce(d.priority, 'normal')) = 'pro' then 2
                  else 3
                end as bounded_priority_rank
         from deployments d
         where d.status = 'queued'
           and (
             d.assigned_host_canister_id is null
             or not exists (
               select 1
               from deployments p
               where p.status = 'processing'
                 and p.assigned_host_canister_id = d.assigned_host_canister_id
             )
           )
       ) ranked
       order by
         ranked.bounded_priority_rank asc,
         ranked.queue_enqueued_at asc,
         ranked.created_at asc,
         ranked.id asc
       limit 1
     )
     update deployments d
     set status = 'processing',
         started_at = coalesce(d.started_at, now()),
         processing_started_at = coalesce(d.processing_started_at, now()),
         processing_deadline_at = now() + ($1::int * interval '1 millisecond')
     from candidate
     where d.id = candidate.id
       and d.status = 'queued'
     returning d.*`,
      [DEPLOY_PROCESSING_TIMEOUT_MS],
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    await pool.query(
      `update projects set
          last_deployment_status = 'processing',
          last_deployment_identity = $3,
          updated_at = now()
        where id = $1 and last_deployment_id = $2`,
      [row.project_id, row.id, row.identity ?? null],
    );
    return mapDeploymentRow(row);
  } catch (error) {
    if (error?.code === "23505") {
      return null;
    }
    throw error;
  }
}

async function failTimedOutProcessingDeployments() {
  const res = await pool.query(
    `select *
     from deployments
     where status = 'processing'
       and coalesce(
         processing_deadline_at,
         processing_started_at + ($1::int * interval '1 millisecond')
       ) <= now()
     order by processing_deadline_at asc nulls last, started_at asc nulls last
     limit 25`,
    [DEPLOY_PROCESSING_TIMEOUT_MS],
  );
  for (const row of res.rows) {
    const deployment = mapDeploymentRow(row);
    const finishedAt = Date.now();
    await appendLog(
      deployment,
      `Queue timeout: deployment exceeded ${Math.ceil(
        DEPLOY_PROCESSING_TIMEOUT_MS / 60000,
      )} minutes and was failed automatically.`,
    );
    await setStatus(deployment, {
      status: "failed",
      finishedAt,
      durationMs:
        deployment.startedAt && Number.isFinite(deployment.startedAt)
          ? finishedAt - deployment.startedAt
          : undefined,
    });
    logger.warn(
      {
        event: "processing_timeout",
        deploymentId: deployment.id,
        projectId: deployment.projectId,
        assignedHostCanisterId: deployment.assignedHostCanisterId ?? null,
      },
      "Deployment queue timed out processing deployment",
    );
  }
}

async function processQueuedDeployment(deployment) {
  try {
    const project = await getProjectById(deployment.projectId);
    if (!project) {
      throw new Error("Project no longer exists for queued deployment.");
    }
    const deployMode = resolveDeployModeForDeployment(deployment);
    if (deployMode === "hosted") {
      await assertHostedDeployTicketGuardrail({
        deploymentId: deployment.id,
        projectId: deployment.projectId,
        hostCanisterId:
          deployment.assignedHostCanisterId || deployment.metadata?.hostCanisterId || null,
        network: deployment.network || process.env.ICP_NETWORK || "local",
      });
    }
    const deploymentEnv = await prepareDeploymentEnv(project, deployment);
    await runDeployment(deployment, deployMode, deploymentEnv);
  } catch (error) {
    logger.error(
      {
        err: error,
        deploymentId: deployment.id,
        projectId: deployment.projectId,
      },
      "Queued deployment failed before completion",
    );
    await appendLog(deployment, `Queue processor failed: ${error?.message || error}`);
    const finishedAt = Date.now();
    await setStatus(deployment, {
      status: "failed",
      finishedAt,
      durationMs:
        deployment.startedAt && Number.isFinite(deployment.startedAt)
          ? finishedAt - deployment.startedAt
          : undefined,
    });
  } finally {
    if (deployment.status === "processing") {
      const finishedAt = Date.now();
      await setStatus(deployment, {
        status: "failed",
        finishedAt,
        durationMs:
          deployment.startedAt && Number.isFinite(deployment.startedAt)
            ? finishedAt - deployment.startedAt
            : undefined,
      });
    }
    void runDeploymentQueueCycle().catch((error) => {
      logger.error({ err: error }, "Failed to continue deployment queue cycle");
    });
  }
}

export async function prepareDeploymentEnv(project, deployment) {
  const customerEnv = validateCustomerEnv(await loadProjectDeploymentEnv(project.id));
  const result = { customerEnv };
  const provider = normalizeGitProvider(deployment.metadata?.gitProvider || project.gitProvider);
  if (provider === "github" && project.github?.installationId) {
    const repo = await findGitHubAppRepoForUser(project.userId, {
      repoFullName: project.github.fullName,
      repoId: project.github.repoId,
      installationId: project.github.installationId,
    });
    result.githubInstallationToken = await createGitHubInstallationToken(repo.installationId, {
      userId: project.userId,
      repositoryId: repo.id,
      readOnly: true,
    });
  }
  if (provider === "gitlab") {
    const account = await getGitLabAccountToken(project.userId);
    if (!account?.accessToken) throw new HttpError(403, "Reconnect GitLab before deploying.");
    result.gitlabOAuthToken = account.accessToken;
  }
  return result;
}

function resolveDeployModeForDeployment(deployment) {
  const raw = String(deployment?.metadata?.deployMode || "")
    .trim()
    .toLowerCase();
  if (raw === "hosted" || raw === "eject") {
    return raw;
  }
  return resolveDeployModeType();
}

async function findProjectById(userId, id) {
  const res = await pool.query("select * from projects where user_id = $1 and id = $2 limit 1", [
    userId,
    id,
  ]);
  return mapProjectRow(res.rows[0]);
}

async function getProjectById(id) {
  const res = await pool.query("select * from projects where id = $1 limit 1", [id]);
  return mapProjectRow(res.rows[0]);
}

async function findProjectsForGitHubAppWebhook({ installationId, repoFullName, branch }) {
  const parsedInstallationId = parseGitHubAppInstallationId(installationId);
  const normalizedRepoFullName = normalizeGitHubRepoKey(repoFullName);
  const normalizedBranch = String(branch || "").trim();
  if (!parsedInstallationId || !normalizedRepoFullName || !normalizedBranch) {
    return [];
  }
  const res = await pool.query(
    `select *
     from projects
     where git_provider = 'github'
       and github_installation_id = $1
       and lower(github_full_name) = $2
       and branch = $3
     order by updated_at desc
     limit 100`,
    [parsedInstallationId, normalizedRepoFullName, normalizedBranch],
  );
  return res.rows.map((row) => mapProjectRow(row));
}

async function findProjectsForGitLabWebhook({ gitlabProjectId, branch }) {
  const parsedGitLabProjectId = parseGitLabProjectId(gitlabProjectId);
  const normalizedBranch = String(branch || "").trim();
  if (!parsedGitLabProjectId || !normalizedBranch) {
    return [];
  }
  const res = await pool.query(
    `select *
     from projects
     where git_provider = 'gitlab'
       and gitlab_project_id = $1
       and branch = $2
     order by updated_at desc
     limit 100`,
    [parsedGitLabProjectId, normalizedBranch],
  );
  return res.rows.map((row) => mapProjectRow(row));
}

async function listProjects(userId) {
  const res = await pool.query(
    `select p.*, to_jsonb(d.*) as last_deployment,
        t.id as tenant_id,
        t.slug as tenant_slug,
        t.domain_mode as tenant_domain_mode,
        hc.canister_id as tenant_host_canister_id,
        hc.alias as tenant_host_canister_alias,
        hc.region as tenant_host_canister_region,
        hc.visibility as tenant_host_canister_visibility
     from projects p
     left join deployments d on d.id = p.last_deployment_id
     left join tenants t on t.id = p.tenant_id
     left join tenant_hosts th on th.tenant_id = t.id
     left join host_canisters hc on hc.id = th.host_canister_id
     where p.user_id = $1
     order by p.updated_at desc`,
    [userId],
  );
  return res.rows.map((row) => mapProjectRow(row));
}

async function createProject(userId, { repoUrl, branch }, extras = {}) {
  const now = Date.now();
  const settings = mergeBuildConfig(DEFAULT_BUILD_CONFIG, sanitizeBuildConfig(extras.settings));
  const project = {
    id: randomUUID(),
    userId,
    repoUrl: repoUrl ?? null,
    branch: branch ?? null,
    gitProvider: extras.gitProvider ?? "github",
    templateId:
      typeof extras.templateId === "string" && extras.templateId.trim().length > 0
        ? extras.templateId.trim().toLowerCase()
        : null,
    templateName:
      typeof extras.templateName === "string" && extras.templateName.trim().length > 0
        ? extras.templateName.trim()
        : null,
    identity: extras.identity ?? defaultIdentity,
    github: extras.github ?? null,
    gitlab: extras.gitlab ?? null,
    settings,
    region: normalizeHostCanisterRegion(extras.region || "global"),
    webhookToken: generateToken(),
    createdAt: now,
    updatedAt: now,
    lastDeploymentId: null,
    lastDeploymentStatus: null,
    lastDeploymentEndpoint: null,
    lastDeploymentCanisterId: null,
    lastDeploymentIdentity: null,
  };
  await pool.query(
    `insert into projects (
        id, user_id, repo_url, branch, settings, identity, webhook_token,
        github_owner, github_repo, github_full_name, github_default_branch,
        github_webhook_id, github_webhook_secret, github_installation_id, github_repo_id,
        git_provider, gitlab_project_id, gitlab_path_with_namespace, gitlab_webhook_id, gitlab_webhook_secret,
        template_id, template_name,
        region,
        created_at, updated_at,
        last_deployment_id, last_deployment_status, last_deployment_endpoint,
        last_deployment_canister_id, last_deployment_identity
      )
      values (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22,
        $23,
        to_timestamp($24/1000.0), to_timestamp($25/1000.0),
        $26, $27, $28, $29, $30
      )`,
    [
      project.id,
      project.userId,
      project.repoUrl,
      project.branch,
      project.settings,
      project.identity,
      project.webhookToken,
      project.github?.owner ?? null,
      project.github?.repo ?? null,
      project.github?.fullName ?? null,
      project.github?.defaultBranch ?? null,
      project.github?.webhookId ?? null,
      project.github?.webhookSecret ?? null,
      project.github?.installationId ?? null,
      project.github?.repoId ?? null,
      project.gitProvider ?? "github",
      project.gitlab?.projectId ?? null,
      project.gitlab?.pathWithNamespace ?? null,
      project.gitlab?.webhookId ?? null,
      project.gitlab?.webhookSecret ?? null,
      project.templateId,
      project.templateName,
      project.region,
      project.createdAt,
      project.updatedAt,
      project.lastDeploymentId,
      project.lastDeploymentStatus,
      project.lastDeploymentEndpoint,
      project.lastDeploymentCanisterId,
      project.lastDeploymentIdentity,
    ],
  );
  return project;
}

async function saveProject(project) {
  project.updatedAt = Date.now();
  await pool.query(
    `update projects set
        repo_url = $1,
        branch = $2,
        settings = $3,
        identity = $4,
        webhook_token = $5,
        github_owner = $6,
        github_repo = $7,
        github_full_name = $8,
        github_default_branch = $9,
        github_webhook_id = $10,
        github_webhook_secret = $11,
        github_installation_id = $12,
        github_repo_id = $13,
        git_provider = $14,
        gitlab_project_id = $15,
        gitlab_path_with_namespace = $16,
        gitlab_webhook_id = $17,
        gitlab_webhook_secret = $18,
        region = $19,
        last_deployment_id = $20,
        last_deployment_status = $21,
        last_deployment_endpoint = $22,
        last_deployment_canister_id = $23,
        last_deployment_identity = $24,
        updated_at = now()
      where id = $25`,
    [
      project.repoUrl,
      project.branch,
      project.settings,
      project.identity,
      project.webhookToken,
      project.github?.owner ?? null,
      project.github?.repo ?? null,
      project.github?.fullName ?? null,
      project.github?.defaultBranch ?? null,
      project.github?.webhookId ?? null,
      project.github?.webhookSecret ?? null,
      project.github?.installationId ?? null,
      project.github?.repoId ?? null,
      project.gitProvider ?? "github",
      project.gitlab?.projectId ?? null,
      project.gitlab?.pathWithNamespace ?? null,
      project.gitlab?.webhookId ?? null,
      project.gitlab?.webhookSecret ?? null,
      normalizeHostCanisterRegion(project.region || "global"),
      project.lastDeploymentId ?? null,
      project.lastDeploymentStatus ?? null,
      project.lastDeploymentEndpoint ?? null,
      project.lastDeploymentCanisterId ?? null,
      project.lastDeploymentIdentity ?? null,
      project.id,
    ],
  );
  return project;
}

function mapProjectRow(row) {
  if (!row) {
    return null;
  }
  const gitProvider = normalizeGitProvider(row.git_provider);
  const githubFullName = row.github_full_name ?? null;
  const [ownerFromFullName, repoFromFullName] = githubFullName
    ? String(githubFullName).split("/", 2)
    : [null, null];
  const hasGithubMetadata = Boolean(
    row.github_owner ||
    row.github_repo ||
    row.github_full_name ||
    row.github_installation_id ||
    row.github_repo_id,
  );
  const gitlabPathWithNamespace = row.gitlab_path_with_namespace ?? null;
  const hasGitLabMetadata = Boolean(
    row.gitlab_project_id ||
    row.gitlab_path_with_namespace ||
    row.gitlab_webhook_id ||
    row.gitlab_webhook_secret,
  );
  const tenant =
    row.tenant_id && row.tenant_slug
      ? {
          id: row.tenant_id,
          slug: row.tenant_slug,
          domainMode: row.tenant_domain_mode ?? "legacy",
          hostCanisterId: row.tenant_host_canister_id ?? null,
          hostCanisterAlias: row.tenant_host_canister_alias ?? null,
          hostCanisterRegion: normalizeHostCanisterRegion(
            row.tenant_host_canister_region || row.region || "global",
          ),
          hostCanisterVisibility: normalizeHostCanisterVisibility(
            row.tenant_host_canister_visibility || "public",
          ),
          hostedUrl: buildHostedUrl({
            slug: row.tenant_slug,
            domainMode: row.tenant_domain_mode ?? "legacy",
            hostCanisterAlias: row.tenant_host_canister_alias ?? null,
          }),
        }
      : null;
  return {
    id: row.id,
    userId: row.user_id,
    repoUrl: row.repo_url,
    branch: row.branch,
    gitProvider,
    templateId: row.template_id ?? null,
    templateName: row.template_name ?? null,
    region: normalizeHostCanisterRegion(row.region || "global"),
    identity: row.identity ?? defaultIdentity,
    settings: mergeBuildConfig(DEFAULT_BUILD_CONFIG, row.settings ?? DEFAULT_BUILD_CONFIG),
    webhookToken: row.webhook_token,
    github: hasGithubMetadata
      ? {
          owner: row.github_owner ?? ownerFromFullName ?? null,
          repo: row.github_repo ?? repoFromFullName ?? null,
          fullName: row.github_full_name ?? null,
          defaultBranch: row.github_default_branch,
          webhookId: row.github_webhook_id ?? null,
          webhookSecret: row.github_webhook_secret ?? null,
          installationId: row.github_installation_id ?? null,
          repoId: row.github_repo_id ?? null,
        }
      : null,
    gitlab: hasGitLabMetadata
      ? {
          projectId: row.gitlab_project_id ?? null,
          pathWithNamespace: gitlabPathWithNamespace,
          webhookId: row.gitlab_webhook_id ?? null,
          webhookSecret: row.gitlab_webhook_secret ?? null,
        }
      : null,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
    lastDeploymentId: row.last_deployment_id ?? null,
    lastDeploymentStatus: row.last_deployment_status ?? null,
    lastDeploymentEndpoint: row.last_deployment_endpoint ?? null,
    lastDeploymentCanisterId: row.last_deployment_canister_id ?? null,
    lastDeploymentIdentity: row.last_deployment_identity ?? null,
    lastDeployment: row.last_deployment ? mapDeploymentRow(row.last_deployment) : null,
    tenant,
  };
}

function defaultDeploymentStages() {
  return {
    build: {
      status: "pending",
      startedAt: null,
      finishedAt: null,
      jobName: null,
    },
    deploy: {
      status: "pending",
      startedAt: null,
      finishedAt: null,
      jobName: null,
    },
  };
}

function toStageMillis(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return toMillis(value);
}

function normalizeDeploymentStage(stageName, value) {
  const stage = value && typeof value === "object" ? value : {};
  const fallback = defaultDeploymentStages()[stageName];
  const rawStatus = String(stage.status || fallback.status || "pending")
    .trim()
    .toLowerCase();
  const status =
    rawStatus === "queued" || rawStatus === "pending" || rawStatus === "not_started"
      ? "pending"
      : rawStatus === "running"
        ? "running"
        : rawStatus === "succeeded"
          ? "succeeded"
          : rawStatus === "failed"
            ? "failed"
            : fallback.status;
  return {
    status,
    startedAt: toStageMillis(stage.startedAt ?? fallback.startedAt),
    finishedAt: toStageMillis(stage.finishedAt ?? fallback.finishedAt),
    jobName:
      typeof stage.jobName === "string" && stage.jobName.trim()
        ? stage.jobName.trim()
        : fallback.jobName,
  };
}

function normalizeDeploymentStages(value) {
  const stages = value && typeof value === "object" ? value : {};
  return {
    build: normalizeDeploymentStage("build", stages.build),
    deploy: normalizeDeploymentStage("deploy", stages.deploy),
  };
}

function normalizeDeploymentStatus(rawStatus) {
  const normalized = String(rawStatus || "")
    .trim()
    .toLowerCase();
  if (normalized === "queued") {
    return "queued";
  }
  if (normalized === "processing" || normalized === "running" || normalized === "pending") {
    return "processing";
  }
  if (normalized === "succeeded" || normalized === "failed") {
    return normalized;
  }
  return "failed";
}

function normalizeDeploymentPriority(rawPriority) {
  const normalized = String(rawPriority || "")
    .trim()
    .toLowerCase();
  if (normalized === "enterprise" || normalized === "pro" || normalized === "normal") {
    return normalized;
  }
  return "normal";
}

function normalizeQueueBucket(rawBucket) {
  const normalized = String(rawBucket || "")
    .trim()
    .toLowerCase();
  if (normalized === "next_up" || normalized === "few_ahead" || normalized === "in_queue") {
    return normalized;
  }
  return null;
}

function mapDeploymentRow(row) {
  if (!row) {
    return null;
  }
  const status = normalizeDeploymentStatus(row.status);
  const queuePositionRaw = Number.parseInt(String(row.queue_position ?? ""), 10);
  const queueTotalForCanister = Number.parseInt(String(row.queue_total_for_canister ?? ""), 10);
  const queuePosition =
    status === "queued" &&
    Number.isFinite(queuePositionRaw) &&
    queuePositionRaw > 0 &&
    Number.isFinite(queueTotalForCanister) &&
    queueTotalForCanister > 0
      ? queuePositionRaw
      : null;
  const queueAhead = Number.isFinite(queuePosition) ? queuePosition - 1 : null;
  const queueBucket = status === "queued" ? normalizeQueueBucket(row.queue_bucket) : null;
  return {
    id: row.id,
    projectId: row.project_id,
    status,
    priority: normalizeDeploymentPriority(row.priority),
    repoUrl: row.repo_url,
    branch: row.branch,
    network: row.network,
    identity: row.identity ?? null,
    buildConfig: mergeBuildConfig(DEFAULT_BUILD_CONFIG, row.build_config ?? DEFAULT_BUILD_CONFIG),
    source: row.source ?? null,
    commit: row.commit ?? null,
    metadata: row.metadata ?? null,
    logs: row.logs ?? [],
    endpoint: row.endpoint ?? null,
    canisterId: row.canister_id ?? null,
    canisterName: row.canister_name ?? null,
    stages: normalizeDeploymentStages(row.stages),
    assignedHostCanisterId: row.assigned_host_canister_id ?? null,
    queueEnqueuedAt: toMillis(row.queue_enqueued_at),
    processingStartedAt: toMillis(row.processing_started_at),
    processingDeadlineAt: toMillis(row.processing_deadline_at),
    queue:
      status === "queued"
        ? {
            position: queuePosition,
            ahead: Number.isFinite(queueAhead) && queueAhead >= 0 ? queueAhead : null,
            totalForCanister:
              Number.isFinite(queueTotalForCanister) && queueTotalForCanister >= 0
                ? queueTotalForCanister
                : null,
            bucket: queueBucket,
          }
        : null,
    createdAt: toMillis(row.created_at),
    startedAt: toMillis(row.started_at),
    finishedAt: toMillis(row.finished_at),
    durationMs: row.duration_ms ?? null,
  };
}
async function listDeployments(userId) {
  const res = await pool.query(
    `with user_deployments as (
       select
         d.*,
         p.id as project_id,
         p.repo_url as project_repo_url,
         p.branch as project_branch,
         p.identity as project_identity,
         p.settings as project_settings,
         p.github_owner,
         p.github_repo,
         p.github_full_name,
         p.github_installation_id,
         p.github_repo_id,
         p.git_provider,
         p.gitlab_project_id,
         p.gitlab_path_with_namespace,
         p.gitlab_webhook_id,
         p.last_deployment_identity,
         case lower(coalesce(d.priority, 'normal'))
           when 'enterprise' then 1
           when 'pro' then 2
           else 3
         end as priority_rank
       from deployments d
       join projects p on p.id = d.project_id
       where p.user_id = $1
     ),
     all_queued_rankable as (
       select
         d.id,
         d.assigned_host_canister_id,
         d.queue_enqueued_at,
         d.created_at,
         case
           when lower(coalesce(d.priority, 'normal')) = 'enterprise' then 0
           when lower(coalesce(d.priority, 'normal')) = 'normal'
             and row_number() over (
               partition by coalesce(d.assigned_host_canister_id, '__global__'),
                            case when lower(coalesce(d.priority, 'normal')) = 'normal' then 1 else 0 end
               order by d.queue_enqueued_at asc, d.created_at asc, d.id asc
             ) = 1 then 1
           when lower(coalesce(d.priority, 'normal')) = 'pro' then 2
           else 3
         end as bounded_priority_rank
       from deployments d
       where d.status = 'queued'
     ),
     queued_rank as (
       select
         aq.id as deployment_id,
         row_number() over (
           partition by coalesce(aq.assigned_host_canister_id, '__global__')
           order by
             aq.bounded_priority_rank asc,
             aq.queue_enqueued_at asc,
             aq.created_at asc,
             aq.id asc
         )::int as queue_position,
         count(*) over (
           partition by coalesce(aq.assigned_host_canister_id, '__global__')
         )::int as queue_total_for_canister
       from all_queued_rankable aq
     )
     select
       ud.*,
       case
         when ud.status = 'queued' and qr.queue_total_for_canister > 20 then null
         when ud.status = 'queued' then qr.queue_position
         else null
       end as queue_position,
       case
         when ud.status = 'queued' then qr.queue_total_for_canister
         else null
       end as queue_total_for_canister,
       case
         when ud.status = 'queued' and qr.queue_total_for_canister > 20 then
           case
             when qr.queue_position <= 3 then 'next_up'
             when qr.queue_position <= 10 then 'few_ahead'
             else 'in_queue'
           end
         else null
       end as queue_bucket
     from user_deployments ud
     left join queued_rank qr on qr.deployment_id = ud.id
     order by ud.created_at desc`,
    [userId],
  );

  return res.rows.map((row) => {
    const deployment = mapDeploymentRow(row);
    const githubFullName = row.github_full_name ?? null;
    const [ownerFromFullName, repoFromFullName] = githubFullName
      ? String(githubFullName).split("/", 2)
      : [null, null];
    const hasGithubMetadata = Boolean(
      row.github_owner ||
      row.github_repo ||
      row.github_full_name ||
      row.github_installation_id ||
      row.github_repo_id,
    );
    const hasGitLabMetadata = Boolean(
      row.gitlab_project_id || row.gitlab_path_with_namespace || row.gitlab_webhook_id,
    );
    const project = {
      id: row.project_id,
      repoUrl: row.project_repo_url,
      branch: row.project_branch,
      gitProvider: normalizeGitProvider(row.git_provider),
      identity: row.last_deployment_identity ?? row.project_identity ?? defaultIdentity,
      settings: mergeBuildConfig(
        DEFAULT_BUILD_CONFIG,
        row.project_settings ?? DEFAULT_BUILD_CONFIG,
      ),
      github: hasGithubMetadata
        ? {
            owner: row.github_owner ?? ownerFromFullName ?? null,
            repo: row.github_repo ?? repoFromFullName ?? null,
            fullName: row.github_full_name ?? null,
            installationId: row.github_installation_id ?? null,
            repoId: row.github_repo_id ?? null,
          }
        : null,
      gitlab: hasGitLabMetadata
        ? {
            projectId: row.gitlab_project_id ?? null,
            pathWithNamespace: row.gitlab_path_with_namespace ?? null,
            webhookId: row.gitlab_webhook_id ?? null,
          }
        : null,
    };
    return { ...deployment, project: projectSummary(project) };
  });
}

function mapNotificationRow(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body ?? null,
    projectId: row.project_id ?? null,
    deploymentId: row.deployment_id ?? null,
    readAt: toMillis(row.read_at),
    createdAt: toMillis(row.created_at),
  };
}

async function listNotifications(userId, { limit = 20, unreadOnly = false } = {}) {
  const clauses = ["user_id = $1"];
  const params = [userId];
  if (unreadOnly) {
    clauses.push("read_at is null");
  }
  params.push(limit);
  const res = await pool.query(
    `select *
     from notifications
     where ${clauses.join(" and ")}
     order by created_at desc
     limit $${params.length}`,
    params,
  );
  return res.rows.map(mapNotificationRow);
}

async function markNotificationRead(userId, notificationId) {
  const res = await pool.query(
    `update notifications
     set read_at = coalesce(read_at, now())
     where id = $1 and user_id = $2
     returning *`,
    [notificationId, userId],
  );
  const row = res.rows[0];
  return row ? mapNotificationRow(row) : null;
}

async function markAllNotificationsRead(userId) {
  const res = await pool.query(
    `update notifications
     set read_at = now()
     where user_id = $1 and read_at is null`,
    [userId],
  );
  return res.rowCount ?? 0;
}

async function deleteNotification(userId, notificationId) {
  const res = await pool.query("delete from notifications where id = $1 and user_id = $2", [
    notificationId,
    userId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

function parseAnalyticsRange(rawRange) {
  const requested = String(rawRange || DEFAULT_ANALYTICS_RANGE).toLowerCase();
  const key = ANALYTICS_RANGE_SPECS[requested] ? requested : DEFAULT_ANALYTICS_RANGE;
  const spec = ANALYTICS_RANGE_SPECS[key];
  const toMs = Date.now();
  const fromMs = toMs - spec.durationMs;
  return {
    key,
    fromMs,
    toMs,
    from: new Date(fromMs),
    to: new Date(toMs),
    bucketInterval: spec.bucketInterval,
    bucketUnit: spec.bucketUnit,
  };
}

function sanitizeRunnerLogLine(value) {
  return String(value || "")
    .replace(RUNNER_LOG_ANSI_PATTERN, "")
    .trim();
}

function normalizeFailureLogLines(logs) {
  if (!Array.isArray(logs)) {
    return [];
  }
  const lines = [];
  for (const rawLine of logs) {
    const line = sanitizeRunnerLogLine(rawLine);
    if (!line) {
      continue;
    }
    lines.push(line.replace(RUNNER_LOG_STAGE_PREFIX_PATTERN, "").trim());
  }
  return lines;
}

function classifyDeploymentFailure(logs) {
  const lines = normalizeFailureLogLines(logs);
  const haystack = lines.slice(-220).join("\n");
  for (const rule of DEPLOY_FAILURE_INSIGHT_RULES) {
    if (rule.pattern.test(haystack)) {
      return {
        id: rule.id,
        title: rule.title,
        hint: rule.hint,
      };
    }
  }
  return {
    id: "unknown_failure",
    title: "Unclassified deployment failure",
    hint: "Open deployment logs and inspect the last error lines.",
  };
}

function formatFailureInsightProjectLabel(row) {
  return (
    row.tenant_slug ||
    row.github_full_name ||
    row.gitlab_path_with_namespace ||
    row.repo_url ||
    row.project_id
  );
}

async function getAdminFailureInsights(range) {
  const res = await pool.query(
    `select
        d.id as deployment_id,
        d.project_id,
        d.logs,
        d.branch as deployment_branch,
        d.source,
        d.created_at,
        p.repo_url,
        p.github_full_name,
        p.gitlab_path_with_namespace,
        p.branch as project_branch,
        t.slug as tenant_slug,
        u.email as owner_email
     from deployments d
     join projects p on p.id = d.project_id
     join users u on u.id = p.user_id
     left join tenants t on t.id = p.tenant_id
     where d.status = 'failed'
       and d.created_at >= $1
       and d.created_at <= $2
     order by d.created_at desc
     limit $3`,
    [range.from, range.to, ADMIN_FAILURE_INSIGHT_SAMPLE_LIMIT],
  );

  const grouped = new Map();
  const recentFailures = [];
  for (const row of res.rows) {
    const classification = classifyDeploymentFailure(row.logs);
    const current = grouped.get(classification.id) || {
      id: classification.id,
      title: classification.title,
      hint: classification.hint,
      count: 0,
      lastOccurredAt: null,
      sample: null,
    };
    current.count += 1;
    const createdAt = toMillis(row.created_at);
    if (!current.lastOccurredAt || (createdAt && createdAt > current.lastOccurredAt)) {
      current.lastOccurredAt = createdAt;
    }
    if (!current.sample) {
      current.sample = {
        deploymentId: row.deployment_id,
        projectId: row.project_id,
        project: formatFailureInsightProjectLabel(row),
        ownerEmail: row.owner_email || null,
        branch: row.deployment_branch || row.project_branch || null,
        createdAt,
      };
    }
    grouped.set(classification.id, current);

    if (recentFailures.length < 8) {
      recentFailures.push({
        deploymentId: row.deployment_id,
        projectId: row.project_id,
        project: formatFailureInsightProjectLabel(row),
        ownerEmail: row.owner_email || null,
        branch: row.deployment_branch || row.project_branch || null,
        source: row.source || null,
        createdAt,
        reason: classification.title,
        hint: classification.hint,
      });
    }
  }

  const topCauses = Array.from(grouped.values())
    .sort((a, b) => {
      const countDiff = b.count - a.count;
      if (countDiff !== 0) {
        return countDiff;
      }
      return Number(b.lastOccurredAt || 0) - Number(a.lastOccurredAt || 0);
    })
    .slice(0, 6);

  return {
    analyzedFailedDeployments: res.rows.length,
    sampleLimit: ADMIN_FAILURE_INSIGHT_SAMPLE_LIMIT,
    topCauses,
    recentFailures,
  };
}

async function getAdminOverviewStats(range) {
  const totalsRes = await pool.query(
    `select
        (select count(*)::int from users) as total_accounts,
        (select count(*)::int from projects) as total_projects,
        (select count(*)::int from tenants) as total_hosted_websites,
        (select count(*)::int from deployments) as total_deployments`,
  );
  const rangeRes = await pool.query(
    `select
        count(*)::int as deployments,
        count(*) filter (where status = 'succeeded')::int as succeeded,
        count(*) filter (where status = 'failed')::int as failed
     from deployments
     where created_at >= $1 and created_at <= $2`,
    [range.from, range.to],
  );

  const totals = totalsRes.rows[0] ?? {};
  const inRange = rangeRes.rows[0] ?? {};
  const succeeded = Number(inRange.succeeded || 0);
  const failed = Number(inRange.failed || 0);
  const finished = succeeded + failed;
  const successRatePct = finished > 0 ? Math.round((succeeded / finished) * 10000) / 100 : null;
  const failureInsights = await getAdminFailureInsights(range);

  return {
    range: range.key,
    from: range.fromMs,
    to: range.toMs,
    totals: {
      accounts: Number(totals.total_accounts || 0),
      projects: Number(totals.total_projects || 0),
      hostedWebsites: Number(totals.total_hosted_websites || 0),
      deployments: Number(totals.total_deployments || 0),
    },
    inRange: {
      deployments: Number(inRange.deployments || 0),
      succeeded,
      failed,
      successRatePct,
    },
    failureInsights: {
      ...failureInsights,
      totalFailedInRange: failed,
    },
  };
}

function formatTimeseriesLabel(value, bucketUnit) {
  const date = new Date(value);
  if (bucketUnit === "hour") {
    return date.toISOString().slice(5, 16).replace("T", " ");
  }
  return date.toISOString().slice(0, 10);
}

async function getAdminTimeseriesStats(range) {
  const unit = range.bucketUnit === "hour" ? "hour" : "day";
  const sql = `
    with buckets as (
      select generate_series(
        date_trunc('${unit}', $1::timestamptz),
        date_trunc('${unit}', $2::timestamptz),
        $3::interval
      ) as bucket
    ),
    signup_counts as (
      select date_trunc('${unit}', created_at) as bucket, count(*)::int as count
      from users
      where created_at >= $1 and created_at <= $2
      group by 1
    ),
    project_counts as (
      select date_trunc('${unit}', created_at) as bucket, count(*)::int as count
      from projects
      where created_at >= $1 and created_at <= $2
      group by 1
    ),
    deployment_counts as (
      select date_trunc('${unit}', created_at) as bucket, count(*)::int as count
      from deployments
      where created_at >= $1 and created_at <= $2
      group by 1
    ),
    success_counts as (
      select date_trunc('${unit}', created_at) as bucket, count(*)::int as count
      from deployments
      where created_at >= $1 and created_at <= $2 and status = 'succeeded'
      group by 1
    ),
    failure_counts as (
      select date_trunc('${unit}', created_at) as bucket, count(*)::int as count
      from deployments
      where created_at >= $1 and created_at <= $2 and status = 'failed'
      group by 1
    )
    select
      b.bucket,
      coalesce(su.count, 0)::int as signups,
      coalesce(pr.count, 0)::int as projects,
      coalesce(dp.count, 0)::int as deployments,
      coalesce(sc.count, 0)::int as succeeded,
      coalesce(fc.count, 0)::int as failed
    from buckets b
    left join signup_counts su on su.bucket = b.bucket
    left join project_counts pr on pr.bucket = b.bucket
    left join deployment_counts dp on dp.bucket = b.bucket
    left join success_counts sc on sc.bucket = b.bucket
    left join failure_counts fc on fc.bucket = b.bucket
    order by b.bucket asc
  `;
  const res = await pool.query(sql, [range.from, range.to, range.bucketInterval]);
  const points = res.rows.map((row) => ({
    bucketStart: toMillis(row.bucket),
    label: formatTimeseriesLabel(row.bucket, range.bucketUnit),
    signups: Number(row.signups || 0),
    projects: Number(row.projects || 0),
    deployments: Number(row.deployments || 0),
    succeeded: Number(row.succeeded || 0),
    failed: Number(row.failed || 0),
  }));
  return {
    range: range.key,
    from: range.fromMs,
    to: range.toMs,
    bucketUnit: range.bucketUnit,
    points,
  };
}

async function getAdminCanisterStats(range) {
  const res = await pool.query(
    `select
        hc.alias,
        hc.canister_id,
        count(distinct t.id)::int as websites,
        count(d.id) filter (
          where d.created_at >= $1 and d.created_at <= $2
        )::int as deployments,
        count(d.id) filter (
          where d.created_at >= $1 and d.created_at <= $2 and d.status = 'succeeded'
        )::int as succeeded,
        count(d.id) filter (
          where d.created_at >= $1 and d.created_at <= $2 and d.status = 'failed'
        )::int as failed
     from host_canisters hc
     left join tenant_hosts th on th.host_canister_id = hc.id
     left join tenants t on t.id = th.tenant_id
     left join projects p on p.tenant_id = t.id
     left join deployments d on d.project_id = p.id
     group by hc.id, hc.alias, hc.canister_id
     order by websites desc, hc.alias asc`,
    [range.from, range.to],
  );

  const items = res.rows.map((row) => {
    const succeeded = Number(row.succeeded || 0);
    const failed = Number(row.failed || 0);
    const finished = succeeded + failed;
    const successRatePct = finished > 0 ? Math.round((succeeded / finished) * 10000) / 100 : null;
    return {
      alias: row.alias,
      canisterId: row.canister_id,
      websites: Number(row.websites || 0),
      deployments: Number(row.deployments || 0),
      succeeded,
      failed,
      successRatePct,
    };
  });

  return {
    range: range.key,
    from: range.fromMs,
    to: range.toMs,
    items,
  };
}

async function listAdminDeployedProjects() {
  const res = await pool.query(
    `with deployment_rollup as (
       select
         d.project_id,
         count(*)::int as deployments_count,
         count(*) filter (where d.status = 'succeeded')::int as succeeded_count,
         max(coalesce(d.finished_at, d.started_at, d.created_at)) as last_deployed_at,
         (array_agg(d.status order by coalesce(d.finished_at, d.started_at, d.created_at) desc nulls last))[1] as last_deployment_status
       from deployments d
       group by d.project_id
     )
     select
       p.id as project_id,
       p.branch,
       p.repo_url,
       p.github_full_name,
       p.gitlab_path_with_namespace,
       p.git_provider,
       t.slug as tenant_slug,
       t.domain_mode as tenant_domain_mode,
       p.hosted_url,
       hc.canister_id as tenant_host_canister_id,
       hc.alias as tenant_host_canister_alias,
       u.id as owner_user_id,
       u.email as owner_email,
       coalesce(nullif(trim(u.display_name), ''), nullif(trim(u.username), ''), u.email) as owner_name,
       dr.deployments_count,
       dr.succeeded_count,
       dr.last_deployed_at,
       dr.last_deployment_status
     from projects p
     join users u on u.id = p.user_id
     join deployment_rollup dr on dr.project_id = p.id
     left join tenants t on t.id = p.tenant_id
     left join tenant_hosts th on th.tenant_id = t.id
     left join host_canisters hc on hc.id = th.host_canister_id
     order by dr.last_deployed_at desc nulls last, p.created_at desc`,
  );
  return res.rows.map((row) => {
    const deploymentsCount = Number(row.deployments_count || 0);
    const succeededCount = Number(row.succeeded_count || 0);
    const failedCount = Math.max(0, deploymentsCount - succeededCount);
    const hostedUrl =
      row.hosted_url ??
      buildHostedUrl({
        slug: row.tenant_slug,
        domainMode: row.tenant_domain_mode ?? "legacy",
        hostCanisterAlias: row.tenant_host_canister_alias ?? null,
      });
    return {
      projectId: row.project_id,
      repoUrl: row.repo_url ?? null,
      branch: row.branch ?? null,
      gitProvider: normalizeGitProvider(row.git_provider),
      githubFullName: row.github_full_name ?? null,
      gitlabPathWithNamespace: row.gitlab_path_with_namespace ?? null,
      tenantSlug: row.tenant_slug ?? null,
      tenantDomainMode: row.tenant_domain_mode ?? "legacy",
      tenantHostCanisterId: row.tenant_host_canister_id ?? null,
      tenantHostCanisterAlias: row.tenant_host_canister_alias ?? null,
      hostedUrl,
      owner: {
        userId: row.owner_user_id,
        name: row.owner_name,
        email: row.owner_email,
      },
      deploymentsCount,
      succeededCount,
      failedCount,
      lastDeployedAt: toMillis(row.last_deployed_at),
      lastDeploymentStatus: row.last_deployment_status ?? null,
    };
  });
}

function normalizeHostCanisterAlias(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function normalizeHostCanisterId(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function normalizeHostCanisterStatus(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function normalizeHostCanisterRegion(raw) {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase();
  return normalized || "global";
}

function normalizeHostCanisterVisibility(raw) {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase();
  return HOST_CANISTER_VISIBILITIES.has(normalized) ? normalized : "public";
}

function parseHostCanisterCapacity(raw) {
  if (raw === undefined) {
    return { missing: true };
  }
  if (raw === null || String(raw).trim() === "") {
    return { value: null };
  }
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < 0) {
    return { error: "capacity must be a non-negative integer." };
  }
  return { value };
}

function parseHostCanisterPayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "Invalid payload." };
  }
  const out = {};
  const hasAlias = Object.prototype.hasOwnProperty.call(payload, "alias");
  const hasCanisterId = Object.prototype.hasOwnProperty.call(payload, "canisterId");
  const hasStatus = Object.prototype.hasOwnProperty.call(payload, "status");
  const hasCapacity = Object.prototype.hasOwnProperty.call(payload, "capacity");
  const hasRegion = Object.prototype.hasOwnProperty.call(payload, "region");
  const hasVisibility = Object.prototype.hasOwnProperty.call(payload, "visibility");

  if (!partial || hasAlias) {
    const alias = normalizeHostCanisterAlias(payload.alias);
    if (!alias) {
      return { error: "alias is required." };
    }
    const aliasSeparator = getHostAliasLabelSeparator();
    if (aliasSeparator && alias.includes(aliasSeparator)) {
      return {
        error: `alias must not include "${aliasSeparator}" because it is reserved for host label routing.`,
      };
    }
    if (!HOST_CANISTER_ALIAS_PATTERN.test(alias)) {
      return {
        error: "alias must be DNS-safe (lowercase letters, numbers, dashes; max 63 chars).",
      };
    }
    out.alias = alias;
  }

  if (!partial || hasCanisterId) {
    const canisterId = normalizeHostCanisterId(payload.canisterId);
    if (!canisterId) {
      return { error: "canisterId is required." };
    }
    if (!HOST_CANISTER_ID_PATTERN.test(canisterId)) {
      return { error: "canisterId format is invalid." };
    }
    out.canisterId = canisterId;
  }

  if (!partial || hasStatus) {
    const status = normalizeHostCanisterStatus(hasStatus ? payload.status : "active");
    if (!HOST_CANISTER_STATUSES.has(status)) {
      return { error: "status must be one of: active, draining, full." };
    }
    out.status = status;
  }

  if (!partial || hasRegion) {
    const region = normalizeHostCanisterRegion(hasRegion ? payload.region : "global");
    if (!HOST_CANISTER_REGION_PATTERN.test(region)) {
      return {
        error: "region must be DNS-safe (lowercase letters, numbers, dashes; max 33 chars).",
      };
    }
    out.region = region;
  }

  if (!partial || hasVisibility) {
    const visibility = String(hasVisibility ? payload.visibility : "public")
      .trim()
      .toLowerCase();
    if (!HOST_CANISTER_VISIBILITIES.has(visibility)) {
      return { error: "visibility must be one of: public, private." };
    }
    out.visibility = visibility;
  }

  if (!partial || hasCapacity) {
    const parsedCapacity = parseHostCanisterCapacity(payload.capacity);
    if (parsedCapacity.error) {
      return { error: parsedCapacity.error };
    }
    if (!parsedCapacity.missing) {
      out.capacity = parsedCapacity.value;
    }
  }

  if (partial && Object.keys(out).length === 0) {
    return { error: "At least one field is required." };
  }
  if (!partial && !Object.prototype.hasOwnProperty.call(out, "capacity")) {
    out.capacity = null;
  }

  return { value: out };
}

function createHttpInputError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveRequestedProjectRouting(user, payload) {
  const visibility = normalizeHostCanisterVisibility(payload?.routingVisibility || "public");
  const region = normalizeHostCanisterRegion(payload?.region || "global");
  if (!HOST_CANISTER_REGION_PATTERN.test(region)) {
    throw createHttpInputError("Invalid deployment region.");
  }
  if (visibility === "private" && !isUserPro(user)) {
    throw createHttpInputError("A3 Pro is required for private region routing.", 403);
  }
  return { region, visibility };
}

async function listDeploymentRegions() {
  const res = await pool.query(
    `select hc.region,
            hc.visibility,
            1::int as canisters
     from host_canisters hc
     left join tenant_hosts th on th.host_canister_id = hc.id
     where hc.status = 'active'
     group by hc.id, hc.region, hc.visibility, hc.capacity
     having hc.capacity is null or count(th.tenant_id) < hc.capacity`,
  );
  const byKey = new Map();
  for (const row of res.rows) {
    const region = normalizeHostCanisterRegion(row.region || "global");
    const visibility = normalizeHostCanisterVisibility(row.visibility || "public");
    const key = `${visibility}:${region}`;
    const current = byKey.get(key) || { id: region, visibility, canisters: 0 };
    current.canisters += Number.parseInt(String(row.canisters || 0), 10) || 0;
    byKey.set(key, current);
  }
  const items = Array.from(byKey.values()).sort((a, b) => {
    if (a.visibility !== b.visibility) {
      return a.visibility === "public" ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });
  return {
    public: items.filter((item) => item.visibility === "public"),
    private: items.filter((item) => item.visibility === "private"),
  };
}

function hostCanisterRowToResponse(row) {
  return {
    id: row.id,
    alias: row.alias,
    canisterId: row.canister_id,
    capacity: row.capacity === null ? null : Number(row.capacity),
    status: row.status,
    region: normalizeHostCanisterRegion(row.region || "global"),
    visibility: normalizeHostCanisterVisibility(row.visibility || "public"),
    createdAt: toMillis(row.created_at),
  };
}

async function listAdminHostCanisters() {
  const res = await pool.query(
    `select id, alias, canister_id, capacity, status, region, visibility, created_at
     from host_canisters
     order by created_at asc`,
  );
  return res.rows.map(hostCanisterRowToResponse);
}

async function createHostCanister({ alias, canisterId, status, capacity, region, visibility }) {
  const res = await pool.query(
    `insert into host_canisters (
       id, alias, canister_id, capacity, status, region, visibility, created_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, now())
     returning id, alias, canister_id, capacity, status, region, visibility, created_at`,
    [randomUUID(), alias, canisterId, capacity, status, region, visibility],
  );
  return hostCanisterRowToResponse(res.rows[0]);
}

async function updateHostCanister(id, patch) {
  const updates = [];
  const values = [];
  let idx = 1;

  if (Object.prototype.hasOwnProperty.call(patch, "alias")) {
    updates.push(`alias = $${idx}`);
    values.push(patch.alias);
    idx += 1;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "canisterId")) {
    updates.push(`canister_id = $${idx}`);
    values.push(patch.canisterId);
    idx += 1;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    updates.push(`status = $${idx}`);
    values.push(patch.status);
    idx += 1;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "region")) {
    updates.push(`region = $${idx}`);
    values.push(patch.region);
    idx += 1;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "visibility")) {
    updates.push(`visibility = $${idx}`);
    values.push(patch.visibility);
    idx += 1;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "capacity")) {
    updates.push(`capacity = $${idx}`);
    values.push(patch.capacity);
    idx += 1;
  }
  if (updates.length === 0) {
    return null;
  }
  values.push(id);
  const res = await pool.query(
    `update host_canisters
     set ${updates.join(", ")}
     where id = $${idx}
     returning id, alias, canister_id, capacity, status, region, visibility, created_at`,
    values,
  );
  const row = res.rows[0];
  return row ? hostCanisterRowToResponse(row) : null;
}

async function resolveHostCanisterAlias(alias) {
  const res = await pool.query(
    `select alias, canister_id, status
     from host_canisters
     where lower(alias) = lower($1)
     limit 1`,
    [alias],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    alias: row.alias,
    canisterId: row.canister_id,
    status: row.status,
    upstreamHost: `${row.canister_id}.icp0.io`,
  };
}

function projectToResponse(req, project, latestDeployment = null) {
  const webhookUrl = buildProjectWebhookUrl(req, project);
  const gitProvider = normalizeGitProvider(project.gitProvider);
  const lastDeployment =
    latestDeployment ?? project.lastDeployment ?? (project.lastDeploymentId ? null : null);
  const tenant = project.tenant ?? null;

  return {
    id: project.id,
    repoUrl: project.repoUrl,
    branch: project.branch,
    gitProvider,
    templateId: project.templateId ?? null,
    templateName: project.templateName ?? null,
    region: normalizeHostCanisterRegion(project.region || "global"),
    identity: project.identity ?? defaultIdentity,
    lastDeploymentIdentity: project.lastDeploymentIdentity ?? project.identity ?? defaultIdentity,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    webhookUrl,
    settings: getProjectBuildConfig(project),
    github: project.github
      ? {
          owner: project.github.owner,
          repo: project.github.repo,
          fullName: project.github.fullName,
          defaultBranch: project.github.defaultBranch,
          webhookId: project.github.webhookId ?? null,
          installationId: project.github.installationId ?? null,
          repoId: project.github.repoId ?? null,
        }
      : null,
    gitlab: project.gitlab
      ? {
          projectId: project.gitlab.projectId ?? null,
          pathWithNamespace: project.gitlab.pathWithNamespace ?? null,
          webhookId: project.gitlab.webhookId ?? null,
          webhookSecret: gitProvider === "gitlab" ? (project.gitlab.webhookSecret ?? null) : null,
        }
      : null,
    lastDeployment: summarizeDeployment(lastDeployment),
    tenant: tenant
      ? {
          id: tenant.id,
          slug: tenant.slug,
          domainMode: tenant.domainMode ?? "legacy",
          hostCanisterId: tenant.hostCanisterId ?? null,
          hostCanisterAlias: tenant.hostCanisterAlias ?? null,
          hostCanisterRegion: tenant.hostCanisterRegion ?? project.region ?? "global",
          hostCanisterVisibility: tenant.hostCanisterVisibility ?? "public",
          hostedUrl:
            tenant.hostedUrl ??
            buildHostedUrl({
              slug: tenant.slug,
              domainMode: tenant.domainMode ?? "legacy",
              hostCanisterAlias: tenant.hostCanisterAlias ?? null,
            }),
        }
      : null,
  };
}

function summarizeDeployment(deployment) {
  if (!deployment) {
    return null;
  }
  return {
    id: deployment.id,
    status: deployment.status,
    priority: deployment.priority ?? "normal",
    queue: deployment.queue ?? null,
    assignedHostCanisterId: deployment.assignedHostCanisterId ?? null,
    createdAt: deployment.createdAt,
    queueEnqueuedAt: deployment.queueEnqueuedAt ?? null,
    processingStartedAt: deployment.processingStartedAt ?? null,
    processingDeadlineAt: deployment.processingDeadlineAt ?? null,
    finishedAt: deployment.finishedAt,
    endpoint: deployment.endpoint,
    canisterId: deployment.canisterId,
    canisterName: deployment.canisterName,
    branch: deployment.branch,
    commit: deployment.commit,
    source: deployment.source,
    identity: deployment.identity ?? null,
    stages: normalizeDeploymentStages(deployment.stages),
    buildConfig: mergeBuildConfig(DEFAULT_BUILD_CONFIG, deployment.buildConfig ?? {}),
  };
}

function projectSummary(project) {
  if (!project) {
    return null;
  }
  return {
    id: project.id,
    repoUrl: project.repoUrl,
    branch: project.branch,
    gitProvider: normalizeGitProvider(project.gitProvider),
    templateId: project.templateId ?? null,
    templateName: project.templateName ?? null,
    identity: project.lastDeploymentIdentity ?? project.identity ?? defaultIdentity,
    settings: getProjectBuildConfig(project),
    github: project.github
      ? {
          owner: project.github.owner,
          repo: project.github.repo,
          fullName: project.github.fullName,
          installationId: project.github.installationId ?? null,
          repoId: project.github.repoId ?? null,
        }
      : null,
    gitlab: project.gitlab
      ? {
          projectId: project.gitlab.projectId ?? null,
          pathWithNamespace: project.gitlab.pathWithNamespace ?? null,
          webhookId: project.gitlab.webhookId ?? null,
        }
      : null,
  };
}

function toMillis(value) {
  if (!value) {
    return null;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

async function triggerDeployment(project, options = {}) {
  if (!project.repoUrl) {
    throw new Error("Project has no repository connected.");
  }
  const branch = options.branch || project.branch || "main";
  const repoUrl = options.repoUrlOverride || project.repoUrl;
  const network = options.network || process.env.ICP_NETWORK || "local";
  const defaultMode = resolveDeployModeType();
  const deployMode = options.deployMode ? normalizeDeployMode(options.deployMode) : defaultMode;
  const hostedRuntimeIdentity =
    process.env.DEPLOY_IDENTITY_NAME || process.env.DFX_IDENTITY || defaultIdentity;
  const identity =
    options.identity ??
    (deployMode === "hosted" ? hostedRuntimeIdentity : (project.identity ?? defaultIdentity));
  let tenantMapping = null;
  if (deployMode === "hosted") {
    tenantMapping = await getTenantByProjectId(project.id);
    if (!tenantMapping) {
      throw new Error("Hosted deployment requires an existing tenant mapping.");
    }
  } else if (
    options.metadata?.projectSlug ||
    options.metadata?.hostCanisterId ||
    options.metadata?.tenantId
  ) {
    throw new Error("Eject deployment must not include hosted metadata.");
  }
  const projectSlug = tenantMapping?.slug ?? null;
  const hostedTarget = selectHostedCanisterTarget(tenantMapping);
  const hostCanisterId = hostedTarget.hostCanisterId;
  const hostCanisterAlias = hostedTarget.hostCanisterAlias;
  const domainMode = tenantMapping?.domainMode ?? "legacy";
  const buildConfig = getProjectBuildConfig(project);
  const gitProvider = normalizeGitProvider(project.gitProvider);
  const metadata = {
    ...(options.metadata ?? {}),
    gitProvider,
    deployMode,
    projectSlug,
    hostCanisterId,
    hostCanisterAlias,
    domainMode,
    tenantId: tenantMapping?.id ?? null,
  };
  if (deployMode === "hosted") {
    await assertHostedDeployTicketGuardrail({
      deploymentId: null,
      projectId: project.id,
      hostCanisterId,
      network,
    });
  }
  const deploymentPriority = await resolveDeploymentPriorityForUser(project.userId);

  let deployment;
  try {
    deployment = await createDeploymentRecord(project, {
      repoUrl,
      branch,
      network,
      identity,
      buildConfig,
      source: options.source ?? "manual",
      commit: options.commit ?? null,
      metadata,
      priority: deploymentPriority,
      assignedHostCanisterId: deployMode === "hosted" ? hostCanisterId : null,
    });
  } catch (error) {
    const mapped = mapDeploymentInsertError(error);
    if (mapped) {
      throw mapped;
    }
    throw error;
  }

  project.lastDeploymentId = deployment.id;
  project.lastDeploymentStatus = deployment.status;
  project.lastDeploymentEndpoint = null;
  project.lastDeploymentCanisterId = null;
  project.lastDeploymentIdentity = deployment.identity ?? null;
  project.lastDeployment = deployment;
  project.updatedAt = Date.now();

  logger.info(
    {
      deploymentId: deployment.id,
      projectId: project.id,
      assignedHostCanisterId: deployment.assignedHostCanisterId ?? null,
      priority: deployment.priority,
    },
    "Deployment queued",
  );
  void runDeploymentQueueCycle().catch((error) => {
    logger.error({ err: error }, "Failed to trigger deployment queue cycle");
  });

  return summarizeDeployment(deployment);
}

async function createDeploymentRecord(project, data) {
  const now = Date.now();
  const stages = normalizeDeploymentStages(data.stages ?? defaultDeploymentStages());
  const priority = normalizeDeploymentPriority(data.priority);
  const assignedHostCanisterId =
    typeof data.assignedHostCanisterId === "string" && data.assignedHostCanisterId.trim()
      ? data.assignedHostCanisterId.trim().toLowerCase()
      : null;
  const res = await pool.query(
    `insert into deployments (
        id, project_id, status, repo_url, branch, network, identity, build_config,
        source, commit, metadata, stages,
        priority, queue_enqueued_at, assigned_host_canister_id, created_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12,
        $13, to_timestamp($14/1000.0), $15, to_timestamp($14/1000.0)
      )
      returning *`,
    [
      randomUUID(),
      project.id,
      "queued",
      data.repoUrl,
      data.branch,
      data.network,
      data.identity,
      data.buildConfig,
      data.source,
      data.commit,
      data.metadata ?? null,
      JSON.stringify(stages),
      priority,
      now,
      assignedHostCanisterId,
    ],
  );

  await pool.query(
    `update projects set
        branch = $2,
        identity = $3,
        last_deployment_id = $4,
        last_deployment_status = $5,
        last_deployment_endpoint = null,
        last_deployment_canister_id = null,
        last_deployment_identity = $3,
        updated_at = now()
      where id = $1`,
    [project.id, data.branch, data.identity, res.rows[0].id, "queued"],
  );

  return mapDeploymentRow(res.rows[0]);
}
async function runDeployment(deployment, deployMode, deploymentEnv = {}) {
  const network = deployment.network || process.env.ICP_NETWORK || "local";
  if (!Number.isFinite(deployment.startedAt)) {
    await setStatus(deployment, { status: "processing", startedAt: Date.now() });
  } else if (deployment.status !== "processing") {
    await setStatus(deployment, { status: "processing" });
  }
  const buildConfig = enforceBuildSecurityPolicy(
    mergeBuildConfig(DEFAULT_BUILD_CONFIG, deployment.buildConfig ?? {}),
  );
  if (
    deployMode === "hosted" &&
    (!deployment.metadata?.projectSlug || !deployment.metadata?.hostCanisterId)
  ) {
    throw new Error("Hosted deployment requires tenant slug and host canister.");
  }
  if (
    deployMode === "eject" &&
    (deployment.metadata?.projectSlug || deployment.metadata?.hostCanisterId)
  ) {
    throw new Error("Eject deployment must not include hosted metadata.");
  }

  if (useJobRunner) {
    deployment.stages = normalizeDeploymentStages(deployment.stages ?? defaultDeploymentStages());
    try {
      await runDeploymentViaJob(deployment, buildConfig, network, deployMode, deploymentEnv);
      await finalizeEject(deployment, deployMode);
      return deployment;
    } catch (error) {
      await appendLog(deployment, `Runner orchestration failed: ${error?.message || error}`);
      const finishedAt = Date.now();
      for (const stageName of DEPLOYMENT_STAGE_ORDER) {
        const stage = normalizeDeploymentStages(deployment.stages)[stageName];
        if (stage.status === "running" || stage.status === "pending") {
          await appendStageMarker(deployment, stageName, "END", "failed");
          await updateDeploymentStage(deployment, stageName, {
            status: "failed",
            finishedAt,
          });
          break;
        }
      }
      await setStatus(deployment, {
        status: "failed",
        finishedAt,
        durationMs:
          deployment.startedAt && Number.isFinite(deployment.startedAt)
            ? finishedAt - deployment.startedAt
            : undefined,
      });
      await finalizeEject(deployment, deployMode);
      logger.error(
        {
          deploymentId: deployment.id,
          error: error?.message || error,
          err: error,
        },
        "Runner Job creation failed",
      );
      return deployment;
    }
  }

  throw new Error(
    "Deployments require isolated Kubernetes build and deploy jobs (DEPLOY_MODE=job).",
  );
}

async function runDeploymentViaJob(
  deployment,
  buildConfig,
  network,
  deployMode,
  deploymentEnv = {},
) {
  await ensureRunnerWorkspaceRoot(deployment.id);
  const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
  const token = readRequiredFile(tokenPath, "utf8");
  const ca = readRequiredFile(caPath);
  const host = process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT || "443";
  const isProd = process.env.NODE_ENV === "production";
  const insecureTlsRequested =
    String(process.env.K8S_INSECURE_TLS || "false").toLowerCase() === "true";
  const useInsecureTls = insecureTlsRequested && !isProd;

  assertKubernetesClientPrereqs({
    token,
    ca,
    host,
    port,
    isProd,
    useInsecureTls,
    tokenPath,
    caPath,
  });

  if (useInsecureTls) {
    logger.warn(
      { deploymentId: deployment.id, host, port },
      "Kubernetes TLS verification is disabled via K8S_INSECURE_TLS (non-production override)",
    );
  }
  const agent = new https.Agent({ ca, rejectUnauthorized: !useInsecureTls });

  try {
    await appendStageMarker(deployment, "build", "START");
    const buildJobName = buildStageJobName(deployment.id, "build");
    await updateDeploymentStage(deployment, "build", {
      status: "running",
      startedAt: Date.now(),
      jobName: buildJobName,
    });
    const buildResult = await runDeploymentStageJob({
      stageName: "build",
      jobName: buildJobName,
      deployment,
      buildConfig,
      network,
      deployMode,
      deploymentEnv,
      token,
      agent,
      host,
      port,
    });
    await appendStageMarker(
      deployment,
      "build",
      "END",
      buildResult.succeeded ? "success" : "failed",
    );
    await updateDeploymentStage(deployment, "build", {
      status: buildResult.succeeded ? "succeeded" : "failed",
      finishedAt: Date.now(),
    });
    if (!buildResult.succeeded) {
      const finishedAt = Date.now();
      await setStatus(deployment, {
        status: "failed",
        finishedAt,
        durationMs:
          deployment.startedAt && Number.isFinite(deployment.startedAt)
            ? finishedAt - deployment.startedAt
            : undefined,
      });
      return;
    }

    await appendStageMarker(deployment, "deploy", "START");
    const deployJobName = buildStageJobName(deployment.id, "deploy");
    await updateDeploymentStage(deployment, "deploy", {
      status: "running",
      startedAt: Date.now(),
      jobName: deployJobName,
    });
    const deployResult = await runDeploymentStageJob({
      stageName: "deploy",
      jobName: deployJobName,
      deployment,
      buildConfig,
      network,
      deployMode,
      deploymentEnv,
      token,
      agent,
      host,
      port,
    });
    await appendStageMarker(
      deployment,
      "deploy",
      "END",
      deployResult.succeeded ? "success" : "failed",
    );
    await updateDeploymentStage(deployment, "deploy", {
      status: deployResult.succeeded ? "succeeded" : "failed",
      finishedAt: Date.now(),
    });

    const finishedAt = Date.now();
    await setStatus(deployment, {
      status: deployResult.succeeded ? "succeeded" : "failed",
      finishedAt,
      durationMs:
        deployment.startedAt && Number.isFinite(deployment.startedAt)
          ? finishedAt - deployment.startedAt
          : undefined,
    });
  } finally {
    await cleanupRunnerWorkspace(deployment.id);
  }
}

function buildStageJobName(deploymentId, stageName) {
  return `deploy-${stageName}-${deploymentId}`.toLowerCase();
}

async function appendStageMarker(deployment, stageName, marker, result = null) {
  const suffix = marker === "END" && result ? ` ${result}` : "";
  await appendLog(deployment, `[[STAGE]] ${stageName} ${marker}${suffix}`);
}

function prefixStageLog(stageName, text) {
  const prefix = `[${stageName}] `;
  return text
    .toString()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

async function cleanupRunnerWorkspace(deploymentId) {
  const workDirBase = process.env.DEPLOY_WORKDIR_BASE || "/workspace/storage";
  const runDir = join(workDirBase, buildDeploymentWorkspaceSubPath(deploymentId));
  await rm(runDir, { recursive: true, force: true }).catch((error) => {
    logger.warn({ deploymentId, runDir, error }, "Failed to clean staged runner workspace");
  });
}

async function ensureRunnerWorkspaceRoot(deploymentId) {
  const workDirBase = process.env.DEPLOY_WORKDIR_BASE || "/workspace/storage";
  const runDir = join(workDirBase, buildDeploymentWorkspaceSubPath(deploymentId));
  await mkdir(runDir, { recursive: true });
}

function startRunnerWorkspaceCleanupLoop() {
  if (!useJobRunner) {
    return;
  }
  if (DEPLOY_WORKSPACE_CLEANUP_INTERVAL_MS <= 0 || DEPLOY_WORKSPACE_STALE_MAX_AGE_MS <= 0) {
    logger.info(
      {
        cleanupIntervalMs: DEPLOY_WORKSPACE_CLEANUP_INTERVAL_MS,
        staleMaxAgeMs: DEPLOY_WORKSPACE_STALE_MAX_AGE_MS,
      },
      "Runner workspace stale cleanup disabled",
    );
    return;
  }
  if (runnerWorkspaceCleanupTimer) {
    return;
  }
  const runCleanup = async () => {
    try {
      await cleanupStaleRunnerWorkspaces();
    } catch (error) {
      logger.warn({ err: error }, "Failed to cleanup stale runner workspaces");
    }
  };
  void runCleanup();
  runnerWorkspaceCleanupTimer = setInterval(runCleanup, DEPLOY_WORKSPACE_CLEANUP_INTERVAL_MS);
  if (typeof runnerWorkspaceCleanupTimer.unref === "function") {
    runnerWorkspaceCleanupTimer.unref();
  }
}

async function cleanupStaleRunnerWorkspaces(nowMs = Date.now()) {
  const workDirBase = process.env.DEPLOY_WORKDIR_BASE || "/workspace/storage";
  let entries;
  try {
    entries = await readdir(workDirBase, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!/^job-[0-9a-f-]{36}$/i.test(entry.name)) {
      continue;
    }

    const runDir = join(workDirBase, entry.name);
    let stats;
    try {
      stats = await stat(runDir);
    } catch {
      continue;
    }
    const touchedAtMs = Math.max(stats.mtimeMs || 0, stats.ctimeMs || 0);
    if (!Number.isFinite(touchedAtMs)) {
      continue;
    }
    if (nowMs - touchedAtMs < DEPLOY_WORKSPACE_STALE_MAX_AGE_MS) {
      continue;
    }

    await rm(runDir, { recursive: true, force: true });
    removed += 1;
  }

  if (removed > 0) {
    logger.info(
      { removed, workDirBase, staleMaxAgeMs: DEPLOY_WORKSPACE_STALE_MAX_AGE_MS },
      "Removed stale runner workspaces",
    );
  }
}

function buildDeploymentWorkspaceSubPath(deploymentId) {
  if (!UUID_PATTERN.test(String(deploymentId || ""))) {
    throw new Error(`Invalid deployment id for workspace isolation: "${deploymentId}"`);
  }
  return `job-${deploymentId}`;
}

function assertRunnerWorkspaceIsolation(jobSpec, deploymentId) {
  const expectedSubPath = buildDeploymentWorkspaceSubPath(deploymentId);
  const container = jobSpec?.spec?.template?.spec?.containers?.find(
    (item) => item?.name === "runner",
  );
  const workspaceMount = container?.volumeMounts?.find(
    (mount) => mount?.name === "workspace-storage",
  );
  if (!workspaceMount) {
    throw new Error("Runner workspace mount is missing in Job spec.");
  }
  if (workspaceMount.mountPath !== "/workspace/storage") {
    throw new Error("Runner workspace mountPath must be /workspace/storage.");
  }
  if (workspaceMount.subPath !== expectedSubPath) {
    throw new Error(
      `Runner workspace subPath mismatch: expected "${expectedSubPath}", got "${workspaceMount.subPath || ""}".`,
    );
  }
}

async function runDeploymentStageJob({
  stageName,
  jobName,
  deployment,
  buildConfig,
  network,
  deployMode,
  deploymentEnv,
  token,
  agent,
  host,
  port,
}) {
  const jobSpec = buildJobSpec(
    jobName,
    stageName,
    deployment,
    buildConfig,
    network,
    deployMode,
    deploymentEnv,
  );
  assertRunnerWorkspaceIsolation(jobSpec, deployment.id);

  const res = await fetch(`https://${host}:${port}/apis/batch/v1/namespaces/${k8sNamespace}/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jobSpec),
    agent,
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error(
      {
        status: res.status,
        statusText: res.statusText,
        body: text,
        namespace: k8sNamespace,
        jobName,
        stageName,
        host,
        port,
      },
      "Kubernetes Job creation failed",
    );
    throw new Error(
      `Failed to create ${stageName} runner Job (${res.status}): ${text || res.statusText}`,
    );
  }

  logger.info({ deploymentId: deployment.id, stageName, job: jobName }, "Runner stage Job created");

  return waitForJobAndLogs({
    stageName,
    jobName,
    deployment,
    token,
    agent,
    host,
    port,
  });
}

function readRequiredFile(path, encoding = undefined) {
  try {
    return readFileSync(path, encoding);
  } catch (error) {
    throw new Error(
      `Kubernetes client prerequisite missing: unable to read ${path} (${error.code || error.message}).`,
      { cause: error },
    );
  }
}

function assertKubernetesClientPrereqs({
  token,
  ca,
  host,
  port,
  isProd,
  useInsecureTls,
  tokenPath,
  caPath,
}) {
  const tokenValue = String(token || "").trim();
  if (!tokenValue) {
    throw new Error(
      `Kubernetes client prerequisite missing: serviceaccount token is empty at ${tokenPath}.`,
    );
  }

  const caBuf = Buffer.isBuffer(ca) ? ca : Buffer.from(String(ca || ""));
  if (caBuf.length === 0) {
    throw new Error(`Kubernetes client prerequisite missing: cluster CA is empty at ${caPath}.`);
  }

  const resolvedHost = String(host || "").trim();
  if (!resolvedHost) {
    throw new Error("Kubernetes client prerequisite missing: API host is empty.");
  }
  const allowedHosts = new Set(["kubernetes.default.svc", "kubernetes.default.svc.cluster.local"]);
  const serviceHost = String(process.env.KUBERNETES_SERVICE_HOST || "").trim();
  if (serviceHost) {
    allowedHosts.add(serviceHost);
  }
  if (!allowedHosts.has(resolvedHost)) {
    throw new Error(
      `Kubernetes API host "${resolvedHost}" is not in allowed hosts: ${Array.from(allowedHosts).join(", ")}.`,
    );
  }

  const resolvedPort = Number.parseInt(String(port || "").trim(), 10);
  if (!Number.isFinite(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    throw new Error(`Kubernetes API port "${port}" is invalid.`);
  }

  if (isProd && useInsecureTls) {
    throw new Error(
      "K8S_INSECURE_TLS cannot be enabled in production. Refusing to submit Kubernetes job.",
    );
  }
}

async function waitForJobAndLogs({ stageName, jobName, deployment, token, agent, host, port }) {
  const base = `https://${host}:${port}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const jobUrl = `${base}/apis/batch/v1/namespaces/${k8sNamespace}/jobs/${jobName}`;
  const labelSelector = encodeURIComponent(
    `icp-deployment-id=${deployment.id},icp-stage=${stageName}`,
  );
  const podsUrl = `${base}/api/v1/namespaces/${k8sNamespace}/pods?labelSelector=${labelSelector}`;

  while (true) {
    await wait(2000);

    const res = await fetch(jobUrl, { headers, agent });
    if (!res.ok) {
      await appendLog(
        deployment,
        prefixStageLog(stageName, `Job status check failed (${res.status}): ${await res.text()}`),
      );
      return { succeeded: false, failed: true };
    }
    const job = await res.json();
    const succeeded = Number(job?.status?.succeeded || 0) > 0;
    const failed =
      Number(job?.status?.failed || 0) > 0 ||
      job?.status?.conditions?.some((c) => c.type === "Failed");

    if (!succeeded && !failed) {
      continue;
    }

    try {
      const podsRes = await fetch(podsUrl, { headers, agent });
      if (!podsRes.ok) {
        await appendLog(
          deployment,
          prefixStageLog(
            stageName,
            `Failed to list runner pods (${podsRes.status}): ${await podsRes.text()}`,
          ),
        );
      } else {
        const pods = (await podsRes.json())?.items ?? [];
        const podName = pods[0]?.metadata?.name;
        if (podName) {
          const logRes = await fetch(
            `${base}/api/v1/namespaces/${k8sNamespace}/pods/${podName}/log?container=runner`,
            { headers, agent },
          );
          if (logRes.ok) {
            const logText = await logRes.text();
            await appendLog(deployment, prefixStageLog(stageName, logText));
          } else {
            await appendLog(
              deployment,
              prefixStageLog(
                stageName,
                `Failed to read runner logs (${logRes.status}): ${await logRes.text()}`,
              ),
            );
          }
        } else {
          await appendLog(
            deployment,
            prefixStageLog(stageName, "No runner pod found for deployment."),
          );
        }
      }
    } catch (error) {
      await appendLog(
        deployment,
        prefixStageLog(stageName, `Failed to read runner logs: ${error?.message || error}`),
      );
    }

    return {
      succeeded,
      failed,
    };
  }
}

export function buildJobSpec(
  name,
  stageName,
  deployment,
  buildConfig,
  network,
  deployMode,
  deploymentEnv = {},
) {
  if (!DEPLOYMENT_STAGE_ORDER.includes(stageName)) {
    throw new Error(`Unknown stage for job spec: ${stageName}`);
  }
  const workDirBase = process.env.DEPLOY_WORKDIR_BASE || "/workspace/storage";
  const runDir = "/workspace/storage";
  const workspaceSubPath = buildDeploymentWorkspaceSubPath(deployment.id);
  const args = [deployment.repoUrl, deployment.branch, runDir, "--network", network];
  const scriptName = "deploy-runner-staged.js";

  const identityNameEnv =
    process.env.DEPLOY_IDENTITY_NAME ||
    process.env.DFX_IDENTITY ||
    deployment.identity ||
    "workspace-alpha";
  const identityPemEnv = process.env.DEPLOY_IDENTITY_PEM || "/workspace/identity/identity.pem";
  const identitySecretName = process.env.DEPLOY_IDENTITY_SECRET || "identity-mainnet";
  const runnerNodeArch = (process.env.DEPLOY_NODE_ARCH || "").trim();
  const isDeployStage = stageName === "deploy";
  const isHostedDeployStage = isDeployStage && deployMode === "hosted";
  const activeDeadlineSeconds =
    stageName === "build"
      ? DEPLOY_BUILD_ACTIVE_DEADLINE_SECONDS
      : DEPLOY_DEPLOY_ACTIVE_DEADLINE_SECONDS;
  const ticketBundle = isHostedDeployStage ? buildDeployTicketForDeployment(deployment) : null;

  const env = [
    { name: "ICP_NETWORK", value: network },
    { name: "DEPLOY_MODE_TYPE", value: deployMode },
    { name: "DEPLOY_STAGE", value: stageName },
    {
      name: "DEPLOY_REPLICA_HOST",
      value:
        process.env.DEPLOY_REPLICA_HOST || "icp-replica.workspace-alpha.svc.cluster.local:4943",
    },
    { name: "HOME", value: "/home/node" },
    { name: "DEPLOY_WORKDIR_BASE", value: workDirBase },
    { name: "DEPLOY_MAX_ARTIFACT_MB", value: String(DEPLOY_MAX_ARTIFACT_MB) },
    { name: "DEPLOY_MAX_WORKSPACE_MB", value: String(DEPLOY_MAX_WORKSPACE_MB) },
  ];
  if (isDeployStage) {
    env.push({
      name: "DFX_IDENTITY",
      value: identityNameEnv || deployment.identity || "",
    });
    env.push({ name: "DEPLOY_IDENTITY_PEM", value: identityPemEnv });
    env.push({ name: "DEPLOY_IDENTITY_NAME", value: identityNameEnv });
  }
  if (deployMode === "hosted") {
    const resolvedHostCanisterId = deployment.metadata?.hostCanisterId;
    env.push({
      name: "HOST_CANISTER_ID",
      value: resolvedHostCanisterId || "",
    });
    env.push({
      name: "PROJECT_SLUG",
      value: deployment.metadata?.projectSlug || "",
    });
  }
  if (ticketBundle) {
    env.push({
      name: "DEPLOY_TICKET",
      value: ticketBundle.payload,
    });
    env.push({
      name: "DEPLOY_TICKET_SIGNATURE_B64",
      value: ticketBundle.signatureB64,
    });
    env.push({
      name: "DEPLOY_TICKET_KEY_ID",
      value: ticketBundle.keyId,
    });
  }

  if (isDeployStage && deployMode === "eject" && process.env.DFX_WALLET_CANISTER_ID) {
    env.push({
      name: "DFX_WALLET_CANISTER_ID",
      value: process.env.DFX_WALLET_CANISTER_ID,
    });
    env.push({
      name: "DFX_WALLET",
      value: process.env.DFX_WALLET_CANISTER_ID,
    });
  }
  if (isDeployStage && process.env.DFX_WARNING) {
    env.push({
      name: "DFX_WARNING",
      value: process.env.DFX_WARNING,
    });
  }

  for (const [key, val] of [
    ["DEPLOY_ROOT_DIR", buildConfig.rootDir],
    ["DEPLOY_OUTPUT_DIR", buildConfig.outputDir],
    ["DEPLOY_BUILD_COMMAND", buildConfig.buildCommand],
  ]) {
    if (val && !isDeployStage) {
      env.push({ name: key, value: val });
    }
  }
  if (!isDeployStage) {
    env.push({
      name: "A3_BUILD_ENV_JSON",
      value: JSON.stringify(validateCustomerEnv(deploymentEnv.customerEnv || {})),
    });
    for (const [name, value] of [
      ["GITHUB_INSTALLATION_TOKEN", deploymentEnv.githubInstallationToken],
      ["GITLAB_OAUTH_TOKEN", deploymentEnv.gitlabOAuthToken],
    ]) {
      if (value) env.push({ name, value: String(value) });
    }
  }

  const volumeMounts = [
    {
      name: "workspace-storage",
      mountPath: "/workspace/storage",
      subPath: workspaceSubPath,
      readOnly: isDeployStage,
    },
    {
      name: "runner-tmp",
      mountPath: "/tmp",
    },
    {
      name: "runner-home",
      mountPath: "/home/node",
    },
  ];
  const volumes = [
    {
      name: "workspace-storage",
      persistentVolumeClaim: {
        claimName: "workspace-alpha-artifacts",
      },
    },
    {
      name: "runner-tmp",
      emptyDir: { sizeLimit: DEPLOY_RUNNER_TMP_SIZE_LIMIT },
    },
    {
      name: "runner-home",
      emptyDir: { sizeLimit: DEPLOY_RUNNER_HOME_SIZE_LIMIT },
    },
  ];
  if (isDeployStage) {
    volumeMounts.push({
      name: "identity-secret",
      mountPath: "/workspace/identity",
      readOnly: true,
    });
    volumes.push({
      name: "identity-secret",
      secret: {
        secretName: identitySecretName,
      },
    });
  }
  const runnerAffinity = DEPLOY_RUNNER_COLOCATE_WITH_BACKEND
    ? {
        podAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [
            {
              labelSelector: {
                matchExpressions: [
                  {
                    key: DEPLOY_BACKEND_POD_LABEL_KEY,
                    operator: "In",
                    values: [DEPLOY_BACKEND_POD_LABEL_VALUE],
                  },
                ],
              },
              topologyKey: DEPLOY_RUNNER_COLOCATION_TOPOLOGY_KEY,
            },
          ],
        },
      }
    : null;

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: k8sNamespace,
      labels: {
        "app.kubernetes.io/name": "icp-runner",
        "app.kubernetes.io/part-of": "icp-deployer",
        "icp-deployment-id": deployment.id,
        "icp-stage": stageName,
      },
    },
    spec: {
      ttlSecondsAfterFinished: 300,
      backoffLimit: 0,
      activeDeadlineSeconds,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "icp-runner",
            "icp-deployment-id": deployment.id,
            "icp-stage": stageName,
          },
        },
        spec: {
          restartPolicy: "Never",
          enableServiceLinks: false,
          hostNetwork: false,
          automountServiceAccountToken: false,
          serviceAccountName: isDeployStage
            ? runnerDeployServiceAccount
            : runnerBuildServiceAccount,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          ...(runnerNodeArch ? { nodeSelector: { "kubernetes.io/arch": runnerNodeArch } } : {}),
          ...(runnerAffinity ? { affinity: runnerAffinity } : {}),
          ...(runnerImagePullSecret ? { imagePullSecrets: [{ name: runnerImagePullSecret }] } : {}),
          containers: [
            {
              name: "runner",
              image: runnerJobImage,
              imagePullPolicy: "Always",
              command: ["node", `/app/scripts/${scriptName}`],
              args,
              env,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: {
                  drop: ["ALL"],
                },
              },
              resources: {
                requests: {
                  cpu: DEPLOY_RUNNER_REQUEST_CPU,
                  memory: DEPLOY_RUNNER_REQUEST_MEMORY,
                  "ephemeral-storage": DEPLOY_RUNNER_REQUEST_EPHEMERAL_STORAGE,
                },
                limits: {
                  cpu: DEPLOY_RUNNER_LIMIT_CPU,
                  memory: DEPLOY_RUNNER_LIMIT_MEMORY,
                  "ephemeral-storage": DEPLOY_RUNNER_LIMIT_EPHEMERAL_STORAGE,
                },
              },
              volumeMounts,
            },
          ],
          volumes,
        },
      },
    },
  };
}

function resolveDeployModeType() {
  const raw = (process.env.DEPLOY_MODE_TYPE || "").toLowerCase();
  if (raw === "hosted" || raw === "eject") {
    return raw;
  }
  throw new Error("DEPLOY_MODE_TYPE must be either 'hosted' or 'eject'.");
}

function normalizeDeployMode(value) {
  const raw = (value || "").toLowerCase();
  if (raw === "hosted" || raw === "eject") {
    return raw;
  }
  throw new Error("deployMode must be either 'hosted' or 'eject'.");
}

async function finalizeEject(deployment, deployMode) {
  const ejectRequestId = deployment.metadata?.ejectRequestId;
  if (deployMode !== "eject" || !ejectRequestId) {
    return;
  }
  const targetPrincipal = deployment.metadata?.targetPrincipal;
  try {
    if (deployment.status !== "succeeded") {
      await setEjectRequestStatus(ejectRequestId, "failed");
      return;
    }
    if (!targetPrincipal) {
      await appendLog(deployment, "Eject failed: target principal is missing.");
      await setEjectRequestStatus(ejectRequestId, "failed");
      return;
    }
    if (!deployment.canisterId) {
      await appendLog(deployment, "Eject failed: missing canister id for controller transfer.");
      await setEjectRequestStatus(ejectRequestId, "failed");
      return;
    }
    await appendLog(deployment, "Eject: transferring canister controllers...");
    await updateCanisterControllers({
      canisterId: deployment.canisterId,
      targetPrincipal,
      network: deployment.network || process.env.ICP_NETWORK || "local",
      identity: deployment.identity ?? null,
    });
    await setEjectRequestStatus(ejectRequestId, "complete");
    await appendLog(deployment, "Eject: controller transfer complete.");
  } catch (error) {
    logger.error({ error }, "Eject controller transfer failed");
    await appendLog(deployment, `Eject controller transfer failed: ${error?.message || error}`);
    await setEjectRequestStatus(ejectRequestId, "failed");
  }
}

async function setEjectRequestStatus(id, status) {
  await pool.query("update eject_requests set status = $2 where id = $1", [id, status]);
}

async function updateCanisterControllers({ canisterId, targetPrincipal, network, identity }) {
  const args = [
    "canister",
    "update-settings",
    canisterId,
    "--set-controller",
    targetPrincipal,
    "--network",
    network,
    "--yes",
  ];
  if (identity) {
    args.push("--identity", identity);
  }
  if (process.env.DFX_WALLET_CANISTER_ID && network !== "local") {
    args.push("--wallet", process.env.DFX_WALLET_CANISTER_ID);
  }
  await execDfxCommand(args);
}

function execDfxCommand(args, options = {}) {
  const command = process.env.DFX_PATH || "dfx";
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: join(__dirname, "..", ".."),
        env: { ...process.env, ...(options.env || {}) },
      },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr || stdout || error.message;
          return reject(new Error(msg));
        }
        resolve(stdout);
      },
    );
  });
}

async function getTenantByProjectId(projectId) {
  const res = await pool.query(
    `select t.id, t.slug, t.project_id, t.domain_mode,
            hc.canister_id as host_canister_id,
            hc.alias as host_canister_alias,
            hc.region as host_canister_region,
            hc.visibility as host_canister_visibility
     from tenants t
     join tenant_hosts th on th.tenant_id = t.id
     join host_canisters hc on hc.id = th.host_canister_id
     where t.project_id = $1
     limit 1`,
    [projectId],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    slug: row.slug,
    projectId: row.project_id,
    hostCanisterId: row.host_canister_id,
    hostCanisterAlias: row.host_canister_alias ?? null,
    hostCanisterRegion: normalizeHostCanisterRegion(row.host_canister_region || "global"),
    hostCanisterVisibility: normalizeHostCanisterVisibility(
      row.host_canister_visibility || "public",
    ),
    domainMode: row.domain_mode ?? "legacy",
  };
}

async function getTenantById(tenantId) {
  const res = await pool.query(
    `select t.id, t.slug, t.project_id, t.domain_mode,
            hc.canister_id as host_canister_id,
            hc.alias as host_canister_alias,
            hc.region as host_canister_region,
            hc.visibility as host_canister_visibility
     from tenants t
     join tenant_hosts th on th.tenant_id = t.id
     join host_canisters hc on hc.id = th.host_canister_id
     where t.id = $1
     limit 1`,
    [tenantId],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    slug: row.slug,
    projectId: row.project_id,
    hostCanisterId: row.host_canister_id,
    hostCanisterAlias: row.host_canister_alias ?? null,
    hostCanisterRegion: normalizeHostCanisterRegion(row.host_canister_region || "global"),
    hostCanisterVisibility: normalizeHostCanisterVisibility(
      row.host_canister_visibility || "public",
    ),
    domainMode: row.domain_mode ?? "legacy",
  };
}

async function getTenantBySlug(slug) {
  const res = await pool.query(
    `select t.id, t.slug, t.project_id
     from tenants t
     where lower(t.slug) = lower($1)
     limit 1`,
    [slug],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    slug: row.slug,
    projectId: row.project_id,
  };
}

function selectHostedCanisterTarget(tenantMapping) {
  return {
    hostCanisterId: tenantMapping?.hostCanisterId ?? null,
    hostCanisterAlias: tenantMapping?.hostCanisterAlias ?? null,
  };
}

async function selectActiveHostCanister({ region = "global", visibility = "public" } = {}) {
  const normalizedRegion = normalizeHostCanisterRegion(region || "global");
  const normalizedVisibility = normalizeHostCanisterVisibility(visibility || "public");
  const res = await pool.query(
    `select hc.id, hc.canister_id, hc.alias, hc.region, hc.visibility
     from host_canisters hc
     left join tenant_hosts th on th.host_canister_id = hc.id
     where hc.status = 'active'
       and hc.region = $1
       and hc.visibility = $2
     group by hc.id, hc.canister_id, hc.alias, hc.region, hc.visibility, hc.capacity, hc.created_at
     having hc.capacity is null or count(th.tenant_id) < hc.capacity
     order by count(th.tenant_id) asc, random()
     limit 1`,
    [normalizedRegion, normalizedVisibility],
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    canisterId: row.canister_id,
    alias: row.alias,
    region: normalizeHostCanisterRegion(row.region || normalizedRegion),
    visibility: normalizeHostCanisterVisibility(row.visibility || normalizedVisibility),
  };
}

async function ensureTenantForProject(projectId, slug, routing = {}) {
  const normalizedSlug = normalizeSlug(slug);
  const validationError = validateSlug(normalizedSlug);
  if (validationError) {
    throw new Error(validationError);
  }

  const existing = await getTenantByProjectId(projectId);
  if (existing) {
    if (existing.slug !== normalizedSlug) {
      throw new Error("Tenant slug is immutable once created.");
    }
    return existing;
  }

  const existingBySlug = await getTenantBySlug(normalizedSlug);
  if (existingBySlug) {
    throw new Error("Slug already in use.");
  }

  const region = normalizeHostCanisterRegion(routing.region || "global");
  const visibility = normalizeHostCanisterVisibility(routing.visibility || "public");
  const host = await selectActiveHostCanister({ region, visibility });
  if (!host) {
    throw new Error(
      visibility === "private"
        ? `No active private host canister is available in ${region}.`
        : "No active public host canister available.",
    );
  }

  const tenantId = randomUUID();
  await pool.query(
    `insert into tenants (id, project_id, slug, domain_mode, created_at)
     values ($1, $2, $3, 'canister_alias', now())`,
    [tenantId, projectId, normalizedSlug],
  );
  await pool.query(
    `insert into tenant_hosts (tenant_id, host_canister_id, created_at)
     values ($1, $2, now())`,
    [tenantId, host.id],
  );
  await pool.query(
    `update projects set tenant_id = $2, region = $3, updated_at = now() where id = $1`,
    [projectId, tenantId, region],
  );

  return {
    id: tenantId,
    slug: normalizedSlug,
    projectId,
    hostCanisterId: host.canisterId,
    hostCanisterAlias: host.alias ?? null,
    hostCanisterRegion: host.region,
    hostCanisterVisibility: host.visibility,
    domainMode: "canister_alias",
  };
}

function buildHostedUrl({ slug, domainMode = "legacy", hostCanisterAlias = null }) {
  const base = (process.env.HOST_BASE_DOMAIN || "example.com").trim();
  const aliasSeparator = getHostAliasLabelSeparator();
  if (!base || !slug) {
    return null;
  }
  if (domainMode === "canister_alias" && hostCanisterAlias) {
    return `https://${slug}${aliasSeparator}${hostCanisterAlias}.${base}`;
  }
  return `https://${slug}.${base}`;
}

function getHostAliasLabelSeparator() {
  const raw = (process.env.HOST_ALIAS_LABEL_SEPARATOR || "--").trim();
  return raw && /^[a-z0-9-]+$/i.test(raw) ? raw : "--";
}

function normalizeSlug(input) {
  return (input || "").trim().toLowerCase();
}

function isValidSlug(slug) {
  return /^[a-z0-9-]+$/.test(slug);
}

function validateSlug(slug) {
  if (!slug) {
    return "slug is required.";
  }
  if (slug.length > SLUG_MAX_LEN) {
    return `slug must be ${SLUG_MAX_LEN} characters or fewer.`;
  }
  if (!isValidSlug(slug)) {
    return "slug may only include lowercase letters, numbers, and dashes.";
  }
  return null;
}

function normalizeStageStatus(rawStatus) {
  const normalized = String(rawStatus || "")
    .trim()
    .toLowerCase();
  if (normalized === "queued" || normalized === "pending" || normalized === "not_started") {
    return "pending";
  }
  if (normalized === "running") {
    return "running";
  }
  if (normalized === "succeeded" || normalized === "failed") {
    return normalized;
  }
  return null;
}

function extractGitHeadBranchFromRef(ref) {
  const normalizedRef = String(ref || "").trim();
  const prefix = "refs/heads/";
  if (!normalizedRef.startsWith(prefix)) {
    return null;
  }
  const branch = normalizedRef.slice(prefix.length).trim();
  return branch.length > 0 ? branch : null;
}

async function updateDeploymentStage(deployment, stageName, updates = {}) {
  if (!DEPLOYMENT_STAGE_ORDER.includes(stageName)) {
    throw new Error(`Unknown deployment stage "${stageName}".`);
  }
  const previousStages = normalizeDeploymentStages(deployment.stages);
  const previousStage = previousStages[stageName];
  const normalizedStatus = updates.status ? normalizeStageStatus(updates.status) : null;
  if (updates.status && !normalizedStatus) {
    throw new Error(`Invalid stage status "${updates.status}" for stage "${stageName}".`);
  }

  const nextStage = {
    ...previousStage,
    ...(normalizedStatus ? { status: normalizedStatus } : {}),
    ...(updates.startedAt !== undefined ? { startedAt: toStageMillis(updates.startedAt) } : {}),
    ...(updates.finishedAt !== undefined ? { finishedAt: toStageMillis(updates.finishedAt) } : {}),
    ...(updates.jobName !== undefined
      ? {
          jobName:
            typeof updates.jobName === "string" && updates.jobName.trim()
              ? updates.jobName.trim()
              : null,
        }
      : {}),
  };
  if (nextStage.status === "running" && !nextStage.startedAt) {
    nextStage.startedAt = Date.now();
  }
  if (DEPLOYMENT_STAGE_TERMINAL.has(nextStage.status) && !nextStage.finishedAt) {
    nextStage.finishedAt = Date.now();
  }

  const nextStages = {
    ...previousStages,
    [stageName]: nextStage,
  };

  await pool.query("update deployments set stages = $2::jsonb where id = $1", [
    deployment.id,
    JSON.stringify(nextStages),
  ]);
  deployment.stages = nextStages;

  if (
    previousStage.status !== nextStage.status &&
    DEPLOYMENT_STAGE_TERMINAL.has(nextStage.status)
  ) {
    await createDeploymentStageNotification({
      deployment,
      stageName,
      status: nextStage.status,
    });
  }
}

async function createDeploymentStageNotification({ deployment, stageName, status }) {
  const res = await pool.query(
    `select p.id as project_id, p.user_id, p.repo_url, t.slug
     from projects p
     left join tenants t on t.id = p.tenant_id
     where p.id = $1
     limit 1`,
    [deployment.projectId],
  );
  const row = res.rows[0];
  if (!row?.user_id) {
    return;
  }
  const label = row.slug || row.repo_url || "project";
  const succeeded = status === "succeeded";
  const stageLabel = stageName === "build" ? "Build" : "Deploy";
  const eventKey = `deployment-stage:${deployment.id}:${stageName}:${status}`;
  await pool.query(
    `insert into notifications (
      id, user_id, type, title, body, project_id, deployment_id, event_key, created_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, now())
    on conflict do nothing`,
    [
      randomUUID(),
      row.user_id,
      succeeded ? `deployment_${stageName}_succeeded` : `deployment_${stageName}_failed`,
      `${stageLabel} stage for "${label}" ${succeeded ? "succeeded" : "failed"}`,
      succeeded
        ? `${stageLabel} stage completed successfully.`
        : `${stageLabel} stage failed. Check deployment logs for details.`,
      row.project_id,
      deployment.id,
      eventKey,
    ],
  );
}

async function setStatus(deployment, updates) {
  const previousStatus = normalizeDeploymentStatus(deployment.status);
  const nextStatus = updates.status ? normalizeDeploymentStatus(updates.status) : null;
  const startedAt = updates.startedAt ? new Date(updates.startedAt) : null;
  const finishedAt = updates.finishedAt ? new Date(updates.finishedAt) : null;
  const processingStartedAt =
    nextStatus === "processing"
      ? updates.processingStartedAt
        ? new Date(updates.processingStartedAt)
        : new Date()
      : null;
  const processingDeadlineAt =
    nextStatus === "processing"
      ? updates.processingDeadlineAt
        ? new Date(updates.processingDeadlineAt)
        : new Date(Date.now() + DEPLOY_PROCESSING_TIMEOUT_MS)
      : null;
  const res = await pool.query(
    `update deployments set
        status = coalesce($2::text, status),
        started_at = coalesce($3, started_at),
        finished_at = coalesce($4, finished_at),
        duration_ms = coalesce($5, duration_ms),
        processing_started_at = case
          when $2::text = 'processing' then coalesce($6, processing_started_at, now())
          else processing_started_at
        end,
        processing_deadline_at = case
          when $2::text = 'processing' then coalesce(
            $7,
            processing_deadline_at,
            now() + ($8::int * interval '1 millisecond')
          )
          when $2::text in ('succeeded', 'failed') then null
          else processing_deadline_at
        end
      where id = $1
        and ($2::text is null or status not in ('succeeded', 'failed') or status = $2::text)
      returning project_id`,
    [
      deployment.id,
      nextStatus,
      startedAt,
      finishedAt,
      updates.durationMs ?? null,
      processingStartedAt,
      processingDeadlineAt,
      DEPLOY_PROCESSING_TIMEOUT_MS,
    ],
  );
  if (res.rowCount === 0) {
    return;
  }
  const projectId = res.rows[0]?.project_id;
  if (projectId) {
    await pool.query(
      `update projects set
          last_deployment_status = coalesce($3, last_deployment_status),
          last_deployment_identity = $4,
          updated_at = now()
        where id = $1 and last_deployment_id = $2`,
      [projectId, deployment.id, nextStatus, deployment.identity ?? null],
    );
  }

  if (
    nextStatus &&
    nextStatus !== previousStatus &&
    (nextStatus === "succeeded" || nextStatus === "failed")
  ) {
    await createDeploymentStatusNotification({
      deployment,
      projectId,
      status: nextStatus,
    });
  }

  if (previousStatus === "processing" && (nextStatus === "succeeded" || nextStatus === "failed")) {
    logger.info(
      {
        event: "slot_released",
        deploymentId: deployment.id,
        projectId,
        assignedHostCanisterId: deployment.assignedHostCanisterId ?? null,
      },
      "Deployment queue slot released",
    );
    logger.info(
      {
        event: "completed",
        deploymentId: deployment.id,
        projectId,
        status: nextStatus,
      },
      "Deployment completed",
    );
  }

  Object.assign(deployment, {
    ...updates,
    ...(nextStatus ? { status: nextStatus } : {}),
    ...(processingStartedAt ? { processingStartedAt: processingStartedAt.getTime() } : {}),
    ...(nextStatus === "succeeded" || nextStatus === "failed"
      ? { processingDeadlineAt: null }
      : {}),
  });
}

async function createDeploymentStatusNotification({ deployment, projectId, status }) {
  if (!projectId) {
    return;
  }
  const res = await pool.query(
    `select p.user_id, p.repo_url, t.slug
     from projects p
     left join tenants t on t.id = p.tenant_id
     where p.id = $1
     limit 1`,
    [projectId],
  );
  const row = res.rows[0];
  if (!row?.user_id) {
    return;
  }
  const label = row.slug || row.repo_url || "project";
  const succeeded = status === "succeeded";
  const title = `Deployment for "${label}" ${succeeded ? "succeeded" : "failed"}`;
  const body = succeeded
    ? "Your latest deployment finished successfully."
    : "Your latest deployment failed. Open logs for details.";
  const eventKey = `deployment-final:${deployment.id}:${status}`;
  await pool.query(
    `insert into notifications (
      id, user_id, type, title, body, project_id, deployment_id, event_key, created_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, now())
    on conflict do nothing`,
    [
      randomUUID(),
      row.user_id,
      succeeded ? "deployment_succeeded" : "deployment_failed",
      title,
      body,
      projectId,
      deployment.id,
      eventKey,
    ],
  );
}

async function appendLog(deployment, chunk) {
  const text = chunk.toString();
  const lines = [];
  let endpoint = deployment.endpoint ?? null;
  let canisterId = deployment.canisterId ?? null;
  let canisterName = deployment.canisterName ?? null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }
    lines.push(line);
    endpoint ||= extractEndpoint(line, deployment);
    canisterId ||= extractCanisterId(line);
    canisterName ||= extractCanisterName(line);
  }

  if (!lines.length) {
    return;
  }

  await pool.query(
    `update deployments set
        logs = coalesce(logs, '{}') || $1::text[],
        endpoint = coalesce(endpoint, $2),
        canister_id = coalesce(canister_id, $3),
        canister_name = coalesce(canister_name, $4)
      where id = $5`,
    [lines, endpoint, canisterId, canisterName, deployment.id],
  );

  if (deployment.projectId) {
    await pool.query(
      `update projects set
          last_deployment_endpoint = coalesce(last_deployment_endpoint, $2),
          last_deployment_canister_id = coalesce(last_deployment_canister_id, $3),
          last_deployment_identity = coalesce(last_deployment_identity, $4),
          updated_at = now()
        where id = $1 and last_deployment_id = $5`,
      [deployment.projectId, endpoint, canisterId, deployment.identity ?? null, deployment.id],
    );
  }

  deployment.logs = [...(deployment.logs || []), ...lines];
  deployment.endpoint ||= endpoint;
  deployment.canisterId ||= canisterId;
  deployment.canisterName ||= canisterName;
}

const CANISTER_URL_PATTERN = /CANISTER_URL=([^\s]+)/;
const CANISTER_ID_PATTERN = /CANISTER_ID=([^\s]+)/;
const CANISTER_NAME_PATTERN = /CANISTER_NAME=([^\s]+)/;

function extractEndpoint(line, deployment) {
  const hostedSlug = deployment?.metadata?.projectSlug || null;
  const hostCanisterId = deployment?.metadata?.hostCanisterId || null;
  const hostCanisterAlias = deployment?.metadata?.hostCanisterAlias || null;
  const domainMode = deployment?.metadata?.domainMode || "legacy";
  if (hostCanisterId && hostedSlug) {
    const hostedUrl = buildHostedUrl({
      slug: hostedSlug,
      domainMode,
      hostCanisterAlias,
    });
    if (hostedUrl) {
      return hostedUrl;
    }
  }
  const match = CANISTER_URL_PATTERN.exec(line);
  return match ? match[1] : null;
}

function extractCanisterId(line) {
  const match = CANISTER_ID_PATTERN.exec(line);
  return match ? match[1] : null;
}

function extractCanisterName(line) {
  const match = CANISTER_NAME_PATTERN.exec(line);
  return match ? match[1] : null;
}

function getBaseUrl(req) {
  const protocol = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${protocol}://${host}`;
}

function getApiBaseUrl(req) {
  const configured = (process.env.API_BASE_URL || "").trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const protocol = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = String(req.get("x-forwarded-host") || req.get("host") || "").trim();
  if (!host) {
    return `${protocol}://localhost:3000`;
  }
  if (host.toLowerCase().startsWith("ui.")) {
    return `${protocol}://api.${host.slice(3)}`;
  }
  return `${protocol}://${host}`;
}

function buildProjectWebhookUrl(req, project) {
  const provider = normalizeGitProvider(project?.gitProvider);
  const path = provider === "gitlab" ? "/gitlab/webhook" : "/github/webhook";
  return `${getApiBaseUrl(req)}${path}`;
}

function getFrontendBaseUrl(req) {
  if (appPublicUrl) {
    return appPublicUrl;
  }
  const requestOrigin = getRequestOrigin(req);
  if (requestOrigin) {
    return requestOrigin;
  }
  const configured = (process.env.FRONTEND_BASE_URL || "").trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  return getBaseUrl(req);
}

function verifyGitHubSignature(signature, body, secret) {
  if (!signature || !secret || !signature.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const provided = signature.slice("sha256=".length);
  return safeCompare(provided, expected);
}

function verifyGitLabWebhookToken(providedToken, expectedToken) {
  const provided = String(providedToken || "");
  const expected = String(expectedToken || "");
  if (!provided || !expected) {
    return false;
  }
  return safeCompare(provided, expected);
}

function safeCompare(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function statusForEnvVarError(error, fallback = 400) {
  const message = String(error?.message || "");
  const lower = message.toLowerCase();
  if (lower.includes("kms is not configured") || lower.includes("encryption is not configured")) {
    return 500;
  }
  return fallback;
}

function resolveSessionCookieDomain({ rawDomain, isProduction }) {
  const value = String(rawDomain || "").trim();
  if (!value) {
    return undefined;
  }
  if (isProduction) {
    return undefined;
  }
  return value;
}

function resolveCsrfCookieDomain(rawDomain) {
  const value = String(rawDomain || "").trim();
  if (!value) {
    return undefined;
  }
  return value;
}

function normalizeOriginValue(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function parseAllowedOrigins(raw) {
  const set = new Set();
  for (const item of String(raw || "").split(",")) {
    const origin = normalizeOriginValue(item);
    if (origin) {
      set.add(origin);
    }
  }
  return set;
}

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.size === 0) {
    return process.env.NODE_ENV !== "production";
  }
  return ALLOWED_ORIGINS.has(origin);
}

function getClientIp(req) {
  const forwarded = String(req.get("x-forwarded-for") || "")
    .split(",")[0]
    ?.trim();
  const fallback = req.ip || req.socket?.remoteAddress || "";
  const value = (forwarded || fallback || "unknown").replace(/^::ffff:/, "");
  return value.toLowerCase();
}

function rateLimitKey(...parts) {
  return parts
    .map((part) => normalizeRateLimitKeyPart(part))
    .filter(Boolean)
    .join(":");
}

function normalizeRateLimitKeyPart(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:@-]/g, "_");
  if (!normalized) {
    return "unknown";
  }
  return normalized.slice(0, 180);
}

async function enforceDeployUserRateLimits(req, res, userId) {
  return enforceRequestRateLimits(req, res, [
    {
      key: rateLimitKey("deploy", "user", "minute", userId),
      ...RATE_LIMIT_RULES.deployPerUserMinute,
      label: "deploy:user:minute",
    },
    {
      key: rateLimitKey("deploy", "user", "day", userId),
      ...RATE_LIMIT_RULES.deployPerUserDay,
      label: "deploy:user:day",
    },
  ]);
}

async function enforceDeployProjectRateLimit(req, res, projectId) {
  return enforceRequestRateLimits(req, res, [
    {
      key: rateLimitKey("deploy", "project", "minute", projectId),
      ...RATE_LIMIT_RULES.deployPerProjectMinute,
      label: "deploy:project:minute",
    },
  ]);
}

async function enforceDeployRateLimits(req, res, userId, projectId) {
  const userAllowed = await enforceDeployUserRateLimits(req, res, userId);
  if (!userAllowed) {
    return false;
  }
  return enforceDeployProjectRateLimit(req, res, projectId);
}

async function enforceRequestRateLimits(req, res, rules = []) {
  for (const rule of rules) {
    const result = await consumeRateLimitBucket(rule);
    if (result.allowed) {
      continue;
    }
    const retryAfter = Math.max(1, result.retryAfterSeconds || 1);
    res.setHeader("Retry-After", String(retryAfter));
    logger.warn(
      {
        path: req.path,
        method: req.method,
        ip: getClientIp(req),
        rule: rule.label || rule.key,
        observedCount: result.count,
        limit: rule.limit,
        retryAfterSeconds: retryAfter,
      },
      "Request rate-limited",
    );
    res.status(429).json({ error: RATE_LIMIT_ERROR_MESSAGE });
    return false;
  }
  return true;
}

async function consumeRateLimitBucket({ key, limit, windowMs }) {
  const nowMs = Date.now();
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const expiresAtMs = windowStartMs + windowMs * 2;
  const windowSeconds = Math.max(1, Math.floor(windowMs / 1000));
  const res = await pool.query(
    `insert into rate_limit_buckets (key, window_start, window_seconds, count, expires_at)
     values (
       $1,
       to_timestamp($2 / 1000.0),
       $3,
       1,
       to_timestamp($4 / 1000.0)
     )
     on conflict (key, window_start, window_seconds)
     do update
       set count = rate_limit_buckets.count + 1,
           expires_at = greatest(rate_limit_buckets.expires_at, excluded.expires_at)
     returning count`,
    [key, windowStartMs, windowSeconds, expiresAtMs],
  );
  await maybeCleanupRateLimitBuckets(nowMs);
  const count = Number.parseInt(String(res.rows[0]?.count ?? 0), 10);
  const retryAfterSeconds = Math.ceil(Math.max(1000, windowStartMs + windowMs - nowMs) / 1000);
  return {
    allowed: Number.isFinite(count) ? count <= limit : false,
    count: Number.isFinite(count) ? count : 0,
    retryAfterSeconds,
  };
}

async function maybeCleanupRateLimitBuckets(nowMs = Date.now()) {
  if (nowMs - lastRateLimitCleanupAt < RATE_LIMIT_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastRateLimitCleanupAt = nowMs;
  try {
    await pool.query("delete from rate_limit_buckets where expires_at < now()");
  } catch (error) {
    logger.warn({ err: error }, "Failed to cleanup stale rate-limit buckets");
  }
}

function assertEnvVarsKmsReady() {
  if (!isEnvVarsKmsConfigured()) {
    throw new Error(
      "Environment variable encryption is not configured. Use local_encrypted + ENV_VARS_MASTER_KEY (recommended) or gcp_kms + ENV_VARS_KMS_KEY_NAME.",
    );
  }
}

function validateEnvVarKey(key) {
  if (!key || typeof key !== "string") {
    return "key is required.";
  }
  if (!ENV_KEY_PATTERN.test(key)) {
    return "key must match /^[A-Z_][A-Z0-9_]*$/";
  }
  if (key.length > 128) {
    return "key must be 128 chars or fewer.";
  }
  if (!isSafeCustomerEnvKey(key)) {
    return `key "${key}" is reserved and cannot be overridden.`;
  }
  return null;
}

function normalizeProjectEnvVarInput(input = {}) {
  const key = String(input.key || "")
    .trim()
    .toUpperCase();
  const value = String(input.value ?? "");
  const isSecret = input.isSecret !== false;
  const keyError = validateEnvVarKey(key);
  if (keyError) {
    throw new Error(keyError);
  }
  if (value.length > MAX_ENV_VALUE_LEN) {
    throw new Error(`value for "${key}" exceeds ${MAX_ENV_VALUE_LEN} characters.`);
  }
  return { key, value, isSecret };
}

function normalizeProjectEnvVarInputs(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("envVars must be an array.");
  }
  if (entries.length > MAX_ENV_VARS_PER_PROJECT) {
    throw new Error(`max ${MAX_ENV_VARS_PER_PROJECT} environment variables per project.`);
  }
  const seen = new Set();
  const normalized = entries.map((entry) => normalizeProjectEnvVarInput(entry));
  for (const item of normalized) {
    if (seen.has(item.key)) {
      throw new Error(`Duplicate key "${item.key}" in request.`);
    }
    seen.add(item.key);
  }
  return normalized;
}

function mapProjectEnvVarRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    isSecret: row.is_secret,
    kmsKeyName: row.kms_key_name,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
    value: row.value ?? null,
    valuePreview: row.is_secret ? "••••••" : (row.value ?? ""),
  };
}

async function getProjectEnvVarCount(projectId) {
  const res = await pool.query(
    "select count(*)::int as count from project_env_vars where project_id = $1",
    [projectId],
  );
  return res.rows[0]?.count ?? 0;
}

async function listProjectEnvVarRows(projectId) {
  const res = await pool.query(
    `select id, project_id, key, value_ciphertext, is_secret, kms_key_name,
            created_by, updated_by, created_at, updated_at
     from project_env_vars
     where project_id = $1
     order by key asc`,
    [projectId],
  );
  return res.rows;
}

async function listProjectEnvVars(projectId, { includeValues = false } = {}) {
  const rows = await listProjectEnvVarRows(projectId);
  const out = [];
  for (const row of rows) {
    let value = null;
    if (includeValues && !row.is_secret) {
      value = await decryptEnvVarSecret(row.value_ciphertext, {
        projectId,
        key: row.key,
      });
    }
    out.push(
      mapProjectEnvVarRow({
        ...row,
        value,
      }),
    );
  }
  return out;
}

async function upsertProjectEnvVar({ userId, projectId, key, value, isSecret }) {
  assertEnvVarsKmsReady();
  const existingCount = await getProjectEnvVarCount(projectId);
  const existing = await pool.query(
    `select id from project_env_vars
     where project_id = $1 and key = $2
     limit 1`,
    [projectId, key],
  );
  if (!existing.rows[0] && existingCount >= MAX_ENV_VARS_PER_PROJECT) {
    throw new Error(`max ${MAX_ENV_VARS_PER_PROJECT} environment variables per project.`);
  }
  const ciphertext = await encryptEnvVarSecret(value, { projectId, key });
  const kmsKeyName = getEnvVarsKmsKeyName();
  const res = await pool.query(
    `insert into project_env_vars (
        id, project_id, key, value_ciphertext, is_secret, kms_key_name,
        created_by, updated_by, created_at, updated_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $7, now(), now()
      )
      on conflict (project_id, key) do update set
        value_ciphertext = excluded.value_ciphertext,
        is_secret = excluded.is_secret,
        kms_key_name = excluded.kms_key_name,
        updated_by = excluded.updated_by,
        updated_at = now()
      returning *`,
    [randomUUID(), projectId, key, ciphertext, isSecret, kmsKeyName, userId],
  );
  logger.info({ userId, projectId, key }, "Project env var upserted");
  return mapProjectEnvVarRow(res.rows[0]);
}

async function patchProjectEnvVar({ userId, projectId, envVarId, input }) {
  const existingRes = await pool.query(
    `select *
     from project_env_vars
     where id = $1 and project_id = $2
     limit 1`,
    [envVarId, projectId],
  );
  const existing = existingRes.rows[0];
  if (!existing) {
    return null;
  }
  const nextKey =
    input.key !== undefined
      ? String(input.key || "")
          .trim()
          .toUpperCase()
      : existing.key;
  const keyError = validateEnvVarKey(nextKey);
  if (keyError) {
    throw new Error(keyError);
  }
  const nextIsSecret = input.isSecret === undefined ? existing.is_secret : input.isSecret !== false;
  const shouldRotateValue = input.value !== undefined;
  const nextValue =
    input.value !== undefined
      ? String(input.value ?? "")
      : await decryptEnvVarSecret(existing.value_ciphertext, {
          projectId,
          key: existing.key,
        });
  if (nextValue.length > MAX_ENV_VALUE_LEN) {
    throw new Error(`value for "${nextKey}" exceeds ${MAX_ENV_VALUE_LEN} characters.`);
  }
  const ciphertext = await encryptEnvVarSecret(nextValue, {
    projectId,
    key: nextKey,
  });
  const res = await pool.query(
    `update project_env_vars set
        key = $3,
        value_ciphertext = $4,
        is_secret = $5,
        kms_key_name = $6,
        updated_by = $7,
        updated_at = now()
     where id = $1 and project_id = $2
     returning *`,
    [envVarId, projectId, nextKey, ciphertext, nextIsSecret, getEnvVarsKmsKeyName(), userId],
  );
  if (res.rows[0]) {
    logger.info(
      { userId, projectId, key: nextKey, rotated: shouldRotateValue },
      "Project env var updated",
    );
  }
  return res.rows[0] ? mapProjectEnvVarRow(res.rows[0]) : null;
}

async function deleteProjectEnvVar(projectId, envVarId) {
  const res = await pool.query("delete from project_env_vars where id = $1 and project_id = $2", [
    envVarId,
    projectId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

function parseDotenvContent(content) {
  const lines = String(content || "").split(/\r?\n/);
  const entries = [];
  const invalid = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eqIdx = withoutExport.indexOf("=");
    if (eqIdx <= 0) {
      invalid.push({ line: i + 1, raw, error: "Missing key=value format." });
      continue;
    }
    const key = withoutExport.slice(0, eqIdx).trim().toUpperCase();
    const keyError = validateEnvVarKey(key);
    if (keyError) {
      invalid.push({ line: i + 1, raw, error: keyError });
      continue;
    }
    let value = withoutExport.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > MAX_ENV_VALUE_LEN) {
      invalid.push({
        line: i + 1,
        raw,
        error: `Value too long (max ${MAX_ENV_VALUE_LEN}).`,
      });
      continue;
    }
    entries.push({ key, value, isSecret: true, line: i + 1 });
  }
  return { entries, invalid };
}

async function buildEnvImportPreview(projectId, content) {
  const parsed = parseDotenvContent(content);
  const existingRows = await listProjectEnvVarRows(projectId);
  const existingKeys = new Set(existingRows.map((row) => row.key));
  const duplicatesInFile = new Set();
  const seen = new Set();
  for (const entry of parsed.entries) {
    if (seen.has(entry.key)) {
      duplicatesInFile.add(entry.key);
    }
    seen.add(entry.key);
  }
  return {
    validEntries: parsed.entries.map((entry) => ({
      key: entry.key,
      value: entry.value,
      valuePreview: entry.value ? `${entry.value.slice(0, 4)}...` : "",
      isSecret: true,
      line: entry.line,
      exists: existingKeys.has(entry.key),
      duplicateInFile: duplicatesInFile.has(entry.key),
    })),
    invalidLines: parsed.invalid,
    summary: {
      totalParsed: parsed.entries.length,
      invalid: parsed.invalid.length,
      existingConflicts: parsed.entries.filter((e) => existingKeys.has(e.key)).length,
      duplicateKeysInFile: duplicatesInFile.size,
    },
  };
}

async function commitEnvImport({ userId, projectId, entries, conflictPolicy = "replace" }) {
  assertEnvVarsKmsReady();
  const deduped = new Map();
  for (const entry of entries) {
    if (!deduped.has(entry.key)) {
      deduped.set(entry.key, entry);
    }
  }
  const normalized = Array.from(deduped.values());
  const existingRows = await listProjectEnvVarRows(projectId);
  const existingByKey = new Map(existingRows.map((row) => [row.key, row]));
  const toWrite = [];
  let skipped = 0;
  for (const entry of normalized) {
    const exists = existingByKey.has(entry.key);
    if (exists && conflictPolicy === "skip") {
      skipped += 1;
      continue;
    }
    toWrite.push(entry);
  }
  const projectedTotal = new Set([
    ...existingRows.map((row) => row.key),
    ...toWrite.map((entry) => entry.key),
  ]);
  if (projectedTotal.size > MAX_ENV_VARS_PER_PROJECT) {
    throw new Error(`max ${MAX_ENV_VARS_PER_PROJECT} environment variables per project.`);
  }
  for (const entry of toWrite) {
    await upsertProjectEnvVar({
      userId,
      projectId,
      key: entry.key,
      value: entry.value,
      isSecret: entry.isSecret !== false,
    });
  }
  return {
    saved: toWrite.length,
    skipped,
  };
}

async function replaceProjectEnvVars(userId, projectId, envVars) {
  assertEnvVarsKmsReady();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from project_env_vars where project_id = $1", [projectId]);
    for (const entry of envVars) {
      const ciphertext = await encryptEnvVarSecret(entry.value, {
        projectId,
        key: entry.key,
      });
      await client.query(
        `insert into project_env_vars (
            id, project_id, key, value_ciphertext, is_secret, kms_key_name,
            created_by, updated_by, created_at, updated_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $7, now(), now()
          )`,
        [
          randomUUID(),
          projectId,
          entry.key,
          ciphertext,
          entry.isSecret !== false,
          getEnvVarsKmsKeyName(),
          userId,
        ],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function loadProjectDeploymentEnv(projectId) {
  const rows = await listProjectEnvVarRows(projectId);
  if (!rows.length) {
    return {};
  }
  assertEnvVarsKmsReady();
  const out = {};
  for (const row of rows) {
    out[row.key] = await decryptEnvVarSecret(row.value_ciphertext, {
      projectId,
      key: row.key,
    });
  }
  return out;
}

function sanitizeBuildConfig(input) {
  if (!input || typeof input !== "object") {
    return {};
  }
  const result = {};
  for (const key of Object.keys(DEFAULT_BUILD_CONFIG)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue;
    }
    const raw = input[key];
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      result[key] = trimmed.length > 0 ? trimmed : null;
    } else if (raw === null) {
      result[key] = null;
    }
  }
  return enforceBuildSecurityPolicy(result);
}

function enforceBuildSecurityPolicy(config = {}) {
  if (config.installCommand) {
    logger.warn("Custom install commands are disabled by security policy and will be ignored.");
  }
  return {
    ...config,
    installCommand: null,
  };
}

function validateBuildConfigInput(config = {}) {
  if (
    Object.prototype.hasOwnProperty.call(config, "framework") &&
    config.framework &&
    !ALLOWED_BUILD_FRAMEWORKS.has(config.framework)
  ) {
    return "Unsupported framework value.";
  }

  for (const [field, label] of [
    ["rootDir", "Root directory"],
    ["outputDir", "Output directory"],
  ]) {
    if (!Object.prototype.hasOwnProperty.call(config, field)) {
      continue;
    }
    const value = config[field];
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      return `${label} must be a string.`;
    }
    if (value.length > MAX_BUILD_PATH_LEN) {
      return `${label} is too long.`;
    }
    const normalized = value.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      normalized.startsWith("~") ||
      /^[a-zA-Z]:\//.test(normalized)
    ) {
      return `${label} must be a relative path.`;
    }
    const segments = normalized.split("/").filter(Boolean);
    if (segments.includes("..")) {
      return `${label} cannot contain "..".`;
    }
    if (/[\r\n\0]/.test(value)) {
      return `${label} contains invalid characters.`;
    }
  }

  if (Object.prototype.hasOwnProperty.call(config, "buildCommand")) {
    const buildCommand = config.buildCommand;
    if (buildCommand !== null && buildCommand !== undefined) {
      if (typeof buildCommand !== "string") {
        return "Build command must be a string.";
      }
      if (buildCommand.length > MAX_BUILD_COMMAND_LEN) {
        return "Build command is too long.";
      }
      if (/[\r\n\0]/.test(buildCommand)) {
        return "Build command contains invalid characters.";
      }
    }
  }

  return null;
}

function mergeBuildConfig(base, overrides = {}) {
  const source = base && typeof base === "object" ? base : DEFAULT_BUILD_CONFIG;
  const result = {};
  for (const key of Object.keys(DEFAULT_BUILD_CONFIG)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      result[key] = overrides[key];
    } else if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key];
    } else {
      result[key] = DEFAULT_BUILD_CONFIG[key];
    }
  }
  return result;
}

function hasBuildOverrides(config = {}) {
  for (const key of Object.keys(DEFAULT_BUILD_CONFIG)) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      return true;
    }
  }
  return false;
}

function getProjectBuildConfig(project) {
  return mergeBuildConfig(DEFAULT_BUILD_CONFIG, project?.settings ?? DEFAULT_BUILD_CONFIG);
}

function resolveIdentity() {
  const value = process.env.DFX_IDENTITY;
  if (value === undefined) {
    return "anonymous";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function generateToken() {
  return randomUUID().replace(/-/g, "");
}
