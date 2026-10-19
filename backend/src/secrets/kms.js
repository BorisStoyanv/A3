import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const provider = (process.env.ENV_VARS_ENCRYPTION_PROVIDER || "").trim().toLowerCase();
const keyName = (process.env.ENV_VARS_KMS_KEY_NAME || "").trim();
const isProd = process.env.NODE_ENV === "production";
const masterKeyRaw = (process.env.ENV_VARS_MASTER_KEY || "").trim();
const masterKeyVersion = (process.env.ENV_VARS_MASTER_KEY_VERSION || "v1").trim();

const LOCAL_PREFIX = "local:v1:";

let kmsClient = null;
let kmsClientClass = null;
let localMasterKey = null;

function buildAad(aadContext = {}) {
  const projectId = String(aadContext.projectId || "");
  const key = String(aadContext.key || "");
  return Buffer.from(`${projectId}:${key}`, "utf8");
}

function decodeMasterKey(raw) {
  if (!raw) return null;
  // Allow either base64 (preferred) or 64-char hex.
  const hexLike = /^[0-9a-fA-F]{64}$/.test(raw);
  if (hexLike) {
    return Buffer.from(raw, "hex");
  }
  try {
    return Buffer.from(raw, "base64");
  } catch {
    return null;
  }
}

function ensureLocalMasterKey() {
  if (!localMasterKey) {
    localMasterKey = decodeMasterKey(masterKeyRaw);
  }
  if (!localMasterKey || localMasterKey.length !== 32) {
    throw new Error(
      "Local env encryption key is invalid. Set ENV_VARS_MASTER_KEY to a 32-byte base64 or hex key.",
    );
  }
  return localMasterKey;
}

async function getKmsClient() {
  if (!kmsClientClass) {
    const mod = await import("@google-cloud/kms");
    kmsClientClass = mod.KeyManagementServiceClient;
  }
  if (!kmsClient) {
    kmsClient = new kmsClientClass();
  }
  return kmsClient;
}

function ensureConfigured() {
  if (provider === "gcp_kms" && keyName) return;
  if (provider === "local_encrypted" && decodeMasterKey(masterKeyRaw)?.length === 32) return;
  if (isProd) {
    throw new Error(
      "Env vars encryption is not configured. Use ENV_VARS_ENCRYPTION_PROVIDER=local_encrypted with ENV_VARS_MASTER_KEY, or gcp_kms with ENV_VARS_KMS_KEY_NAME.",
    );
  }
  throw new Error("Env vars encryption is not configured.");
}

function encryptLocal(plaintext, aadContext) {
  const key = ensureLocalMasterKey();
  const iv = randomBytes(12);
  const aad = buildAad(aadContext);
  // Derive a context-bound key for each project/key pair.
  const derivedKey = createHash("sha256").update(key).update(aad).digest();
  const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext ?? ""), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = {
    kv: masterKeyVersion,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ciphertext.toString("base64"),
  };
  return `${LOCAL_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`;
}

function decryptLocal(encoded, aadContext) {
  const key = ensureLocalMasterKey();
  const raw = String(encoded || "");
  if (!raw.startsWith(LOCAL_PREFIX)) {
    throw new Error("Secret is not in local encrypted format.");
  }
  const payloadJson = Buffer.from(raw.slice(LOCAL_PREFIX.length), "base64").toString("utf8");
  const payload = JSON.parse(payloadJson);
  const iv = Buffer.from(String(payload.iv || ""), "base64");
  const tag = Buffer.from(String(payload.tag || ""), "base64");
  const ct = Buffer.from(String(payload.ct || ""), "base64");
  const aad = buildAad(aadContext);
  const derivedKey = createHash("sha256").update(key).update(aad).digest();
  const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}

export function getEnvVarsKmsKeyName() {
  if (provider === "gcp_kms") return keyName;
  if (provider === "local_encrypted") return `local:${masterKeyVersion || "v1"}`;
  return "";
}

export function isEnvVarsKmsConfigured() {
  if (provider === "gcp_kms") return Boolean(keyName);
  if (provider === "local_encrypted") return decodeMasterKey(masterKeyRaw)?.length === 32;
  return false;
}

export async function encryptSecret(plaintext, aadContext) {
  ensureConfigured();
  if (provider === "local_encrypted") {
    return encryptLocal(plaintext, aadContext);
  }
  if (provider === "gcp_kms") {
    const kms = await getKmsClient();
    const [result] = await kms.encrypt({
      name: keyName,
      plaintext: Buffer.from(String(plaintext ?? ""), "utf8"),
      additionalAuthenticatedData: buildAad(aadContext),
    });
    if (!result?.ciphertext) {
      throw new Error("KMS returned empty ciphertext.");
    }
    return Buffer.from(result.ciphertext).toString("base64");
  }
  throw new Error(`Unsupported env encryption provider "${provider}".`);
}

export async function decryptSecret(ciphertextValue, aadContext) {
  const value = String(ciphertextValue || "");
  if (value.startsWith(LOCAL_PREFIX)) {
    return decryptLocal(value, aadContext);
  }
  ensureConfigured();
  if (provider === "gcp_kms") {
    const kms = await getKmsClient();
    const [result] = await kms.decrypt({
      name: keyName,
      ciphertext: Buffer.from(value, "base64"),
      additionalAuthenticatedData: buildAad(aadContext),
    });
    if (!result?.plaintext) {
      throw new Error("KMS returned empty plaintext.");
    }
    return Buffer.from(result.plaintext).toString("utf8");
  }
  if (provider === "local_encrypted") {
    throw new Error(
      "Secret was not written with local_encrypted format. Re-save this variable after switching providers.",
    );
  }
  throw new Error(`Unsupported env encryption provider "${provider}".`);
}
