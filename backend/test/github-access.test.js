import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyUserInstallation,
  userInstallationRepositories,
} from "../src/security/github-access.js";

const response = (payload, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => payload,
});
const own = { id: 123, app_id: 456, account: { id: 789, type: "User" } };

test("forged installation ID is denied even when it is a real App installation", async () => {
  const calls = [];
  await assert.rejects(
    verifyUserInstallation({
      installationId: 999,
      appId: 456,
      accessToken: "synthetic-user-token",
      apiFetch: async (endpoint, options) => {
        calls.push(endpoint);
        assert.equal(options.headers.Authorization, "Bearer synthetic-user-token");
        return response({ installations: [own] });
      },
    }),
    (error) => error.status === 403,
  );
  assert.deepEqual(calls, ["user/installations?per_page=100&page=1"]);
});

test("personal and organization installations are accepted only from the user's GitHub response", async () => {
  for (const type of ["User", "Organization"]) {
    const installation = { ...own, account: { id: 789, type } };
    const result = await verifyUserInstallation({
      installationId: "123",
      appId: "456",
      accessToken: "synthetic-user-token",
      apiFetch: async () => response({ installations: [installation] }),
    });
    assert.equal(result.account.type, type);
  }
});

test("wrong App, suspended installation, expired token and missing token fail closed", async () => {
  for (const installation of [
    { ...own, app_id: 888 },
    { ...own, suspended_at: "2026-01-01" },
  ]) {
    await assert.rejects(
      verifyUserInstallation({
        installationId: 123,
        appId: 456,
        accessToken: "synthetic",
        apiFetch: async () => response({ installations: [installation] }),
      }),
      { status: 403 },
    );
  }
  for (const status of [401, 403, 404]) {
    await assert.rejects(
      verifyUserInstallation({
        installationId: 123,
        appId: 456,
        accessToken: "synthetic",
        apiFetch: async () => response({}, status),
      }),
      { status: 403 },
    );
  }
  await assert.rejects(
    verifyUserInstallation({
      installationId: 123,
      appId: 456,
      apiFetch: async () => {
        throw new Error("must not call GitHub without a user token");
      },
    }),
    { status: 403 },
  );
});

test("installation discovery follows pagination and checks strict numeric IDs", async () => {
  const pages = [];
  const result = await verifyUserInstallation({
    installationId: 123,
    appId: 456,
    accessToken: "synthetic",
    apiFetch: async (endpoint) => {
      pages.push(endpoint);
      return response({
        installations:
          pages.length === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1000 })) : [own],
      });
    },
  });
  assert.equal(result.id, 123);
  assert.equal(pages.length, 2);
  for (const installationId of ["123junk", "1.5", "-2", "0", "9007199254740993"]) {
    await assert.rejects(verifyUserInstallation({ installationId }), { status: 400 });
  }
});

test("repository listing uses user-scoped visibility, never an installation-wide token", async () => {
  const rows = await userInstallationRepositories({
    installationId: 123,
    accessToken: "synthetic-user",
    apiFetch: async (endpoint, options) => {
      assert.equal(endpoint, "user/installations/123/repositories?per_page=100&page=1");
      assert.equal(options.headers.Authorization, "Bearer synthetic-user");
      return response({ repositories: [{ id: 1, full_name: "allowed/repo" }] });
    },
  });
  assert.deepEqual(
    rows.map((row) => row.full_name),
    ["allowed/repo"],
  );
});
