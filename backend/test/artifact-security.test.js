import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import artifactSecurity from "../../scripts/security-artifact.cjs";
const { prepareTrustedArtifact } = artifactSecurity;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "a3-security-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "artifact/project");
  const site = join(project, "hosted-assets/__tenant/site");
  await mkdir(site, { recursive: true });
  await writeFile(join(site, "index.html"), "<h1>Static fixture</h1>");
  return { root, project, site };
}

test("only the assigned tenant's static bytes cross into deployment; hooks and IDs do not", async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(
    join(project, "dfx.json"),
    JSON.stringify({ defaults: { build: { packtool: "malicious-command" } } }),
  );
  await writeFile(join(project, "canister_ids.json"), '{"frontend":{"ic":"different-canister"}}');
  await mkdir(join(project, "hosted-assets/__tenant/other"));
  await writeFile(join(project, "hosted-assets/__tenant/other/index.html"), "other tenant");
  const trusted = await prepareTrustedArtifact({
    stageRoot: root,
    mode: "hosted",
    slug: "site",
    maxBytes: 1024,
  });
  t.after(() => rm(trusted, { recursive: true, force: true }));
  assert.deepEqual(await readdir(trusted), ["assets"]);
  assert.deepEqual(await readdir(join(trusted, "assets/__tenant")), ["site"]);
  assert.equal(
    await readFile(join(trusted, "assets/__tenant/site/index.html"), "utf8"),
    "<h1>Static fixture</h1>",
  );
});

test("artifact symlinks cannot import credential paths", async (t) => {
  const { root, site } = await fixture(t);
  await symlink("/credentials/identity.pem", join(site, "escape.pem"));
  await assert.rejects(
    prepareTrustedArtifact({ stageRoot: root, mode: "hosted", slug: "site", maxBytes: 1024 }),
    /Symbolic links/,
  );
});

test("tenant path traversal and excessive artifact sizes are rejected", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    prepareTrustedArtifact({
      stageRoot: root,
      mode: "hosted",
      slug: "../../identity",
      maxBytes: 1024,
    }),
    /Invalid tenant/,
  );
  await assert.rejects(
    prepareTrustedArtifact({ stageRoot: root, mode: "hosted", slug: "site", maxBytes: 1 }),
    /exceeds/,
  );
});
