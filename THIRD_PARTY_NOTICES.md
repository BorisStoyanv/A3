# Third-party components

A3's original source is released under the MIT license in [LICENSE](LICENSE).
Dependencies retain their own licenses.

The host canister depends on DFINITY's `ic-certified-assets`, pinned to SDK commit
`c2060279e2dad7d18fe9fbe0112293a74554b8c2`. It supplies the certified asset storage
and HTTP response implementation. A3 adds tenant namespaces and deployment-ticket
checks around that library. The SDK checkout and its test identities are not
vendored into this repository.

See the upstream [SDK license](https://github.com/dfinity/sdk/blob/c2060279e2dad7d18fe9fbe0112293a74554b8c2/LICENSE)
and the dependency information in `canister/Cargo.lock` and `package-lock.json`.
