const RESERVED_PREFIXES = [
  "DEPLOY_",
  "DFX_",
  "KUBERNETES_",
  "GOOGLE_",
  "GITHUB_",
  "GITLAB_",
  "AWS_",
  "AZURE_",
  "A3_",
  "ENV_VARS_",
  "LD_",
  "DYLD_",
  "GIT_",
  "NPM_CONFIG_",
  "npm_config_",
];
const RESERVED_KEYS = new Set([
  "DATABASE_URL",
  "PORT",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "HOME",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "IFS",
  "CDPATH",
  "SHELL",
  "HOST_CANISTER_ID",
  "PROJECT_SLUG",
  "ICP_NETWORK",
  "ASSETS_DIR",
  "REPLICA_INGRESS_HOST",
]);

function isSafeCustomerEnvKey(key) {
  return (
    typeof key === "string" &&
    /^[A-Z_][A-Z0-9_]{0,127}$/.test(key) &&
    !RESERVED_KEYS.has(key) &&
    !RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function validateCustomerEnv(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Build environment must be an object.");
  }
  const result = Object.create(null);
  if (Object.keys(input).length > 100) throw new Error("Too many build variables.");
  for (const [key, value] of Object.entries(input)) {
    if (!isSafeCustomerEnvKey(key)) throw new Error(`Reserved or invalid build variable: ${key}`);
    if (typeof value !== "string" || value.length > 8192 || value.includes("\0")) {
      throw new Error(`Invalid build variable value: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

function createCustomerBuildEnv(runtimeEnv, customerEnv) {
  const env = Object.create(null);
  // Never inherit the runner's credentials or orchestration settings in npm/shell.
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
    if (typeof runtimeEnv[key] === "string") env[key] = runtimeEnv[key];
  }
  return { ...env, CI: "true", ...validateCustomerEnv(customerEnv) };
}

module.exports = { isSafeCustomerEnvKey, validateCustomerEnv, createCustomerBuildEnv };
