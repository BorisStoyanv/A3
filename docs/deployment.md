# Deployment guide

A3 has three separately operated parts: a control plane, Kubernetes workers, and ICP asset canisters. Hostname-to-tenant routing is a fourth integration. The manifests are examples requiring your own images, domains, Secrets, storage, and ingress configuration. They are not a one-command production installation.

## 1. Configure a GitHub App

Create your own GitHub App. Supply its ID, slug, OAuth client ID/secret, private key, webhook secret, and a random OAuth state secret using the names in [`.env.example`](../.env.example).

Configure the user authorization callback as `<API_BASE_URL>/auth/github/callback`, the installation setup callback as `<API_BASE_URL>/github/app/callback`, and the webhook URL as `<API_BASE_URL>/github/webhook`. For the cloud examples, those are under `https://api.example.com`; replace that domain. For local development, callbacks and incoming webhooks need an appropriate development HTTPS endpoint.

The core clone flow needs repository **Contents: read** and **Metadata: read**. Subscribe to push events. The optional template-provisioning flow creates repositories and commits files; enabling it requires reviewing and granting the corresponding GitHub permissions rather than treating read access as sufficient. Enable user authorization for the App. Organization policy can still restrict installation and repository visibility.

A3 stores the user's OAuth token encrypted and uses it to check accessible installations and repositories. Existing users must reconnect after migration `025_github_user_access_tokens.sql`. Expired or revoked user authorization fails closed; automatic refresh-token management is not implemented.

Keep `APP_PUBLIC_URL` and `FRONTEND_BASE_URL` set to the dashboard origin and `API_BASE_URL` set to the API origin. Cross-subdomain production cookies require matching HTTPS, allowed origins, and `CSRF_COOKIE_DOMAIN`. Do not use wildcard CORS origins with session cookies.

## 2. Build images

From the repository root:

```sh
npm ci
npm run check
docker build --platform linux/amd64 -t YOUR_REGISTRY/a3-backend:VERSION .
docker build --platform linux/amd64 -f frontend/Dockerfile -t YOUR_REGISTRY/a3-dashboard:VERSION .
```

Push those images to your registry using your own normal registry workflow. The backend image also runs worker jobs and contains `dfx` 0.26.1. Its default download is Linux x86-64, so use amd64 nodes and images unless you deliberately adjust and test `DFX_ARCH`.

Update both the backend container image and `DEPLOY_JOB_IMAGE`, plus the dashboard image in the manifests. Configure an image pull secret if the registry is private. The dashboard uses same-origin API requests through Nginx; its upstream service is `icp-backend.workspace-alpha.svc.cluster.local:3000`. For a different namespace or routing arrangement, update `frontend/nginx.conf` and rebuild. `VITE_API_BASE_URL` is an optional build-time override for a separately served dashboard.

## 3. Prepare the host canister

Install Rust with the `wasm32-unknown-unknown` target and a compatible `dfx`. Use a controller identity for canister administration and a separate uploader identity for automated deployments. Keep their private files outside the repository.

The uploader allowlist is compiled into the canister through `A3_UPLOADER_PRINCIPAL`. Obtain that **public** principal from the intended uploader identity, then build/deploy using the controller identity:

```sh
cd canister
# Substitute a public principal, not a private identity key.
A3_UPLOADER_PRINCIPAL=YOUR_UPLOADER_PRINCIPAL dfx deploy --network ic host_asset_canister
```

Fund the controller's deployment workflow and canister with cycles before mainnet deployment. For an isolated local replica use the same process with `--network local`. An unset uploader principal deliberately permits no uploader; an invalid principal is not a valid deployment configuration. Changing the uploader requires a rebuild and controlled upgrade. Retain the build setting for subsequent upgrades.

Generate an Ed25519 deploy-ticket signing key outside the checkout. Put the private PEM in the control-plane Secret; configure the matching **raw 32-byte public key**, not a PEM document, on the canister using `set_deploy_ticket_verifier(key_id, public_key)`. As the controller, call `set_deploy_ticket_enforcement(true)` and inspect `get_deploy_ticket_state()` before enabling public deployments. These method signatures are in [`host_asset_canister.did`](../canister/src/host_asset_canister.did). The configured key ID must match `DEPLOY_TICKET_KEY_ID`; signing and enforcement must both be enabled.

The source does not bundle a historical production canister ID or a preconfigured custom-domain metadata file. Register your own domain and metadata as required by your ICP gateway/routing setup.

## 4. Prepare Kubernetes and Secrets

Use a cluster whose CNI actually enforces NetworkPolicy. Runner pods must not reach cloud metadata, cluster/private services, or cloud credentials. Run active enforcement checks in your cluster; rendering a YAML file does not prove isolation.

- **EKS:** [`infra/aws/cluster.example.yaml`](../infra/aws/cluster.example.yaml) is a fresh-cluster example with CNI network policies in strict mode and pod IMDS disabled. Review node size, availability, endpoint access, version support, cost, and the EBS CSI role. It is not an in-place upgrade plan for an existing cluster. The gp3 StorageClass example is under `infra/k8s/platform/`.
- **GKE:** use the common platform manifests on a GKE cluster with network policy enforcement. Configure metadata protection and Workload Identity so build/deploy service accounts have no cloud IAM grants. Adapt storage and ingress to the cluster. The publication does not contain a complete GKE cluster-provisioning module or an active-active two-cloud failover system.
- **Local Kubernetes:** `infra/k8s/platform/local` includes a development replica and is not an isolation-equivalent production environment. Its replica state is ephemeral and its traffic is HTTP. Never load a production identity or cloud credentials into it.

The mainnet ingress example uses the placeholder class `a3-public`. Install a maintained ingress controller, configure TLS and redirects, and adapt the ingress class plus NetworkPolicy ingress selectors to it. Policy examples select controller pods labeled `app.kubernetes.io/name=a3-ingress` in `ingress-system`; they must match the actual deployment. The previous community ingress-nginx installation is not a recommended new dependency; see the [Kubernetes retirement notice](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/).

The default-deny policy allows DNS, public HTTPS for runners with private/link-local ranges excluded, and the explicit control-plane connections. Allowing public HTTPS is not a repository/package-registry domain allowlist. Your CNI, IPv6 settings, DNS, metadata endpoint, and cloud control-plane routes need live verification. The backend also needs Kubernetes API connectivity; account for the API endpoint's actual address and port when adapting the HTTPS egress policy.

Create the namespace first, then provision these Secrets using your secret manager or files outside the checkout:

| Secret                 | Expected keys / use                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `icp-backend-secrets`  | `DATABASE_URL`, `ENV_VARS_MASTER_KEY` or KMS settings, GitHub App settings, and any enabled optional integration credentials |
| `icp-postgres-secret`  | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`; match the backend database URL                                          |
| `identity-uploader-a3` | `identity.pem` for the configured uploader identity; mounted in the deploy worker, never the build worker                    |
| `deploy-ticket-signer` | `key_id`, `private_key_pem`; API signs tickets and sends a short-lived signed ticket to a deploy job                         |

Do not commit rendered Secret manifests. The examples use Secret references only. For example, with an uploader file stored outside the checkout:

```sh
kubectl -n workspace-alpha create secret generic identity-uploader-a3 \
  --from-file=identity.pem=/ABSOLUTE/PRIVATE/PATH/identity.pem
```

Set nonsecret configuration in the backend ConfigMap, replace `example.com` domains, and configure production cookie settings. Add yourself to `admin_allowlist_emails` in PostgreSQL using your verified GitHub email, then reconnect to refresh the session's admin status. Register the host canister, alias, region, visibility, and capacity through the admin dashboard. Host assignment is database-backed; setting `HOST_CANISTER_ID` alone is not a substitute for registering the host pool.

The example PVCs use `ReadWriteOnce`. API workspace preparation and worker jobs need compatible volume attachment/scheduling; a multi-node rollout needs a storage and scheduling design appropriate to shared artifacts. The one-node example has no high-availability guarantee. Plan PostgreSQL backups and restore tests independently.

Render and review the manifests before applying your configured copy:

```sh
kubectl kustomize infra/k8s/platform/mainnet
# Once configured, with the intended kube context selected:
kubectl apply -k infra/k8s/platform/mainnet
```

Apply migration 025 before re-enabling GitHub integrations. Rebuild existing queued artifacts after upgrading the runner: old artifacts without the static-assets digest intentionally fail validation.

## 5. Configure website routing

The dashboard ingress serves the control plane, not customer websites. Configure wildcard DNS and a gateway/edge route for the hosting domain. The API exposes `/routing/canisters/:alias` to resolve a host alias. The router must map the tenant hostname, such as `<slug>--<alias>.<hosting-domain>`, to the canister's `/__tenant/<slug>/...` asset namespace while preserving the site's expected paths and content-certification behavior.

No standalone production edge-worker implementation is included in this publication. This integration must be supplied and tested by the operator; creating DNS records alone does not complete it. Verify deep links, asset paths, custom domains, cache behavior, and tenant separation before advertising a live demo.

## 6. Verify before opening sign-ups

With a demo account and a small static repository, test sign-in, installation access, the initial deployment, a push-triggered rebuild, logs, and the live URL. Check that a different account cannot list or build a repository it cannot access. From a build pod verify metadata and internal network denial and absence of deploy credentials. Test invalid input and observe continued API health. Check canister ticket enforcement, rejected foreign-tenant writes, expiry, and upgrades on a nonproduction canister.

Local preparation verified 17 JavaScript tests, frontend and Docker builds, 25 PostgreSQL migrations, Rust lint/build checks, and Kustomize rendering. It did not roll out this hardened version to either cloud, exercise real GitHub authorization, or run a live ICP upgrade. Keep that distinction when describing the demo's status.
