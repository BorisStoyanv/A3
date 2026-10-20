// Synthetic presentation data only. Never import customer exports into this file.
const now = Date.now();
const day = 24 * 60 * 60 * 1000;
const names = ["portfolio", "developer-docs", "product-site", "status-page"];
const projects = names.map((name, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  gitProvider: "github",
  repoUrl: `https://github.com/example/${name}`,
  branch: "main",
  github: { fullName: `demo/${name}`, defaultBranch: "main", private: false },
  tenant: { slug: name, hostedUrl: `https://${name}--demo.example.com` },
  webhookUrl: "https://api.example.com/github/webhook",
  createdAt: now - 14 * day,
  updatedAt: now - index * 45 * 60 * 1000,
  settings: {
    framework: "vite",
    rootDir: "",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDir: "dist",
  },
}));
const deployments = [];
for (let daysAgo = 0; daysAgo < 7; daysAgo += 1) {
  const count = [2, 3, 1, 4, 2, 3, 1][daysAgo];
  for (let run = 0; run < count; run += 1) {
    const project = projects[0];
    const createdAt = now - daysAgo * day - (run * 70 + 12) * 60000;
    const failed = daysAgo === 4 && run === 1;
    const buildMs = [24100, 28700, 21800, 31400, 26200, 23800, 29100][daysAgo] + run * 800;
    const deployMs = 11200 + run * 400;
    deployments.push({
      id: `demo-run-${daysAgo}-${run}`,
      projectId: project.id,
      project,
      status: failed ? "failed" : "succeeded",
      source: "github-webhook",
      branch: "main",
      createdAt,
      updatedAt: createdAt + buildMs + deployMs,
      durationMs: buildMs + deployMs,
      endpoint: project.tenant.hostedUrl,
      stages: {
        build: {
          status: failed ? "failed" : "succeeded",
          startedAt: createdAt,
          finishedAt: createdAt + buildMs,
        },
        deploy: {
          status: failed ? "pending" : "succeeded",
          startedAt: failed ? null : createdAt + buildMs,
          finishedAt: failed ? null : createdAt + buildMs + deployMs,
        },
      },
      logs: failed
        ? [
            "[build] Installing dependencies with npm ci",
            "[build] Build failed: output directory dist was not found.",
            "[build] Check the project output directory before retrying.",
          ]
        : [
            "[build] Cloning demo/portfolio at main",
            "[build] Installing dependencies with npm ci",
            "[build] vite building for production…",
            "[build] Static output ready: dist (12 files)",
            "[build] Build stage completed.",
            "[deploy] Validating tenant artifact and static asset digest",
            "[deploy] Preparing trusted deployment configuration",
            "[deploy] Uploading certified assets to tenant namespace",
            "[deploy] Deploy stage completed.",
          ],
    });
  }
}
projects.slice(1).forEach((project, index) => {
  const createdAt = now - (index + 1) * 45 * 60000;
  deployments.push({
    ...deployments[0],
    id: `demo-project-${index}`,
    projectId: project.id,
    project,
    createdAt,
    updatedAt: createdAt + 39000,
    durationMs: 39000,
    endpoint: project.tenant.hostedUrl,
    stages: {
      build: { status: "succeeded", startedAt: createdAt, finishedAt: createdAt + 27000 },
      deploy: { status: "succeeded", startedAt: createdAt + 27000, finishedAt: createdAt + 39000 },
    },
    logs: deployments[0].logs.map((line) =>
      line.replace("demo/portfolio", `demo/${names[index + 1]}`),
    ),
  });
});
deployments.sort((a, b) => b.createdAt - a.createdAt);

module.exports = {
  "/session": {
    authenticated: true,
    localAuthEnabled: false,
    githubAuthEnabled: false,
    githubAppEnabled: true,
    gitlabAuthEnabled: false,
    onboardingRequired: false,
    user: {
      id: "demo-user",
      email: "demo@example.com",
      username: "demo-engineer",
      displayName: "Demo Engineer",
      avatarUrl: "/default-avatar.png",
      isAdmin: false,
    },
    github: { login: "demo-engineer" },
    billing: { isPro: false, tier: "free" },
  },
  "/projects": projects,
  "/deployments": deployments,
  "/deployment-regions": {
    public: [{ id: "global", name: "Global", label: "Global" }],
    private: [],
  },
  "/github/installations": [
    {
      installationId: 1,
      accountLogin: "demo-engineer",
      accountType: "User",
      repositorySelection: "selected",
    },
  ],
  "/github/repos": projects.map((project, index) => ({
    id: index + 1,
    fullName: project.github.fullName,
    name: names[index],
    cloneUrl: project.repoUrl,
    htmlUrl: project.repoUrl,
    defaultBranch: "main",
    private: false,
    installationId: 1,
    gitProvider: "github",
  })),
  "/notifications": [],
  "/templates": [],
};
