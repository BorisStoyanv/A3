# Dashboard demo and screenshots

`npm run demo` builds and serves the real dashboard locally at http://127.0.0.1:4173. The server binds only to loopback and uses the synthetic records in [`demo/fixtures.cjs`](../demo/fixtures.cjs). `DEMO_PORT` can select a different local port.

There is no connection to PostgreSQL, GitHub, a cloud provider, or ICP. The preview does not import the production API or read `.env` files. Every write request returns a read-only error. Form fields can be explored, but saving, redeploying, signing out, billing, and account-management actions do not perform their normal operations. Template and notification data are intentionally empty. Demo URLs use reserved example domains and are not live hosted sites.

## What to explore

1. **Overview:** select projects, inspect build/deploy outcomes, read logs, search the list, and view deployment charts.
2. **Deployments:** select a run to inspect its logs, including the sample failed build.
3. **Projects:** inspect build configuration and environment-variable controls.
4. Use the sidebar theme toggle to see both dashboard themes.

For production behavior and its prerequisites, see [deployment.md](deployment.md). The preview is not an end-to-end deployment demonstration.

## Screenshot provenance

The PNG files in [`screenshots/`](screenshots/) were captured on October 20, 2026 in Chromium from this local preview. They show the actual built React frontend with sample API responses. No images were generated with AI, and no UI panels were composited into the captures.

All names, URLs, logs, timestamps, durations, and chart values in these images come from synthetic fixtures. The historical pilot figures in the main README (34 users, 38 projects, 283 deployment records) are a separate aggregate snapshot and are not the demo fixtures.

To refresh the images, run `npm run demo`, open the dashboard in a browser, and capture the overview, deployment history, and project settings. Keep the read-only/synthetic-data notice visible. The fixtures use dates relative to preview startup so the seven-day charts remain populated. Never substitute customer exports, real environment values, or private repository information for the demo data.
