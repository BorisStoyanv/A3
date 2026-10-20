#!/usr/bin/env node
// Local, read-only UI preview. Does not import the API, .env files or credentials.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const fixtures = require("../demo/fixtures.cjs");

const root = path.resolve(__dirname, "../frontend/dist");
const port = Number(process.env.DEMO_PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jfif": "image/jpeg",
  ".ico": "image/x-icon",
};
const banner = `<style>body{padding-top:32px}</style><aside aria-label="Demo notice" style="position:fixed;top:0;left:0;right:0;z-index:99999;height:32px;display:flex;align-items:center;justify-content:center;background:#171b2f;color:#e2e8f0;font:12px/1.4 system-ui;border-bottom:1px solid #5c5a86">READ-ONLY DEMO · Synthetic data · No live deployments</aside>`;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    req.resume();
    return json(res, 403, { error: "Read-only demo. No changes or deployments are performed." });
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return json(res, 400, { error: "Invalid request path." });
  }
  if (Object.hasOwn(fixtures, pathname)) return json(res, 200, fixtures[pathname]);
  if (/^\/projects\/[a-f0-9-]+\/env-vars$/.test(pathname)) {
    return json(res, 200, [
      {
        id: "demo-public-variable",
        key: "VITE_SITE_TITLE",
        value: "Portfolio",
        isSecret: false,
        updatedAt: Date.now(),
      },
    ]);
  }
  const file = path.resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(root + path.sep) || pathname.includes("\0")) {
    return json(res, 400, { error: "Invalid request path." });
  }
  try {
    let content = await fs.readFile(file);
    if (file === path.join(root, "index.html"))
      content = Buffer.from(content.toString().replace("</body>", banner + "</body>"));
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch (error) {
    if (["ENOENT", "EISDIR", "ENOTDIR"].includes(error.code))
      return json(res, 404, { error: "Not found in demo." });
    throw error;
  }
}

async function main() {
  await fs.access(path.join(root, "index.html"));
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "Demo request failed." });
      else res.destroy();
    });
  });
  server.on("error", (error) => {
    console.error(`Cannot start demo: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `A3 read-only demo: http://127.0.0.1:${server.address().port}\nSynthetic fixtures only. No GitHub, database, cloud or ICP credentials are used.`,
    ),
  );
}
main().catch(() => {
  console.error("Build the dashboard first: npm run build");
  process.exitCode = 1;
});
