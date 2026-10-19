import test from "node:test";
import assert from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.NODE_ENV = "production";
process.env.ALLOWED_ORIGINS = "https://ui.example.invalid";
process.env.DEPLOY_TICKET_ENABLED = "false";
const { configure } = await import("../src/server.js");

test("all API routes reject malformed input and recover after async failures", async (t) => {
  const queries = [];
  const app = await configure({
    listen: false,
    database: {
      query: async (sql) => {
        queries.push(sql);
        throw new Error("synthetic database failure with private implementation details");
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options) => fetch(origin + path, options);
  const routes = app._router.stack.filter((layer) => layer.route).map((layer) => layer.route);
  assert.ok(routes.length >= 60, "exercise the actual application route registrations");

  await t.test("nested and repeated query parameters fail on every registered route", async () => {
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z]+/g, "11111111-1111-4111-8111-111111111111");
      for (const method of Object.keys(route.methods)) {
        const response = await request(path + "?state[nested]=bad", {
          method: method.toUpperCase(),
        });
        assert.equal(response.status, 400, `${method} ${route.path}`);
      }
    }
    assert.equal(queries.length, 0, "validation runs before database/session work");
  });

  await t.test("every UUID route rejects malformed IDs before a database cast", async () => {
    for (const route of routes.filter((item) => /:(id|tenantId|varId)(\/|$)/.test(item.path))) {
      const path = route.path.replace(/:[A-Za-z]+/g, "not-a-uuid");
      for (const method of Object.keys(route.methods)) {
        assert.equal((await request(path, { method: method.toUpperCase() })).status, 400, path);
      }
    }
    assert.equal(queries.length, 0);
  });

  await t.test(
    "JSON syntax, wrong field types, unsafe IDs and size limits return 4xx",
    async () => {
      const cases = [
        ["/profile/avatar", "PATCH", { avatarUrl: {} }],
        ["/auth/login", "POST", { username: [], password: {} }],
        ["/projects", "POST", { repoUrl: true }],
        ["/github/connect", "POST", { installationId: "123junk" }],
        ["/templates/provision", "POST", { githubInstallationId: -1 }],
        ["/projects", "POST", { envVars: [null] }],
        ["/projects", "POST", { branch: "--upload-pack=bad" }],
        ["/github/webhook", "POST", { repository: "not-an-object" }],
        ["/gitlab/webhook", "POST", { ref: [] }],
        ["/projects", "POST", []],
      ];
      for (const [path, method, body] of cases) {
        const response = await request(path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, `${method} ${path}: ${JSON.stringify(body)}`);
      }
      const broken = await request("/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"repoUrl":',
      });
      assert.equal(broken.status, 400);
      assert.equal(
        (await request("/projects", { method: "POST", body: "unexpected text" })).status,
        400,
      );
      const huge = await request("/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) }),
      });
      assert.equal(huge.status, 413);
      assert.equal((await request("/notifications?limit=2junk")).status, 400);
      assert.equal((await request("/projects/%E0%A4%A/tenant")).status, 400);
      assert.equal(queries.length, 0);
    },
  );

  await t.test(
    "unexpected async rejection returns sanitized 500 and leaves API healthy",
    async () => {
      const failure = await request("/routing/canisters/test-alias");
      assert.equal(failure.status, 500);
      assert.deepEqual(await failure.json(), { error: "Internal server error." });
      const health = await request("/healthz");
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
    },
  );
});
