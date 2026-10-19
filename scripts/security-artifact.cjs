const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

async function directory(folder) {
  const info = await fs.lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Artifact must contain only regular directories and files.");
}

async function copyStaticTree(source, destination, budget) {
  await directory(source);
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const info = await fs.lstat(from);
    if (info.isSymbolicLink())
      throw new Error("Symbolic links are not permitted in deployment artifacts.");
    if (info.isDirectory()) {
      await copyStaticTree(from, to, budget);
    } else if (info.isFile()) {
      budget.bytes += info.size;
      budget.files += 1;
      if (budget.bytes > budget.maxBytes || budget.files > 50000)
        throw new Error("Deployment artifact exceeds its limit.");
      await fs.copyFile(from, to);
      await fs.chmod(to, 0o600);
    } else {
      throw new Error("Special files are not permitted in deployment artifacts.");
    }
  }
}

// A build's dfx.json, hooks, executables, IDs, and manifest paths are untrusted.
// Import only static bytes into a fresh deploy-owned directory, before loading
// identity material, and regenerate all executable configuration there.
async function prepareTrustedArtifact({ stageRoot, mode, slug, maxBytes }) {
  await directory(stageRoot);
  const artifact = path.join(stageRoot, "artifact");
  await directory(artifact);
  const project = path.join(artifact, "project");
  await directory(project);
  let source = path.join(project, mode === "hosted" ? "hosted-assets" : "eject-assets");
  await directory(source);
  let prefix = "";
  if (mode === "hosted") {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug || ""))
      throw new Error("Invalid tenant slug.");
    source = path.join(source, "__tenant");
    await directory(source);
    source = path.join(source, slug);
    prefix = path.join("__tenant", slug);
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "a3-trusted-deploy-"));
  try {
    await copyStaticTree(source, path.join(temp, "assets", prefix), {
      bytes: 0,
      files: 0,
      maxBytes,
    });
    const entry = await fs.lstat(path.join(temp, "assets", prefix, "index.html"));
    if (!entry.isFile()) throw new Error("Static entrypoint is missing.");
    return temp;
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { prepareTrustedArtifact };
