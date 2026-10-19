const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_FIELDS = new Set(["projectId", "tenantId", "varId"]);
const NUMERIC_FIELDS = new Set(["installationId", "githubInstallationId", "repoId"]);
const BOOLEAN_FIELDS = new Set(["isSecret", "private", "privateRepo"]);
const OBJECT_FIELDS = new Set(["buildConfig", "settings"]);
const ENV_ARRAYS = new Set(["envVars", "entries"]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function positiveId(value) {
  if (!/^[1-9]\d*$/.test(String(value ?? ""))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function invalid(message) {
  throw new HttpError(400, message);
}

function validateObject(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Expected a JSON object.");
  if (depth > 8 || Object.keys(value).length > 200) invalid("Request object is too complex.");
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) invalid("Invalid object key.");
    if (item === null) continue;
    if (ID_FIELDS.has(key)) {
      if (typeof item !== "string" || !UUID.test(item)) invalid(`Invalid ${key}.`);
    } else if (NUMERIC_FIELDS.has(key)) {
      if (!positiveId(item)) invalid(`Invalid ${key}.`);
    } else if (key === "capacity") {
      if (!/^[0-9]+$/.test(String(item)) || !Number.isSafeInteger(Number(item)) || Number(item) < 0)
        invalid("capacity must be a nonnegative integer.");
    } else if (BOOLEAN_FIELDS.has(key)) {
      if (typeof item !== "boolean") invalid(`${key} must be a boolean.`);
    } else if (ENV_ARRAYS.has(key)) {
      if (!Array.isArray(item) || item.length > 100)
        invalid(`${key} must contain at most 100 entries.`);
      for (const entry of item) validateObject(entry, depth + 1);
    } else if (OBJECT_FIELDS.has(key)) {
      validateObject(item, depth + 1);
    } else if (typeof item !== "string") {
      invalid(`${key} must be a string.`);
    }
    if (typeof item === "string") {
      const max = key === "content" ? 1024 * 1024 : key === "value" ? 8192 : 4096;
      if (item.length > max || item.includes("\0"))
        invalid(`${key} is too long or contains invalid characters.`);
      if (
        ["branch", "rootDir", "outputDir"].includes(key) &&
        (item.startsWith("-") || /[\r\n]/.test(item))
      ) {
        invalid(`Invalid ${key}.`);
      }
    }
  }
}

export function validateRequest(req, _res, next) {
  try {
    if (Number(req.get("content-length") || 0) > 0 && !req.is("application/json")) {
      invalid("Request body must use application/json.");
    }
    for (const [key, value] of Object.entries(req.query || {})) {
      if (typeof value !== "string" || value.length > 8192 || value.includes("\0"))
        invalid(`Invalid query parameter: ${key}.`);
      if (key === "installation_id" && !positiveId(value)) invalid("Invalid installation id.");
      if (key === "limit" && (!positiveId(value) || Number(value) > 100))
        invalid("limit must be between 1 and 100.");
      if (["includeValues", "unreadOnly"].includes(key) && !["true", "false"].includes(value))
        invalid(`Invalid ${key}.`);
      if (key === "range" && !["24h", "7d", "30d", "90d"].includes(value))
        invalid("Invalid analytics range.");
    }
    const isWebhook = ["/github/webhook", "/gitlab/webhook", "/webhooks/stripe"].includes(req.path);
    if (req.body !== undefined) {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
        invalid("Expected a JSON object.");
      // Provider payloads have their own nested schemas; validate their shape and
      // complexity without applying the control-plane field contract to them.
      if (isWebhook) {
        validateWebhook(req.body);
        if (req.path !== "/webhooks/stripe") validateGitWebhookFields(req.body);
      } else validateObject(req.body);
    }
    next();
  } catch (error) {
    next(error);
  }
}

function validateGitWebhookFields(body) {
  for (const key of ["ref", "after", "checkout_sha", "object_kind", "event_name"]) {
    if (body[key] != null && typeof body[key] !== "string") invalid(`Invalid webhook ${key}.`);
  }
  if (body.deleted != null && typeof body.deleted !== "boolean")
    invalid("Invalid webhook deleted flag.");
  for (const key of ["repository", "installation", "project", "user", "sender", "head_commit"]) {
    if (body[key] != null && (typeof body[key] !== "object" || Array.isArray(body[key])))
      invalid(`Invalid webhook ${key}.`);
  }
  for (const parent of [body.repository, body.installation, body.project]) {
    if (parent?.id != null && !positiveId(parent.id)) invalid("Invalid webhook resource id.");
    for (const key of [
      "full_name",
      "clone_url",
      "git_http_url",
      "path_with_namespace",
      "default_branch",
      "name",
    ]) {
      if (parent?.[key] != null && typeof parent[key] !== "string")
        invalid(`Invalid webhook ${key}.`);
    }
  }
}

function validateWebhook(value, depth = 0, budget = { nodes: 0 }) {
  if (depth > 20 || ++budget.nodes > 20000) invalid("Webhook payload is too complex.");
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) invalid("Invalid object key.");
    if (item && typeof item === "object") validateWebhook(item, depth + 1, budget);
  }
}

export function asyncHandler(handler) {
  return (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}

export function createApiRoutes(app) {
  return Object.fromEntries(
    ["get", "post", "put", "patch", "delete"].map((method) => [
      method,
      (path, ...handlers) =>
        app[method](
          path,
          (req, _res, next) => {
            try {
              for (const [key, value] of Object.entries(req.params)) {
                if (key === "installationId") {
                  if (!positiveId(value)) invalid("Invalid installation id.");
                } else if (["id", "tenantId", "varId"].includes(key) && !UUID.test(value)) {
                  invalid(`Invalid ${key}.`);
                }
              }
              next();
            } catch (error) {
              next(error);
            }
          },
          ...handlers.map(asyncHandler),
        ),
    ]),
  );
}

export function apiErrorHandler(logger) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const badInput =
      error instanceof URIError ||
      error?.type === "entity.parse.failed" ||
      ["22P02", "22003", "22001"].includes(error?.code);
    const status = badInput
      ? 400
      : error?.type === "entity.too.large"
        ? 413
        : error instanceof HttpError
          ? error.status
          : 500;
    if (status >= 500) {
      // Avoid logging request bodies, provider responses, tokens, or SQL values.
      logger?.error(
        { method: req.method, path: req.route?.path || req.path, errorType: error?.name },
        "Request failed",
      );
    }
    res.status(status).json({
      error:
        status >= 500
          ? "Internal server error."
          : badInput
            ? "Malformed request."
            : status === 413
              ? "Request body is too large."
              : error.message,
    });
  };
}
