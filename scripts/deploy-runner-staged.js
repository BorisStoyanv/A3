const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const {
  validateCustomerEnv,
  createCustomerBuildEnv,
} = require("../backend/src/security/runner-env.cjs");
const { prepareTrustedArtifact } = require("./security-artifact.cjs");

const DEFAULT_REPLICA_HOST = "127.0.0.1:4943";
const DEFAULT_CREATE_CYCLES = "501000000000";
const STAGE_BUILD = "build";
const STAGE_DEPLOY = "deploy";
const ARTIFACT_PROJECT_DIR = "project";
const ARTIFACT_MANIFEST_FILE = "manifest.json";
const DEPLOY_MAX_ARTIFACT_MB = readPositiveIntEnv("DEPLOY_MAX_ARTIFACT_MB", 256);
const DEPLOY_MAX_WORKSPACE_MB = readPositiveIntEnv(
  "DEPLOY_MAX_WORKSPACE_MB",
  DEPLOY_MAX_ARTIFACT_MB * 4,
);

const argv = process.argv.slice(2);
let network = process.env.ICP_NETWORK || "local";
const positional = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--network") {
    network = argv[i + 1] ?? network;
    i += 1;
    continue;
  }
  if (arg.startsWith("--network=")) {
    network = arg.split("=", 2)[1] || network;
    continue;
  }
  positional.push(arg);
}

const repoUrl = positional[0];
const branch = positional[1] || "main";
const runDir = positional[2];
const stage = resolveStage(process.env.DEPLOY_STAGE);
const deployMode = resolveDeployMode(process.env.DEPLOY_MODE_TYPE);
const replicaHost = normalizeReplicaHost(process.env.DEPLOY_REPLICA_HOST || DEFAULT_REPLICA_HOST);

if (require.main === module && (!repoUrl || !runDir)) {
  console.error("Usage: deploy-runner-staged.js <repo-url> [branch] <run-dir> [--network <name>]");
  process.exit(1);
}

async function main() {
  if (stage === STAGE_BUILD) {
    await runBuildStage();
  } else {
    await runDeployStage();
  }
}

async function runBuildStage() {
  const customerEnv = validateCustomerEnv(JSON.parse(process.env.A3_BUILD_ENV_JSON || "{}"));
  const stageRoot = path.resolve(runDir);
  const sourceDir = path.join(stageRoot, "source");
  const artifactDir = path.join(stageRoot, "artifact");
  const artifactProjectDir = path.join(artifactDir, ARTIFACT_PROJECT_DIR);
  const manifestPath = path.join(artifactDir, ARTIFACT_MANIFEST_FILE);
  const githubInstallationToken = readEnvVar("GITHUB_INSTALLATION_TOKEN");
  const gitlabOAuthToken = readEnvVar("GITLAB_OAUTH_TOKEN");

  await ensureCleanDir(sourceDir);
  await ensureCleanDir(artifactDir);

  await runStep("Fetch repository", async () => {
    const cloneSource = resolveGitCloneSource(repoUrl, {
      githubInstallationToken,
      gitlabOAuthToken,
    });
    if (cloneSource.redacted) {
      console.log(`Using authenticated clone URL: ${cloneSource.redacted}`);
    }
    await exec("git", ["clone", "--depth=1", "--branch", branch, cloneSource.url, sourceDir], {
      env: gitCloneEnv(),
      redact: [
        ...(githubInstallationToken
          ? [githubInstallationToken, encodeURIComponent(githubInstallationToken)]
          : []),
        ...(gitlabOAuthToken ? [gitlabOAuthToken, encodeURIComponent(gitlabOAuthToken)] : []),
      ],
    });
    await fsp.rm(path.join(sourceDir, ".git"), { recursive: true, force: true });
  });
  if (process.env.GITHUB_INSTALLATION_TOKEN) {
    delete process.env.GITHUB_INSTALLATION_TOKEN;
  }
  if (process.env.GITLAB_OAUTH_TOKEN) {
    delete process.env.GITLAB_OAUTH_TOKEN;
  }

  const rootDirSetting = readEnvVar("DEPLOY_ROOT_DIR");
  const outputDirSetting = readEnvVar("DEPLOY_OUTPUT_DIR");
  const buildCommandSetting = readEnvVar("DEPLOY_BUILD_COMMAND");
  const projectDir = resolveProjectDir(sourceDir, rootDirSetting);
  if (!(await isDirectory(projectDir))) {
    if (rootDirSetting) {
      throw new Error(`Configured root directory "${rootDirSetting}" not found in repository.`);
    }
    throw new Error("Repository checkout directory is missing.");
  }

  const displayedRoot =
    projectDir === sourceDir ? "." : toPosixPath(path.relative(sourceDir, projectDir)) || ".";
  console.log(`Working directory: ${displayedRoot}`);

  const packageJsonPath = path.join(projectDir, "package.json");
  const hasPackageJson = await fileExists(packageJsonPath);
  let packageJson = null;

  if (hasPackageJson) {
    const raw = await fsp.readFile(packageJsonPath, "utf8");
    packageJson = JSON.parse(raw);
  }

  if (hasPackageJson) {
    await runStep("Install dependencies", async () => {
      await exec(npmCommand(), ["install"], {
        cwd: projectDir,
        env: createCustomerBuildEnv(process.env, customerEnv),
      });
    });
  } else {
    console.log("No package.json found. Skipping dependency install.");
  }

  if (buildCommandSetting) {
    await runStep("Build static bundle", async () => {
      await exec("sh", ["-lc", buildCommandSetting], {
        cwd: projectDir,
        env: createCustomerBuildEnv(process.env, customerEnv),
      });
    });
  } else if (packageJson?.scripts?.build) {
    await runStep("Build static bundle", async () => {
      await exec(npmCommand(), ["run", "build"], {
        cwd: projectDir,
        env: createCustomerBuildEnv(process.env, customerEnv),
      });
    });
  } else if (hasPackageJson) {
    console.log('No "build" script defined. Skipping build step.');
  } else {
    console.log("Static repository detected. Skipping build step.");
  }

  if (deployMode === "hosted") {
    await buildHostedArtifact({
      projectDir,
      artifactProjectDir,
      outputDirSetting,
      network,
    });
  } else {
    await buildEjectArtifact({
      projectDir,
      artifactProjectDir,
      outputDirSetting,
    });
  }

  await enforceArtifactAndWorkspaceSize({
    stageRoot,
    artifactProjectDir,
  });

  const digest = await hashDirectory(artifactProjectDir);
  const manifest = {
    schemaVersion: 1,
    mode: deployMode,
    stage: STAGE_BUILD,
    network,
    repoUrl,
    branch,
    createdAt: new Date().toISOString(),
    artifactProjectDir: ARTIFACT_PROJECT_DIR,
    sha256: digest,
    assetsSha256: await hashDirectory(
      path.join(artifactProjectDir, deployMode === "hosted" ? "hosted-assets" : "eject-assets"),
    ),
  };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`ARTIFACT_MANIFEST=${manifestPath}`);
  console.log(`ARTIFACT_SHA256=${digest}`);
  console.log("Build stage completed.");
}

async function runDeployStage() {
  const stageRoot = path.resolve(runDir);
  const artifactDir = path.join(stageRoot, "artifact");
  const manifestPath = path.join(artifactDir, ARTIFACT_MANIFEST_FILE);
  const manifest = await readManifest(manifestPath);

  if (manifest.mode !== deployMode) {
    throw new Error(`Artifact mode mismatch: expected "${deployMode}", got "${manifest.mode}".`);
  }

  if (manifest.artifactProjectDir !== ARTIFACT_PROJECT_DIR)
    throw new Error("Invalid artifact path.");
  const artifactProjectDir = await prepareTrustedArtifact({
    stageRoot,
    mode: deployMode,
    slug: readEnvVar("PROJECT_SLUG"),
    maxBytes: DEPLOY_MAX_ARTIFACT_MB * 1024 * 1024,
  });
  try {
    const actualHash = await hashDirectory(path.join(artifactProjectDir, "assets"));
    if (actualHash !== manifest.assetsSha256)
      throw new Error("Static artifact checksum verification failed.");
    await ensureAssetsConfig(artifactProjectDir, path.join(artifactProjectDir, "assets"));
    if (deployMode === "hosted") {
      await writeHostedCanisterIds(artifactProjectDir, network, readEnvVar("HOST_CANISTER_ID"));
    }
    await ensureWorkspaceIdentity();
    const identity =
      process.env.DFX_IDENTITY === undefined ? "anonymous" : process.env.DFX_IDENTITY || null;
    const requiresWallet = deployMode === "eject" && network !== "local";
    const walletId = requiresWallet
      ? readEnvVar("DFX_WALLET") || readEnvVar("DFX_WALLET_CANISTER_ID")
      : null;

    console.log(`Using dfx identity: ${identity ?? "(dfx default)"}`);
    await runStep("Verify identity and wallet", async () => {
      const whoami = (
        await execCapture("dfx", ["identity", "whoami"], { cwd: artifactProjectDir })
      ).trim();
      if (identity && whoami !== identity) {
        throw new Error(
          `DFX identity mismatch. Expected "${identity}", got "${whoami}". Check DEPLOY_IDENTITY_NAME/DFX_IDENTITY and the mounted secret.`,
        );
      }
      if (network === "local") {
        console.log("Local network selected; skipping wallet verification.");
        return;
      }
      if (!requiresWallet) {
        console.log("Hosted mode selected; skipping wallet verification.");
        return;
      }
      const targetIdentity = identity ?? "default";
      let walletIdFromDfx;
      if (walletId) {
        await ensureWalletConfig(walletId, targetIdentity, network);
        walletIdFromDfx = walletId;
        console.log(
          `Wallet configured from env for ${targetIdentity} on ${network}: ${walletIdFromDfx}`,
        );
      } else {
        walletIdFromDfx = (
          await execCapture("dfx", ["identity", "get-wallet", "--network", network], {
            cwd: artifactProjectDir,
          })
        ).trim();
      }
      if (!walletIdFromDfx) {
        throw new Error("No wallet configured for the selected identity/network.");
      }
      console.log(`Wallet detected for ${whoami || "(dfx default)"}: ${walletIdFromDfx}`);
    });

    if (deployMode === "eject" && network !== "local") {
      await maybeCreateFrontendCanister(artifactProjectDir, identity, walletId);
    }

    let hostedTicketContext = null;
    if (deployMode === "hosted") {
      const hostCanisterId = readEnvVar("HOST_CANISTER_ID");
      const deployTicket = readEnvVar("DEPLOY_TICKET");
      const deployTicketSignature = readEnvVar("DEPLOY_TICKET_SIGNATURE_B64");
      const deployTicketKeyId = readEnvVar("DEPLOY_TICKET_KEY_ID");
      hostedTicketContext = {
        projectDir: artifactProjectDir,
        networkName: network,
        identity,
        hostCanisterId,
        ticket: deployTicket,
        signatureB64: deployTicketSignature,
        keyId: deployTicketKeyId,
      };
      await runStep("Authorize hosted deploy ticket", async () => {
        await beginHostedDeployTicket(hostedTicketContext);
      });
    }

    await runStep("Deploy to ICP", async () => {
      const args = ["deploy", "--yes"];
      if (deployMode === "hosted") {
        args.push("--no-asset-upgrade");
      }
      if (identity) {
        args.push("--identity", identity);
      }
      if (network === "local" || !requiresWallet) {
        args.push("--no-wallet");
      } else if (walletId) {
        args.push("--wallet", walletId);
      }
      args.push("--network", network);
      try {
        await execDfx(args, { cwd: artifactProjectDir });
      } catch (error) {
        if (
          deployMode === "hosted" &&
          hostedTicketContext &&
          shouldRetryHostedDeployAfterSessionError(error)
        ) {
          console.warn(
            "Detected transient hosted deploy session loss; retrying once with the existing deploy session.",
          );
          await execDfx(args, { cwd: artifactProjectDir });
          return;
        }
        throw error;
      }
    });

    await emitDeploymentSummary(artifactProjectDir, network);
    console.log("Deploy stage completed.");
  } finally {
    await fsp.rm(artifactProjectDir, { recursive: true, force: true });
  }
}

async function buildHostedArtifact({ projectDir, artifactProjectDir, outputDirSetting, network }) {
  const hostCanisterId = readEnvVar("HOST_CANISTER_ID");
  const projectSlug = readEnvVar("PROJECT_SLUG");
  if (!hostCanisterId) {
    throw new Error("HOST_CANISTER_ID is required for hosted deployments.");
  }
  if (!projectSlug || !isValidSlug(projectSlug)) {
    throw new Error(`Invalid PROJECT_SLUG "${projectSlug || ""}".`);
  }

  let assetsDir;
  if (outputDirSetting) {
    const resolvedOutput = resolveWithin(projectDir, outputDirSetting, "Output directory");
    if (!(await isDirectory(resolvedOutput))) {
      throw new Error(`Configured output directory "${outputDirSetting}" not found.`);
    }
    assetsDir = resolvedOutput;
    const relative = toPosixPath(path.relative(projectDir, assetsDir) || ".");
    console.log(`Using assets directory: ${relative}`);
  } else {
    assetsDir = await detectAssetsDir(projectDir);
  }
  await assertStaticEntryPoint(assetsDir);

  await ensureCleanDir(artifactProjectDir);
  const hostedAssetsRoot = path.join(artifactProjectDir, "hosted-assets");
  const hostedTenantDir = path.join(hostedAssetsRoot, "__tenant", projectSlug);
  await fsp.mkdir(hostedTenantDir, { recursive: true });
  await copyDirectory(assetsDir, hostedTenantDir, {
    exclude: [hostedAssetsRoot],
  });
  await ensureAssetsConfig(artifactProjectDir, hostedAssetsRoot);
  await writeHostedCanisterIds(artifactProjectDir, network, hostCanisterId);
  console.log("Prepared hosted deployment artifact.");
}

async function buildEjectArtifact({ projectDir, artifactProjectDir, outputDirSetting }) {
  await ensureCleanDir(artifactProjectDir);

  let assetsDir;
  if (outputDirSetting) {
    const resolvedOutput = resolveWithin(projectDir, outputDirSetting, "Output directory");
    if (!(await isDirectory(resolvedOutput))) {
      throw new Error(`Configured output directory "${outputDirSetting}" not found.`);
    }
    assetsDir = resolvedOutput;
    const relative = toPosixPath(path.relative(artifactProjectDir, assetsDir) || ".");
    console.log(`Using assets directory: ${relative}`);
  } else {
    assetsDir = await detectAssetsDir(projectDir);
  }
  await assertStaticEntryPoint(assetsDir);
  const staticDir = path.join(artifactProjectDir, "eject-assets");
  await copyDirectory(assetsDir, staticDir);
  console.log("Prepared eject deployment artifact.");
}

async function maybeCreateFrontendCanister(projectDir, identity, walletId) {
  const canisterIdsPath = path.join(projectDir, ".dfx", network, "canister_ids.json");
  const hasFrontendId = await hasCanisterId(canisterIdsPath, "frontend");
  if (hasFrontendId) {
    console.log("Found existing frontend canister ID; skipping create.");
    return;
  }
  const createCycles = readEnvVar("DEPLOY_CREATE_CYCLES") || DEFAULT_CREATE_CYCLES;
  await runStep(`Create canister (frontend) with ${createCycles} cycles`, async () => {
    const args = [
      "canister",
      "create",
      "frontend",
      "--with-cycles",
      createCycles,
      "--network",
      network,
    ];
    if (identity) {
      args.push("--identity", identity);
    }
    if (walletId) {
      args.push("--wallet", walletId);
    }
    await execDfx(args, { cwd: projectDir });
  });
}

async function beginHostedDeployTicket({
  projectDir,
  networkName,
  identity,
  hostCanisterId,
  ticket,
  signatureB64,
  keyId,
}) {
  if (!hostCanisterId) {
    throw new Error("HOST_CANISTER_ID is required for begin_deploy.");
  }
  if (!ticket) {
    throw new Error("DEPLOY_TICKET is required for hosted deploy stage.");
  }
  if (!signatureB64) {
    throw new Error("DEPLOY_TICKET_SIGNATURE_B64 is required for hosted deploy stage.");
  }
  const signature = decodeBase64Signature(signatureB64);
  if (signature.length !== 64) {
    throw new Error(`Deploy ticket signature must be 64 bytes, got ${signature.length}.`);
  }
  const signatureVec = signature.length ? signature.join("; ") : "";
  const candidArgs = `("${escapeCandidText(ticket)}", vec {${signatureVec}})`;
  const args = [
    "canister",
    "call",
    hostCanisterId,
    "begin_deploy",
    candidArgs,
    "--network",
    networkName,
  ];
  if (identity) {
    args.push("--identity", identity);
  }
  await execDfx(args, { cwd: projectDir });
  if (keyId) {
    console.log(`Deploy ticket accepted (key ${keyId}).`);
  } else {
    console.log("Deploy ticket accepted.");
  }
}

function decodeBase64Signature(value) {
  const compact = value.replace(/\s+/g, "");
  let decoded;
  try {
    decoded = Buffer.from(compact, "base64");
  } catch {
    throw new Error("DEPLOY_TICKET_SIGNATURE_B64 is not valid base64.");
  }
  if (!decoded || decoded.length === 0) {
    throw new Error("DEPLOY_TICKET_SIGNATURE_B64 decoded to an empty signature.");
  }
  const expected = compact.replace(/=+$/g, "");
  const actual = decoded.toString("base64").replace(/=+$/g, "");
  if (expected !== actual) {
    throw new Error("DEPLOY_TICKET_SIGNATURE_B64 is not valid base64.");
  }
  return Array.from(decoded.values());
}

function escapeCandidText(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function readManifest(manifestPath) {
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Artifact manifest is missing: ${manifestPath}`);
  }
  const info = await fsp.lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
    throw new Error("Invalid artifact manifest file.");
  const raw = await fsp.readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  if (
    !/^[a-f0-9]{64}$/.test(parsed?.assetsSha256 || "") ||
    parsed?.artifactProjectDir !== ARTIFACT_PROJECT_DIR
  ) {
    throw new Error("Artifact manifest is invalid.");
  }
  return parsed;
}

async function hashDirectory(directory) {
  const hash = createHash("sha256");
  await hashDirectoryRecursive(directory, directory, hash);
  return hash.digest("hex");
}

async function hashDirectoryRecursive(root, current, hash) {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relative = toPosixPath(path.relative(root, fullPath));
    if (entry.isDirectory()) {
      hash.update(`dir:${relative}\n`);
      await hashDirectoryRecursive(root, fullPath, hash);
      continue;
    }
    if (entry.isFile()) {
      const content = await fsp.readFile(fullPath);
      hash.update(`file:${relative}\n`);
      hash.update(content);
      continue;
    }
    hash.update(`other:${relative}\n`);
  }
}

function resolveStage(raw) {
  const value = String(raw || STAGE_BUILD).toLowerCase();
  if (value === STAGE_BUILD || value === STAGE_DEPLOY) {
    return value;
  }
  throw new Error(`Invalid DEPLOY_STAGE "${raw}". Expected "build" or "deploy".`);
}

function resolveDeployMode(raw) {
  const value = String(raw || "").toLowerCase();
  if (value === "hosted" || value === "eject") {
    return value;
  }
  throw new Error(`Invalid DEPLOY_MODE_TYPE "${raw}". Expected "hosted" or "eject".`);
}

function runStep(name, handler) {
  console.log("");
  console.log(`=== ${name} ===`);
  return handler().catch((error) => {
    if (error && error.code === "ENOENT" && error.path) {
      console.error(`Command not found: ${error.path}. Check that it is installed and on PATH.`);
    }
    throw error;
  });
}

function exec(command, args, options = {}) {
  const { redact = [], ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...spawnOptions,
    });
    child.stdout.on("data", (chunk) => {
      const text = applyRedactions(chunk.toString(), redact);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = applyRedactions(chunk.toString(), redact);
      output += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`${command} exited with code ${code}`);
        error.code = code;
        error.output = output;
        reject(error);
      }
    });
  });
}

function shouldRetryHostedDeployAfterSessionError(error) {
  const haystack = `${error?.message || ""}\n${error?.output || ""}`.toLowerCase();
  return (
    haystack.includes("missing active deploy session for tenant slug") ||
    haystack.includes("batch is not bound to an active deploy session") ||
    haystack.includes("deploy session slug does not match batch slug")
  );
}

function applyRedactions(text, secrets) {
  if (!text || !Array.isArray(secrets) || secrets.length === 0) {
    return text;
  }
  let output = text;
  for (const rawSecret of secrets) {
    const secret = String(rawSecret || "");
    if (!secret) continue;
    output = output.split(secret).join("***");
  }
  return output;
}

function execCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        const msg = stderr || stdout || `${command} exited with code ${code}`;
        const error = new Error(msg);
        error.code = code;
        reject(error);
      }
    });
  });
}

async function execDfx(args, options = {}) {
  const attempts = buildDfxAttempts(options);
  let lastError = null;
  const labels = [];

  for (const attempt of attempts) {
    try {
      await exec(attempt.command, [...attempt.args, ...args], attempt.options ?? options);
      return;
    } catch (error) {
      if (error.code === "ENOENT") {
        lastError = error;
        labels.push(attempt.label);
        continue;
      }
      throw error;
    }
  }

  if (lastError) {
    const message = `${lastError.message} (attempted: ${labels.join(", ")})`;
    const wrapped = new Error(message);
    wrapped.code = lastError.code;
    wrapped.path = lastError.path;
    throw wrapped;
  }

  throw new Error("Unable to execute dfx: no valid command candidates.");
}

function buildDfxAttempts(options = {}) {
  const attempts = [];
  const command = resolveDfxCommand();
  attempts.push({
    label: command.wrapped ? `wrapper(${command.command})` : "direct",
    command: command.command,
    args: [...command.args],
    options,
  });

  if (!command.wrapped && process.platform === "win32") {
    const wslCwd = options.cwd ? toWslPath(options.cwd) : null;
    if (wslCwd) {
      attempts.push({
        label: "wsl-fallback",
        command: "wsl",
        args: ["--cd", wslCwd, "dfx"],
        options: { ...options, cwd: undefined },
      });
    }
  }

  return attempts;
}

function resolveDfxCommand() {
  const binary = process.env.DFX_PATH || (process.platform === "win32" ? "dfx.exe" : "dfx");
  const wrapper = process.env.DFX_WRAPPER;

  if (wrapper) {
    return { command: wrapper, args: [binary], wrapped: true };
  }

  return { command: binary, args: [], wrapped: false };
}

async function ensureCleanDir(directory) {
  await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(directory, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectAssetsDir(projectDir) {
  const distRoot = path.resolve(projectDir, "dist");
  const distClient = path.resolve(projectDir, "dist/client");
  const distServer = path.resolve(projectDir, "dist/server");
  const hasDistRoot = await isDirectory(distRoot);
  const hasDistClient = await isDirectory(distClient);
  const hasDistServer = await isDirectory(distServer);
  const hasDistIndex = await fileExists(path.join(distRoot, "index.html"));
  const hasDistClientIndex = await fileExists(path.join(distClient, "index.html"));

  // For split client/server outputs (for example dist/client + dist/server),
  // deploy static assets from dist/client to avoid runtime 404 at tenant root.
  if (hasDistClient && hasDistClientIndex && (hasDistServer || (hasDistRoot && !hasDistIndex))) {
    console.log("Detected split client/server output; using assets directory: dist/client");
    return distClient;
  }

  const candidates = [];
  if (process.env.ASSETS_DIR) {
    candidates.push(process.env.ASSETS_DIR);
  }
  candidates.push(
    "dist/client",
    "dist",
    "build",
    "out",
    "public",
    ".output/public",
    "frontend/dist",
    "frontend/build",
  );

  for (const candidate of candidates) {
    const resolved = path.resolve(projectDir, candidate);
    if (await isDirectory(resolved)) {
      const relative = path.relative(projectDir, resolved);
      console.log(`Using assets directory: ${relative || "."}`);
      return resolved;
    }
  }

  const indexAtRoot = await fileExists(path.join(projectDir, "index.html"));
  if (indexAtRoot) {
    console.log("Using repository root as asset directory (index.html found).");
    return projectDir;
  }

  throw new Error("Unable to detect static assets. Provide a dfx.json or set ASSETS_DIR.");
}

async function assertStaticEntryPoint(assetsDir) {
  const indexPath = path.join(assetsDir, "index.html");
  if (await fileExists(indexPath)) {
    return;
  }
  throw new Error(
    `Static entrypoint missing in "${toPosixPath(
      assetsDir,
    )}". Ensure output directory points to static client assets (for split builds, use dist/client).`,
  );
}

async function ensureAssetsConfig(projectDir, assetsDir) {
  const configPath = path.join(projectDir, "dfx.json");
  const relativeAssets = toPosixPath(path.relative(projectDir, assetsDir) || ".");
  const providerUrl = replicaHost.startsWith("http") ? replicaHost : `http://${replicaHost}`;
  const config = {
    canisters: {
      frontend: {
        type: "assets",
        source: [relativeAssets],
        source_assets: [relativeAssets],
      },
    },
    networks: {
      local: {
        type: "persistent",
        providers: [providerUrl],
      },
    },
    defaults: {
      build: {
        packtool: "",
      },
    },
  };
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(`Generated dfx.json for assets canister targeting: ${relativeAssets}`);
}

function readEnvVar(name) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPositiveIntEnv(name, fallback) {
  const value = readEnvVar(name);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function enforceArtifactAndWorkspaceSize({ stageRoot, artifactProjectDir }) {
  const artifactBytes = await directorySizeBytes(artifactProjectDir);
  const workspaceBytes = await directorySizeBytes(stageRoot);
  const artifactMb = bytesToMegabytes(artifactBytes);
  const workspaceMb = bytesToMegabytes(workspaceBytes);
  console.log(`ARTIFACT_SIZE_MB=${artifactMb.toFixed(2)}`);
  console.log(`WORKSPACE_SIZE_MB=${workspaceMb.toFixed(2)}`);

  if (artifactMb > DEPLOY_MAX_ARTIFACT_MB) {
    throw new Error(
      `Artifact size ${artifactMb.toFixed(2)}MB exceeds DEPLOY_MAX_ARTIFACT_MB=${DEPLOY_MAX_ARTIFACT_MB}MB.`,
    );
  }
  if (workspaceMb > DEPLOY_MAX_WORKSPACE_MB) {
    throw new Error(
      `Workspace size ${workspaceMb.toFixed(2)}MB exceeds DEPLOY_MAX_WORKSPACE_MB=${DEPLOY_MAX_WORKSPACE_MB}MB.`,
    );
  }
}

async function directorySizeBytes(targetPath) {
  let stats;
  try {
    stats = await fsp.lstat(targetPath);
  } catch {
    return 0;
  }
  if (stats.isSymbolicLink()) {
    return 0;
  }
  if (stats.isFile()) {
    return stats.size;
  }
  if (!stats.isDirectory()) {
    return 0;
  }
  let total = 0;
  const entries = await fsp.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isFile()) {
      const childStats = await fsp.lstat(childPath);
      total += childStats.size;
      continue;
    }
    if (entry.isDirectory()) {
      total += await directorySizeBytes(childPath);
    }
  }
  return total;
}

function bytesToMegabytes(bytes) {
  return bytes / (1024 * 1024);
}

function resolveProjectDir(repoDir, relativePath) {
  return resolveWithin(repoDir, relativePath, "Root directory");
}

function resolveWithin(baseDir, relativePath, label = "Path") {
  if (!relativePath) {
    return baseDir;
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative to the repository root.`);
  }
  const resolved = path.resolve(baseDir, relativePath);
  const rel = path.relative(baseDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} "${relativePath}" escapes the repository root.`);
  }
  return resolved;
}

async function ensureWalletConfig(walletId, identityName, networkName) {
  if (!walletId) {
    return;
  }
  const name = identityName || "default";
  const base = path.join(os.homedir(), ".config", "dfx", "identity", name);
  await fsp.mkdir(base, { recursive: true });
  const configPath = path.join(base, "wallets.json");
  let data = { identities: {} };
  try {
    const raw = await fsp.readFile(configPath, "utf8");
    data = JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("Unable to read wallet configuration.", { cause: error });
  }
  if (!data.identities) {
    data.identities = {};
  }
  if (!data.identities[name]) {
    data.identities[name] = { networks: {} };
  } else if (!data.identities[name].networks) {
    data.identities[name].networks = {};
  }
  data.identities[name].networks[networkName] = walletId;
  await fsp.writeFile(configPath, JSON.stringify(data, null, 2));
}

async function hasCanisterId(canisterIdsPath, name) {
  if (!(await fileExists(canisterIdsPath))) {
    return false;
  }
  try {
    const raw = await fsp.readFile(canisterIdsPath, "utf8");
    const parsed = JSON.parse(raw);
    const entry = parsed?.[name];
    if (!entry) {
      return false;
    }
    if (typeof entry === "string" && entry.trim()) {
      return true;
    }
    if (typeof entry === "object") {
      return Object.values(entry).some((val) => typeof val === "string" && val.trim().length > 0);
    }
    return false;
  } catch {
    return false;
  }
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function toWslPath(windowsPath) {
  if (!windowsPath) {
    return null;
  }
  const match = /^([A-Za-z]):\\(.*)$/.exec(windowsPath);
  if (!match) {
    return null;
  }
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

async function isDirectory(target) {
  try {
    const stats = await fsp.stat(target);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function emitDeploymentSummary(projectDir, networkName) {
  const canisterFile = path.join(projectDir, ".dfx", networkName, "canister_ids.json");
  try {
    const exists = await fileExists(canisterFile);
    if (!exists) {
      return;
    }
    const raw = await fsp.readFile(canisterFile, "utf8");
    const lookup = JSON.parse(raw);
    const entry = findCanister(lookup, networkName);
    if (!entry) {
      return;
    }
    const { name, canisterId } = entry;
    const url = buildCanisterUrl(canisterId, networkName);
    console.log(`CANISTER_NAME=${name}`);
    console.log(`CANISTER_ID=${canisterId}`);
    console.log(`CANISTER_URL=${url}`);
    const output = `CANISTER_NAME=${name}
CANISTER_ID=${canisterId}
CANISTER_URL=${url}
`;
    await fsp.writeFile(path.join(projectDir, "deployment_summary.txt"), output);
  } catch (error) {
    console.warn("Failed to produce deployment summary:", error.message);
  }
}

async function writeHostedCanisterIds(projectDir, networkName, canisterId) {
  const canisterDir = path.join(projectDir, ".dfx", networkName);
  await fsp.mkdir(canisterDir, { recursive: true });
  const payload = { frontend: canisterId };
  await fsp.writeFile(
    path.join(canisterDir, "canister_ids.json"),
    JSON.stringify(payload, null, 2),
  );

  const rootPayload =
    networkName && networkName !== "local" ? { frontend: { [networkName]: canisterId } } : payload;
  await fsp.writeFile(
    path.join(projectDir, "canister_ids.json"),
    JSON.stringify(rootPayload, null, 2),
  );
}

async function copyDirectory(sourceDir, targetDir, options = {}) {
  const exclude = (options.exclude || []).map((value) => path.resolve(value));
  const isExcluded = (candidate) => {
    if (exclude.length === 0) {
      return false;
    }
    const resolved = path.resolve(candidate);
    return exclude.some(
      (blocked) => resolved === blocked || resolved.startsWith(`${blocked}${path.sep}`),
    );
  };

  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  await fsp.mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    const srcPath = path.join(sourceDir, entry.name);
    if (isExcluded(srcPath)) {
      continue;
    }
    const dstPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, dstPath, options);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, dstPath);
    }
  }
}

function isValidSlug(slug) {
  return /^[a-z0-9-]+$/i.test(slug);
}

async function ensureWorkspaceIdentity() {
  const pemPath = process.env.DEPLOY_IDENTITY_PEM;
  if (!pemPath) {
    throw new Error("DEPLOY_IDENTITY_PEM is required in deploy stage.");
  }
  const identityName = process.env.DEPLOY_IDENTITY_NAME || process.env.DFX_IDENTITY || "workspace";
  const targetDir = path.join(os.homedir(), ".config", "dfx", "identity", identityName);
  await fsp.mkdir(targetDir, { recursive: true });
  const targetFile = path.join(targetDir, "identity.pem");
  if (!(await fileExists(pemPath))) {
    throw new Error(
      `Workspace identity PEM not found at ${pemPath}. Did you mount the identity secret?`,
    );
  }
  if (!(await filesAreEqual(pemPath, targetFile))) {
    await fsp.copyFile(pemPath, targetFile);
    await fsp.chmod(targetFile, 0o600);
  }

  const sourceJson = path.join(path.dirname(pemPath), "identity.json");
  if (await fileExists(sourceJson)) {
    const targetJson = path.join(targetDir, "identity.json");
    if (!(await filesAreEqual(sourceJson, targetJson))) {
      await fsp.copyFile(sourceJson, targetJson);
    }
  }

  const sourceEncrypted = path.join(path.dirname(pemPath), "identity.pem.encrypted");
  if (await fileExists(sourceEncrypted)) {
    const targetEncrypted = path.join(targetDir, "identity.pem.encrypted");
    if (!(await filesAreEqual(sourceEncrypted, targetEncrypted))) {
      await fsp.copyFile(sourceEncrypted, targetEncrypted);
      await fsp.chmod(targetEncrypted, 0o600);
    }
  }
}

async function filesAreEqual(source, target) {
  try {
    const [src, dst] = await Promise.all([fsp.readFile(source), fsp.readFile(target)]);
    return src.equals(dst);
  } catch {
    return false;
  }
}

function gitCloneEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function resolveGitCloneSource(
  rawRepoUrl,
  { githubInstallationToken = null, gitlabOAuthToken = null } = {},
) {
  const repo = String(rawRepoUrl || "").trim();
  if (!repo) {
    return { url: repo, redacted: null };
  }

  if (githubInstallationToken) {
    const parsedGitHub = parseGitHubHttpsRepo(repo);
    if (parsedGitHub) {
      const safeToken = encodeURIComponent(githubInstallationToken);
      return {
        url: `https://x-access-token:${safeToken}@github.com/${parsedGitHub.owner}/${parsedGitHub.repo}.git`,
        redacted: `https://x-access-token:***@github.com/${parsedGitHub.owner}/${parsedGitHub.repo}.git`,
      };
    }
  }

  if (gitlabOAuthToken) {
    const parsedGitLab = parseGitLabHttpsRepo(repo);
    if (parsedGitLab) {
      const safeToken = encodeURIComponent(gitlabOAuthToken);
      return {
        url: `https://oauth2:${safeToken}@gitlab.com/${parsedGitLab.path}.git`,
        redacted: `https://oauth2:***@gitlab.com/${parsedGitLab.path}.git`,
      };
    }
  }

  return { url: repo, redacted: null };
}

function parseGitHubHttpsRepo(rawRepoUrl) {
  const repo = String(rawRepoUrl || "").trim();
  const match = repo.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match) {
    return null;
  }
  return {
    owner: match[1],
    repo: match[2],
  };
}

function parseGitLabHttpsRepo(rawRepoUrl) {
  const repo = String(rawRepoUrl || "").trim();
  const match = repo.match(/^https:\/\/gitlab\.com\/(.+?)(?:\.git)?\/?$/i);
  if (!match) {
    return null;
  }
  const path = String(match[1] || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!path || /\s/.test(path)) {
    return null;
  }
  return { path };
}

function findCanister(lookup, networkName) {
  for (const [name, value] of Object.entries(lookup)) {
    if (!value) {
      continue;
    }
    if (typeof value === "string" && value) {
      return { name, canisterId: value };
    }
    if (typeof value === "object" && value[networkName]) {
      return { name, canisterId: value[networkName] };
    }
  }
  return null;
}

function buildCanisterUrl(canisterId, networkName) {
  if (networkName === "ic") {
    return `https://${canisterId}.icp0.io`;
  }
  if (networkName === "playground") {
    return `https://${canisterId}.playground.icp0.io`;
  }
  const ingressHost = process.env.REPLICA_INGRESS_HOST || "replica.icp.localtest.me";
  return `http://${ingressHost}/?canisterId=${canisterId}`;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function normalizeReplicaHost(value) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_REPLICA_HOST;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
module.exports = { runBuildStage, runDeployStage };
