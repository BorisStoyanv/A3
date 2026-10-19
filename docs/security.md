# Security boundaries

A3 executes code from Git repositories. Treat build commands, dependencies, generated files, and customer environment variables as untrusted. Public preparation improved the boundaries below; it is not an independent security audit.

## Build and deploy separation

Customer environment variables are validated, serialized as build-job data, and supplied to the build subprocess through an allowlisted environment. Runtime-injection variables and cloud/deploy credential namespaces are rejected. The deploy job receives no customer variables or build command and does not mount a service-account token. Its uploader identity is never mounted in the build job.

The deploy process distrusts the shared artifact volume. It imports only regular files under the assigned tenant's static output, rejects symlinks, traversal, oversized output, and unexpected paths, verifies the static-byte digest, and creates fresh trusted `dfx` configuration and canister IDs. Build-provided hooks and configuration are not executed during deployment. The artifact volume is read-only in the deploy pod.

Repository clone tokens are short-lived and repository-scoped. They are used in the build stage, not the deploy stage. Builds still process private repository contents and customer-supplied build secrets. A malicious dependency can expose secrets that a customer intentionally provides to that build. Static frontend output and browser environment variables are public.

Kubernetes containers share a host kernel. NetworkPolicy, cloud metadata protection, resource limits, provider IAM, and a patched container runtime remain operational prerequisites. The code changes do not prove a particular cluster enforces them. Stronger sandboxing and live denial tests are future work.

## GitHub installation access

The API uses the logged-in user's encrypted GitHub OAuth token to retrieve that user's accessible installations. A supplied installation ID must be present, belong to the configured App, and be unsuspended. Repository discovery uses the user-scoped installation-repositories API. Repository access is checked before creating a repository-scoped installation token; a previously stored installation link is not sufficient authorization.

Missing, revoked, or expired user authorization fails closed. Users from before migration 025 must reconnect. Organizations may independently restrict installations and repository visibility.

## API validation and failures

Registered endpoints share parameter, query, JSON shape/type/size, and webhook validation plus an asynchronous error boundary. Malformed JSON, invalid IDs, nested query values, and unsupported field types return client errors. Unexpected failures return a sanitized 500 response without sending database details to the caller. Regression tests exercise actual registered HTTP routes and confirm the process stays healthy after a rejected database operation.

These checks complement each endpoint's ownership, session, CSRF, signature, and rate-limit rules. They do not replace authorization or make every business rule a formal schema.

## Keys, state, and custody

Only placeholders belong in [`.env.example`](../.env.example). Keep completed configuration files, uploader identities, signing keys, KMS credentials, kubeconfigs, database exports, and recovery archives outside Git. Losing the environment encryption key makes encrypted values unreadable; protect and back it up separately. Rotating a key also requires planning for existing ciphertext.

Shared host canisters remain operator-controlled. Tickets constrain individual deployments; they do not remove the operator's controller privileges or make customer sites independent canisters. Eject is disabled by default and unfinished.

The original source repositories and the publication copy were scanned with Gitleaks, including all original Git histories available locally. Suspected history matches were reviewed as invalid placeholders, code references, or upstream SDK test fixtures; no operational A3 history secret was confirmed. Real credentials present in local recovery material were excluded. No history was rewritten, no credential validity was tested against a provider, and no credentials were rotated automatically.

## Verification limits

The test suite covers job specifications, actual subprocess environments, artifact import attacks, GitHub access decisions using mocked API responses, and malformed requests against the registered API. A staged-flow test builds a temporary local Git repository and uses a fake `dfx` for deployment. This does not prove live GitHub, Kubernetes, or ICP integration.

Rust formatting, Clippy, and release Wasm compilation pass; Rust currently reports zero unit tests. Local migration checks used PostgreSQL 16. Neither an actual cloud rollout nor live canister ticket/upgrade integration was performed as part of publication preparation.

To report a suspected issue, contact the repository owner privately through their GitHub profile. Do not include working credentials or private customer data in a public issue.
