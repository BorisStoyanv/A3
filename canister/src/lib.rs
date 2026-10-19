use candid::{candid_method, CandidType, Deserialize, Nat, Principal};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use ic_cdk::api::{canister_self, is_controller, msg_caller, time, trap};
use ic_cdk::{post_upgrade, pre_upgrade, query, update};
use ic_certified_assets::asset_certification::types::http::{
    HttpRequest, HttpResponse, StreamingCallbackHttpResponse, StreamingCallbackToken,
};
use ic_certified_assets::state_machine::{AssetDetails, EncodedAsset};
use ic_certified_assets::types::{
    AssetProperties, BatchOperation, CommitBatchArguments, CreateBatchResponse, CreateChunkArg,
    CreateChunkResponse, CreateChunksArg, CreateChunksResponse, GetArg, GetChunkArg,
    GetChunkResponse, SetAssetPropertiesArguments,
};
use std::cell::RefCell;
use std::collections::BTreeMap;

const ALLOWED_UPLOADER_TEXT: Option<&str> = option_env!("A3_UPLOADER_PRINCIPAL");
const DEPLOY_TICKET_VERSION: &str = "v1";
const MAX_TICKET_LIFETIME_MS: u64 = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS: u64 = 60 * 1000;
const MAX_NONCE_LEN: usize = 128;
const MAX_KEY_ID_LEN: usize = 128;
const MAX_ID_FIELD_LEN: usize = 128;

#[cfg(target_arch = "wasm32")]
#[used]
#[unsafe(link_section = "icp:public supported_certificate_versions")]
static CERTIFICATE_VERSIONS: [u8; 3] = ic_certified_assets::SUPPORTED_CERTIFICATE_VERSIONS;

#[derive(CandidType, Deserialize, Clone, Default)]
struct DeploySession {
    slug: String,
    deployment_id: String,
    project_id: String,
    host_canister_id: String,
    key_id: String,
    nonce: String,
    expires_at_ms: u64,
}

#[derive(CandidType, Deserialize, Clone, Default)]
struct StableState {
    verifier_keys: BTreeMap<String, Vec<u8>>,
    enforce_deploy_ticket: bool,
    // Keyed by "<caller>|<deployment_id>" so one uploader principal can hold
    // multiple concurrent deploy sessions safely.
    active_sessions: BTreeMap<String, DeploySession>,
    used_nonces: BTreeMap<String, u64>,
    batch_slug_bindings: BTreeMap<String, String>,
    batch_session_bindings: BTreeMap<String, String>,
}

#[derive(CandidType, Deserialize, Clone, Default)]
struct UpgradeStableState {
    deploy_ticket_state: StableState,
    assets_state_cbor: Vec<u8>,
}

#[derive(CandidType, Deserialize)]
struct DeployTicketStateView {
    enforce_deploy_ticket: bool,
    key_ids: Vec<String>,
    active_sessions: u64,
    replay_entries: u64,
    batch_bindings: u64,
}

struct ParsedDeployTicket {
    key_id: String,
    deployment_id: String,
    project_id: String,
    host_canister_id: String,
    slug: String,
    issued_at_ms: u64,
    expires_at_ms: u64,
    nonce: String,
}

thread_local! {
    static STATE: RefCell<StableState> = RefCell::new(StableState::default());
}

#[query]
fn http_request(req: HttpRequest) -> HttpResponse {
    ic_certified_assets::http_request(req)
}

#[query]
fn http_request_streaming_callback(token: StreamingCallbackToken) -> StreamingCallbackHttpResponse {
    ic_certified_assets::http_request_streaming_callback(token)
}

#[query]
fn api_version() -> u16 {
    ic_certified_assets::api_version()
}

#[query]
fn list() -> Vec<AssetDetails> {
    assert_uploader();
    ic_certified_assets::list()
}

#[query]
fn get(arg: GetArg) -> EncodedAsset {
    assert_uploader();
    ic_certified_assets::get(arg)
}

#[query]
fn get_chunk(arg: GetChunkArg) -> GetChunkResponse {
    assert_uploader();
    ic_certified_assets::get_chunk(arg)
}

#[query]
fn get_asset_properties(key: String) -> AssetProperties {
    assert_uploader();
    ic_certified_assets::get_asset_properties(key)
}

#[ic_cdk::update]
#[candid_method(update)]
fn begin_deploy(ticket: String, signature: Vec<u8>) {
    assert_uploader();
    let parsed = parse_deploy_ticket(&ticket);
    if parsed.host_canister_id != canister_self().to_text() {
        trap("deploy ticket host canister mismatch");
    }
    let now = now_ms();
    if parsed.issued_at_ms > now.saturating_add(MAX_CLOCK_SKEW_MS) {
        trap("deploy ticket issued_at is too far in the future");
    }
    if parsed.expires_at_ms <= parsed.issued_at_ms {
        trap("deploy ticket expiration is invalid");
    }
    if parsed.expires_at_ms.saturating_sub(parsed.issued_at_ms) > MAX_TICKET_LIFETIME_MS {
        trap("deploy ticket lifetime exceeds limit");
    }
    if parsed.expires_at_ms <= now {
        trap("deploy ticket expired");
    }

    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        prune_expired(&mut state, now);

        let key_bytes = state
            .verifier_keys
            .get(&parsed.key_id)
            .unwrap_or_else(|| trap("unknown deploy ticket verifier key"));

        verify_deploy_ticket_signature(&ticket, &signature, key_bytes);

        let replay_key = format!("{}:{}", parsed.deployment_id, parsed.nonce);
        if state.used_nonces.contains_key(&replay_key) {
            trap("deploy ticket replay detected");
        }
        state.used_nonces.insert(replay_key, parsed.expires_at_ms);

        let caller = msg_caller().to_text();
        clear_caller_sessions(&mut state, &caller);
        let session_key = build_session_key(&caller, &parsed.deployment_id);
        state.active_sessions.insert(
            session_key,
            DeploySession {
                slug: parsed.slug,
                deployment_id: parsed.deployment_id,
                project_id: parsed.project_id,
                host_canister_id: parsed.host_canister_id,
                key_id: parsed.key_id,
                nonce: parsed.nonce,
                expires_at_ms: parsed.expires_at_ms,
            },
        );
    });
}

#[ic_cdk::update]
#[candid_method(update)]
fn set_deploy_ticket_verifier(key_id: String, public_key: Vec<u8>) {
    assert_controller_only();
    let normalized_key_id = normalize_key_id(&key_id);
    if public_key.len() != 32 {
        trap("deploy ticket verifier public key must be 32 bytes");
    }
    STATE.with(|cell| {
        cell.borrow_mut()
            .verifier_keys
            .insert(normalized_key_id, public_key);
    });
}

#[ic_cdk::update]
#[candid_method(update)]
fn set_deploy_ticket_enforcement(enabled: bool) {
    assert_controller_only();
    STATE.with(|cell| {
        cell.borrow_mut().enforce_deploy_ticket = enabled;
    });
}

#[ic_cdk::query]
#[candid_method(query)]
fn get_deploy_ticket_state() -> DeployTicketStateView {
    assert_controller_only();
    STATE.with(|cell| {
        let state = cell.borrow();
        DeployTicketStateView {
            enforce_deploy_ticket: state.enforce_deploy_ticket,
            key_ids: state.verifier_keys.keys().cloned().collect(),
            active_sessions: state.active_sessions.len() as u64,
            replay_entries: state.used_nonces.len() as u64,
            batch_bindings: state
                .batch_slug_bindings
                .len()
                .max(state.batch_session_bindings.len()) as u64,
        }
    })
}

#[update]
fn create_batch() -> CreateBatchResponse {
    assert_uploader();
    let session = require_current_session_if_enforced();
    let response = ic_certified_assets::create_batch();
    if let Some((session_key, session)) = session {
        bind_batch_to_slug(&response.batch_id, &session.slug);
        bind_batch_to_session(&response.batch_id, &session_key);
    }
    response
}

#[update]
fn create_chunk(arg: CreateChunkArg) -> CreateChunkResponse {
    assert_uploader();
    if is_deploy_ticket_enforced() {
        assert_batch_ready_for_caller(&arg.batch_id);
    }
    ic_certified_assets::create_chunk(arg)
}

#[update]
fn create_chunks(arg: CreateChunksArg) -> CreateChunksResponse {
    assert_uploader();
    if is_deploy_ticket_enforced() {
        assert_batch_ready_for_caller(&arg.batch_id);
    }
    ic_certified_assets::create_chunks(arg)
}

#[update]
fn commit_batch(arg: CommitBatchArguments) {
    assert_uploader();
    let CommitBatchArguments {
        batch_id,
        operations,
    } = arg;
    let batch_id_for_binding = batch_id.clone();
    if is_deploy_ticket_enforced() {
        if operations.is_empty() {
            clear_batch_slug_binding(&batch_id_for_binding);
            clear_batch_session_binding(&batch_id_for_binding);
            return;
        }
        let (session_key, session) =
            resolve_session_for_batch_or_operations(&batch_id_for_binding, &operations);
        let batch_slug =
            ensure_batch_matches_or_bind(&batch_id_for_binding, &session.slug, &session_key);
        if batch_slug != session.slug {
            trap("deploy session slug does not match batch slug");
        }
        let filtered = filter_commit_operations_for_slug(operations, &batch_slug);
        if filtered.is_empty() {
            clear_batch_slug_binding(&batch_id_for_binding);
            clear_batch_session_binding(&batch_id_for_binding);
            return;
        }
        ic_certified_assets::commit_batch(CommitBatchArguments {
            batch_id,
            operations: filtered,
        });
        clear_batch_slug_binding(&batch_id_for_binding);
        clear_batch_session_binding(&batch_id_for_binding);
        return;
    }

    let filtered = filter_commit_operations(operations);
    if filtered.is_empty() {
        return;
    }
    ic_certified_assets::commit_batch(CommitBatchArguments {
        batch_id,
        operations: filtered,
    })
}

#[update]
fn set_asset_properties(arg: SetAssetPropertiesArguments) {
    assert_uploader();
    let key_slug = assert_key_allowed(&arg.key).to_string();
    if is_deploy_ticket_enforced() {
        let (_session_key, session) = require_session_for_slug(&key_slug);
        if key_slug != session.slug {
            trap("asset key slug does not match deploy session slug");
        }
    }
    ic_certified_assets::set_asset_properties(arg)
}

#[update]
fn authorize(principal: Principal) {
    assert_uploader();
    if !is_allowed_principal(principal) {
        trap("principal not allowed");
    }
}

#[update]
fn deauthorize(principal: Principal) {
    assert_uploader();
    if !is_allowed_principal(principal) {
        trap("principal not allowed");
    }
}

#[query]
fn list_authorized() -> Vec<Principal> {
    allowed_principals()
}

#[pre_upgrade]
fn pre_upgrade() {
    let deploy_ticket_state = STATE.with(|cell| cell.borrow().clone());
    let assets_state = ic_certified_assets::pre_upgrade();
    let assets_state_cbor = serde_cbor::to_vec(&assets_state).unwrap_or_else(|error| {
        trap(format!(
            "failed to serialize certified assets state: {error}"
        ))
    });
    let upgrade_state = UpgradeStableState {
        deploy_ticket_state,
        assets_state_cbor,
    };
    if let Err(error) = ic_cdk::storage::stable_save((upgrade_state,)) {
        trap(format!("failed to save canister upgrade state: {error}"));
    }
}

#[post_upgrade]
fn post_upgrade() {
    if let Ok((restored,)) = ic_cdk::storage::stable_restore::<(UpgradeStableState,)>() {
        STATE.with(|cell| {
            *cell.borrow_mut() = restored.deploy_ticket_state;
        });
        let assets_state: ic_certified_assets::StableStateV2 =
            serde_cbor::from_slice(&restored.assets_state_cbor).unwrap_or_else(|error| {
                trap(format!(
                    "failed to deserialize certified assets state from stable memory: {error}"
                ))
            });
        ic_certified_assets::post_upgrade(assets_state, None);
        return;
    }

    if let Ok((legacy_state,)) = ic_cdk::storage::stable_restore::<(StableState,)>() {
        STATE.with(|cell| {
            *cell.borrow_mut() = legacy_state;
        });
        // Legacy state did not persist certified assets; initialize asset subsystem.
        ic_certified_assets::init(None);
        return;
    }

    // Fresh install path where no stable state was found.
    ic_certified_assets::init(None);
}

fn bind_batch_to_slug(batch_id: &Nat, slug: &str) {
    let key = batch_binding_key(batch_id);
    STATE.with(|cell| {
        cell.borrow_mut()
            .batch_slug_bindings
            .insert(key, slug.to_string());
    });
}

fn bind_batch_to_session(batch_id: &Nat, session_key: &str) {
    let key = batch_binding_key(batch_id);
    STATE.with(|cell| {
        cell.borrow_mut()
            .batch_session_bindings
            .insert(key, session_key.to_string());
    });
}

fn clear_batch_slug_binding(batch_id: &Nat) {
    let key = batch_binding_key(batch_id);
    STATE.with(|cell| {
        cell.borrow_mut().batch_slug_bindings.remove(&key);
    });
}

fn clear_batch_session_binding(batch_id: &Nat) {
    let key = batch_binding_key(batch_id);
    STATE.with(|cell| {
        cell.borrow_mut().batch_session_bindings.remove(&key);
    });
}

fn ensure_batch_matches_or_bind(batch_id: &Nat, slug: &str, session_key: &str) -> String {
    let key = batch_binding_key(batch_id);
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        if let Some(existing) = state.batch_slug_bindings.get(&key).cloned() {
            if existing != slug {
                trap("batch belongs to a different deploy session slug");
            }
        } else {
            state
                .batch_slug_bindings
                .insert(key.clone(), slug.to_string());
        }
        if let Some(existing_session_key) = state.batch_session_bindings.get(&key).cloned() {
            if existing_session_key != session_key {
                trap("batch is bound to another deploy session");
            }
        } else {
            state
                .batch_session_bindings
                .insert(key.clone(), session_key.to_string());
        }
        state
            .batch_slug_bindings
            .get(&key)
            .cloned()
            .unwrap_or_else(|| trap("failed to bind deploy batch slug"))
    })
}

fn batch_binding_key(batch_id: &Nat) -> String {
    batch_id.to_string()
}

fn build_session_key(caller: &str, deployment_id: &str) -> String {
    format!("{caller}|{deployment_id}")
}

fn is_session_key_for_caller(session_key: &str, caller: &str) -> bool {
    if !session_key.starts_with(caller) {
        return false;
    }
    session_key
        .as_bytes()
        .get(caller.len())
        .map(|separator| *separator == b'|')
        .unwrap_or(false)
}

fn parse_deploy_ticket(ticket: &str) -> ParsedDeployTicket {
    let parts: Vec<&str> = ticket.split('|').collect();
    if parts.len() != 9 {
        trap("invalid deploy ticket format");
    }

    let version = parts[0];
    if version != DEPLOY_TICKET_VERSION {
        trap("unsupported deploy ticket version");
    }

    let key_id = normalize_key_id(parts[1]);
    let deployment_id = normalize_uuid_like("deployment_id", parts[2]);
    let project_id = normalize_uuid_like("project_id", parts[3]);
    let host_canister_id = normalize_host_canister_id(parts[4]);
    let slug = normalize_slug(parts[5]);
    let issued_at_ms = parse_timestamp("issued_at_ms", parts[6]);
    let expires_at_ms = parse_timestamp("expires_at_ms", parts[7]);
    let nonce = normalize_nonce(parts[8]);

    ParsedDeployTicket {
        key_id,
        deployment_id,
        project_id,
        host_canister_id,
        slug,
        issued_at_ms,
        expires_at_ms,
        nonce,
    }
}

fn normalize_key_id(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_KEY_ID_LEN {
        trap("invalid deploy ticket key id");
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        trap("invalid deploy ticket key id");
    }
    value.to_string()
}

fn normalize_nonce(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_NONCE_LEN {
        trap("invalid deploy ticket nonce");
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        trap("invalid deploy ticket nonce");
    }
    value.to_string()
}

fn normalize_host_canister_id(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_ID_FIELD_LEN {
        trap("invalid deploy ticket host canister id");
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        trap("invalid deploy ticket host canister id");
    }
    value.to_string()
}

fn normalize_uuid_like(field_name: &str, raw: &str) -> String {
    let value = raw.trim();
    if !is_uuid_like(value) {
        trap(format!("invalid deploy ticket field: {field_name}"));
    }
    value.to_string()
}

fn parse_timestamp(field_name: &str, raw: &str) -> u64 {
    raw.trim()
        .parse::<u64>()
        .unwrap_or_else(|_| trap(format!("invalid deploy ticket timestamp: {field_name}")))
}

fn verify_deploy_ticket_signature(ticket: &str, signature: &[u8], key: &[u8]) {
    let verifying_key_bytes: [u8; 32] = key
        .try_into()
        .unwrap_or_else(|_| trap("invalid verifier key length"));
    let signature_bytes: [u8; 64] = signature
        .try_into()
        .unwrap_or_else(|_| trap("invalid deploy ticket signature length"));
    let verifying_key = VerifyingKey::from_bytes(&verifying_key_bytes)
        .unwrap_or_else(|_| trap("invalid verifier key bytes"));
    let signature = Signature::from_bytes(&signature_bytes);
    verifying_key
        .verify(ticket.as_bytes(), &signature)
        .unwrap_or_else(|_| trap("deploy ticket signature verification failed"));
}

fn require_sessions_if_enforced() -> Option<Vec<(String, DeploySession)>> {
    if !is_deploy_ticket_enforced() {
        return None;
    }

    let now = now_ms();
    let caller = msg_caller().to_text();
    let sessions = STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        prune_expired(&mut state, now);
        let caller_sessions: Vec<(String, DeploySession)> = state
            .active_sessions
            .iter()
            .filter(|(session_key, _)| is_session_key_for_caller(session_key, &caller))
            .map(|(session_key, session)| (session_key.clone(), session.clone()))
            .collect();
        if caller_sessions.is_empty() {
            trap("missing active deploy session");
        }
        caller_sessions
    });
    Some(sessions)
}

fn require_session_for_slug(slug: &str) -> (String, DeploySession) {
    let sessions = require_sessions_if_enforced().unwrap_or_default();
    sessions
        .into_iter()
        .filter(|(_, session)| session.slug == slug)
        .max_by_key(|(_, session)| session.expires_at_ms)
        .unwrap_or_else(|| trap("missing active deploy session for tenant slug"))
}

fn assert_batch_ready_for_caller(batch_id: &Nat) {
    if !is_deploy_ticket_enforced() {
        return;
    }
    let caller = msg_caller().to_text();
    let now = now_ms();
    let batch_key = batch_binding_key(batch_id);
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        prune_expired(&mut state, now);
        let has_session_for_caller = state
            .active_sessions
            .iter()
            .any(|(session_key, _)| is_session_key_for_caller(session_key, &caller));
        if !has_session_for_caller {
            trap("missing active deploy session");
        }
        if let Some(session_key) = state.batch_session_bindings.get(&batch_key).cloned() {
            if !is_session_key_for_caller(&session_key, &caller) {
                trap("batch belongs to a different deploy caller");
            }
            if !state.active_sessions.contains_key(&session_key) {
                trap("batch is not bound to an active deploy session");
            }
        }
    });
}

fn resolve_session_for_batch_or_operations(
    batch_id: &Nat,
    _operations: &[BatchOperation],
) -> (String, DeploySession) {
    if let Some(bound_session) = get_active_bound_session_for_batch(batch_id) {
        return bound_session;
    }
    require_current_session_for_caller()
}

fn get_active_bound_session_for_batch(batch_id: &Nat) -> Option<(String, DeploySession)> {
    if !is_deploy_ticket_enforced() {
        return None;
    }
    let caller = msg_caller().to_text();
    let now = now_ms();
    let batch_key = batch_binding_key(batch_id);
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        prune_expired(&mut state, now);
        let session_key = state.batch_session_bindings.get(&batch_key)?.clone();
        if !is_session_key_for_caller(&session_key, &caller) {
            trap("batch belongs to a different deploy caller");
        }
        let session = state.active_sessions.get(&session_key)?.clone();
        Some((session_key, session))
    })
}

fn is_deploy_ticket_enforced() -> bool {
    STATE.with(|cell| cell.borrow().enforce_deploy_ticket)
}

fn clear_caller_sessions(state: &mut StableState, caller: &str) {
    let caller_prefix = format!("{}|", caller);
    if state
        .active_sessions
        .keys()
        .all(|session_key| !session_key.starts_with(&caller_prefix))
    {
        return;
    }

    state
        .active_sessions
        .retain(|session_key, _| !session_key.starts_with(&caller_prefix));
    state
        .batch_session_bindings
        .retain(|_, session_key| state.active_sessions.contains_key(session_key));
    state
        .batch_slug_bindings
        .retain(|batch_key, _| state.batch_session_bindings.contains_key(batch_key));
}

fn require_current_session_if_enforced() -> Option<(String, DeploySession)> {
    if !is_deploy_ticket_enforced() {
        return None;
    }
    Some(require_current_session_for_caller())
}

fn require_current_session_for_caller() -> (String, DeploySession) {
    let sessions = require_sessions_if_enforced().unwrap_or_default();
    sessions
        .into_iter()
        .max_by_key(|(_, session)| session.expires_at_ms)
        .unwrap_or_else(|| trap("missing active deploy session"))
}

fn prune_expired(state: &mut StableState, now_ms: u64) {
    state
        .active_sessions
        .retain(|_, session| session.expires_at_ms > now_ms);
    state
        .batch_session_bindings
        .retain(|_, session_key| state.active_sessions.contains_key(session_key));
    state
        .batch_slug_bindings
        .retain(|batch_key, _| state.batch_session_bindings.contains_key(batch_key));
    state
        .used_nonces
        .retain(|_, expires_at_ms| *expires_at_ms > now_ms);
}

fn is_valid_slug(slug: &str) -> bool {
    slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (idx, b) in bytes.iter().enumerate() {
        if [8, 13, 18, 23].contains(&idx) {
            if *b != b'-' {
                return false;
            }
            continue;
        }
        if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn now_ms() -> u64 {
    time() / 1_000_000
}

fn assert_uploader() {
    if !is_allowed_principal(msg_caller()) {
        trap("unauthorized uploader");
    }
}

fn assert_controller_only() {
    let caller = msg_caller();
    if !is_controller(&caller) {
        trap("controller only");
    }
}

fn allowed_principals() -> Vec<Principal> {
    ALLOWED_UPLOADER_TEXT
        .map(|text| {
            vec![Principal::from_text(text)
                .unwrap_or_else(|_| trap("invalid configured uploader principal"))]
        })
        .unwrap_or_default()
}

fn is_allowed_principal(principal: Principal) -> bool {
    allowed_principals().contains(&principal)
}

fn filter_commit_operations(operations: Vec<BatchOperation>) -> Vec<BatchOperation> {
    let primary_slug = select_primary_slug(&operations);
    let mut filtered = Vec::new();

    for op in operations {
        let key = match &op {
            BatchOperation::CreateAsset(arg) => &arg.key,
            BatchOperation::SetAssetContent(arg) => &arg.key,
            BatchOperation::UnsetAssetContent(arg) => &arg.key,
            BatchOperation::DeleteAsset(arg) => &arg.key,
            BatchOperation::SetAssetProperties(arg) => &arg.key,
            BatchOperation::Clear(_) => continue,
        };

        let slug = assert_key_allowed(key);
        if let Some(primary) = primary_slug.as_deref() {
            if slug != primary {
                continue;
            }
        } else if matches!(op, BatchOperation::DeleteAsset(_)) {
            continue;
        }

        filtered.push(op);
    }

    filtered
}

fn filter_commit_operations_for_slug(
    operations: Vec<BatchOperation>,
    expected_slug: &str,
) -> Vec<BatchOperation> {
    let mut filtered = Vec::new();
    for op in operations {
        let key = match &op {
            BatchOperation::CreateAsset(arg) => Some(&arg.key),
            BatchOperation::SetAssetContent(arg) => Some(&arg.key),
            BatchOperation::UnsetAssetContent(arg) => Some(&arg.key),
            BatchOperation::DeleteAsset(arg) => Some(&arg.key),
            BatchOperation::SetAssetProperties(arg) => Some(&arg.key),
            BatchOperation::Clear(_) => None,
        };

        if let Some(key) = key {
            let slug = assert_key_allowed(key);
            if slug != expected_slug {
                continue;
            }
            filtered.push(op);
        }
    }
    filtered
}

fn select_primary_slug(operations: &[BatchOperation]) -> Option<String> {
    let mut counts = std::collections::BTreeMap::<String, usize>::new();

    for op in operations {
        let key = match op {
            BatchOperation::CreateAsset(arg) => Some(&arg.key),
            BatchOperation::SetAssetContent(arg) => Some(&arg.key),
            BatchOperation::UnsetAssetContent(arg) => Some(&arg.key),
            BatchOperation::SetAssetProperties(arg) => Some(&arg.key),
            BatchOperation::DeleteAsset(_) | BatchOperation::Clear(_) => None,
        };

        if let Some(key) = key {
            let slug = assert_key_allowed(key).to_string();
            *counts.entry(slug).or_insert(0) += 1;
        }
    }

    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(slug, _)| slug)
}

fn normalize_slug(raw: &str) -> String {
    let slug = raw.trim().to_lowercase();
    if slug.is_empty() {
        trap("empty deploy ticket slug");
    }
    if !is_valid_slug(&slug) {
        trap("invalid tenant slug");
    }
    slug
}

fn assert_key_allowed(key: &str) -> &str {
    let key = key.trim();
    if !key.starts_with('/') {
        trap("asset key must start with '/'");
    }

    const TENANT_PREFIX: &str = "/__tenant/";
    if !key.starts_with(TENANT_PREFIX) {
        trap("asset key must start with /__tenant/");
    }

    let trimmed = &key[TENANT_PREFIX.len()..];
    let (slug, rest) = trimmed.split_once('/').unwrap_or(("", ""));

    if slug.is_empty() || rest.is_empty() {
        trap("asset key must be /__tenant/<slug>/<path>");
    }
    if !is_valid_slug(slug) {
        trap("invalid tenant slug");
    }

    slug
}

ic_cdk::export_candid!();
