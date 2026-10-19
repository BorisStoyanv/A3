import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import envSecurity from "../src/security/runner-env.cjs";

process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.NODE_ENV = "production";
process.env.DEPLOY_TICKET_ENABLED = "false";
const { buildJobSpec } = await import("../src/server.js");
const { validateCustomerEnv, createCustomerBuildEnv } = envSecurity;

test("customer env is data for the build job; deploy receives none of it", () => {
  const deployment = {
    id: randomUUID(),
    repoUrl: "https://github.com/example/site.git",
    branch: "main",
    metadata: { projectSlug: "site", hostCanisterId: "aaaaa-aa" },
  };
  const input = {
    customerEnv: {
      VITE_API_URL: "https://api.example.invalid",
      SECRET_BUILD_VALUE: "synthetic-build-value",
    },
    githubInstallationToken: "synthetic-clone-token",
  };
  for (const stage of ["build", "deploy"]) {
    const spec = buildJobSpec(
      "test-job",
      stage,
      deployment,
      { buildCommand: "npm run build" },
      "ic",
      "hosted",
      input,
    ).spec.template.spec;
    const container = spec.containers[0];
    const env = Object.fromEntries(container.env.map(({ name, value }) => [name, value]));
    assert.equal(spec.automountServiceAccountToken, false);
    assert.equal(spec.hostNetwork, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(
      container.env.some(({ name }) => name === "VITE_API_URL"),
      false,
    );
    if (stage === "build") {
      assert.equal(JSON.parse(env.A3_BUILD_ENV_JSON).SECRET_BUILD_VALUE, "synthetic-build-value");
      assert.equal(env.GITHUB_INSTALLATION_TOKEN, "synthetic-clone-token");
      assert.equal(
        spec.volumes.some(({ secret }) => secret),
        false,
      );
      assert.equal(env.DEPLOY_TICKET, undefined);
    } else {
      assert.equal(env.A3_BUILD_ENV_JSON, undefined);
      assert.equal(env.GITHUB_INSTALLATION_TOKEN, undefined);
      assert.equal(env.DEPLOY_BUILD_COMMAND, undefined);
      assert.equal(JSON.stringify(spec).includes("synthetic-build-value"), false);
      assert.equal(
        container.volumeMounts.find(({ name }) => name === "workspace-storage").readOnly,
        true,
      );
      assert.equal(
        spec.volumes.some(({ name }) => name === "identity-secret"),
        true,
      );
    }
  }
});

test("runtime injection and cloud credential overrides are rejected, including existing DB values", () => {
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "BASH_ENV",
    "ENV",
    "AWS_ACCESS_KEY_ID",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GIT_CONFIG_COUNT",
    "NPM_CONFIG_USERCONFIG",
    "DFX_IDENTITY",
    "DEPLOY_TICKET",
    "A3_BUILD_ENV_JSON",
  ]) {
    assert.throws(() => validateCustomerEnv({ [key]: "synthetic" }), /Reserved or invalid/);
  }
});

test("an actual build subprocess sees customer variables but no runner/deploy/cloud credentials", () => {
  const env = createCustomerBuildEnv(
    {
      PATH: process.env.PATH,
      AWS_SECRET_ACCESS_KEY: "synthetic-cloud-secret",
      DEPLOY_TICKET: "synthetic-ticket",
      GITHUB_INSTALLATION_TOKEN: "synthetic-clone-token",
      GOOGLE_APPLICATION_CREDENTIALS: "/credentials.json",
      NODE_OPTIONS: "--invalid-test-option",
    },
    { VITE_API_URL: "https://api.example.invalid" },
  );
  const output = execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    { env, encoding: "utf8" },
  );
  const child = JSON.parse(output);
  assert.equal(child.VITE_API_URL, "https://api.example.invalid");
  for (const key of [
    "AWS_SECRET_ACCESS_KEY",
    "DEPLOY_TICKET",
    "GITHUB_INSTALLATION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "NODE_OPTIONS",
  ]) {
    assert.equal(child[key], undefined);
  }
});
