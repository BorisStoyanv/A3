import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

async function digest(root, current = root, hash = createHash("sha256")) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const relative = path.slice(root.length + 1).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      hash.update(`dir:${relative}\n`);
      await digest(root, path, hash);
    } else if (entry.isFile()) {
      hash.update(`file:${relative}\n`);
      hash.update(await readFile(path));
    }
  }
  return current === root ? hash.digest("hex") : undefined;
}

test("real staged runner builds with isolated env and deploys only regenerated configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a3-flow-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      name: "a3-security-fixture",
      version: "1.0.0",
      scripts: { build: "node build.cjs" },
    }),
  );
  await writeFile(
    join(repo, "build.cjs"),
    `
    const fs = require('node:fs');
    for (const name of ['DEPLOY_TICKET','AWS_SECRET_ACCESS_KEY','GITHUB_INSTALLATION_TOKEN','A3_BUILD_ENV_JSON']) {
      if (process.env[name]) throw new Error('build inherited privileged setting: ' + name);
    }
    if (process.env.VITE_API_URL !== 'https://api.example.invalid') throw new Error('customer env missing');
    fs.mkdirSync('dist', {recursive:true});
    fs.writeFileSync('dist/index.html', '<h1>Build passed</h1>');
  `,
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["add", "package.json", "build.cjs"], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=A3 Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Static security fixture",
    ],
    { cwd: repo, stdio: "pipe" },
  );
  const runtimePath = `${dirname(process.execPath)}:${process.env.PATH}`;
  const work = join(root, "work");
  const runner = resolve(import.meta.dirname, "../../scripts/deploy-runner-staged.js");
  const baseEnv = {
    PATH: runtimePath,
    HOME: join(root, "home"),
    ICP_NETWORK: "local",
    DEPLOY_MODE_TYPE: "hosted",
    PROJECT_SLUG: "site",
    HOST_CANISTER_ID: "aaaaa-aa",
  };
  await mkdir(baseEnv.HOME);
  const args = [runner, `file://${repo}`, "main", work, "--network", "local"];
  const build = execFileSync(process.execPath, args, {
    env: {
      ...baseEnv,
      DEPLOY_STAGE: "build",
      A3_BUILD_ENV_JSON: JSON.stringify({ VITE_API_URL: "https://api.example.invalid" }),
      DEPLOY_TICKET: "synthetic-ticket",
      AWS_SECRET_ACCESS_KEY: "synthetic-cloud-secret",
    },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.match(build, /Build stage completed/);

  const project = join(work, "artifact/project");
  const marker = join(root, "malicious-hook-ran");
  await writeFile(
    join(project, "dfx.json"),
    JSON.stringify({ canisters: { frontend: { type: "custom", build: `touch ${marker}` } } }),
  );
  const manifestPath = join(work, "artifact/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.sha256 = await digest(project);
  await writeFile(manifestPath, JSON.stringify(manifest));

  const bin = join(root, "bin");
  await mkdir(bin);
  const dfx = join(bin, "dfx");
  await writeFile(
    dfx,
    `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.join(' ') === 'identity whoami') { console.log('test-identity'); process.exit(0); }
    const config = JSON.parse(fs.readFileSync('dfx.json'));
    if (config.canisters.frontend.type !== 'assets') throw new Error('untrusted config executed');
    if (process.env.A3_BUILD_ENV_JSON || process.env.VITE_API_URL) throw new Error('deploy received customer env');
    if (!fs.readFileSync('assets/__tenant/site/index.html','utf8').includes('Build passed')) throw new Error('missing static artifact');
    console.log('trusted-dfx-fixture-ok');
  `,
  );
  await chmod(dfx, 0o700);
  const identity = join(root, "synthetic-identity.pem");
  await writeFile(identity, "synthetic identity fixture; never used against ICP");
  const deployed = execFileSync(process.execPath, args, {
    env: {
      ...baseEnv,
      PATH: `${bin}:${runtimePath}`,
      DEPLOY_STAGE: "deploy",
      DFX_IDENTITY: "test-identity",
      DEPLOY_IDENTITY_PEM: identity,
      DEPLOY_IDENTITY_NAME: "test-identity",
      DEPLOY_TICKET: "synthetic-ticket",
      DEPLOY_TICKET_SIGNATURE_B64: Buffer.alloc(64).toString("base64"),
    },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.match(deployed, /Deploy stage completed/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});
