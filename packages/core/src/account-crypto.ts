/**
 * Account Fleet 凭据加密 —— AES-256-GCM。
 *
 * 用于 accounts 表的 enc_* 字段（phone / password / refresh_token / access_token / id_token /
 * recovery_input_json）以及 settings 表里的 codex-tool 敏感配置（SMS API key / skymail
 * admin password）。
 *
 * 密钥来源：环境变量 `HIVE_ACCOUNT_KEY`，必须是 base64 编码的 32 字节随机串。
 *   生成方式：`openssl rand -base64 32`
 *
 * 落库格式（紧凑、易解析）：
 *   `v1:<base64(iv,12B)>:<base64(authTag,16B)>:<base64(ciphertext)>`
 *
 * 版本前缀 `v1:` 留给将来 key rotation 用。当前只支持 v1。
 *
 * 故障模式：
 *   - 缺 env → loadAccountCrypto() 抛错（server 启动失败，明示用户配置）
 *   - 解密失败（key 不对 / 数据损坏）→ decrypt() 抛 AccountDecryptError
 *
 * 单元测试覆盖：encrypt + decrypt round-trip / wrong key / tampered ciphertext / 空串
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class AccountCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountCryptoConfigError";
  }
}

export class AccountDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountDecryptError";
  }
}

export interface AccountCrypto {
  /** 加密明文字符串。空串返回空串（避免 null/'' 都要区分）。 */
  encrypt(plaintext: string): string;
  /** 解密。空串原样返回。格式或 key 错误 → 抛 AccountDecryptError。 */
  decrypt(ciphertext: string): string;
  /** 给 enc 字段用的安全 wrapper：null → null，'' → ''，否则 encrypt。 */
  encryptOptional(value: string | null | undefined): string | null;
  /** 与上面对偶：null → null，'' → ''，否则 decrypt。 */
  decryptOptional(value: string | null | undefined): string | null;
}

/**
 * 从 env 加载加密器。
 *
 * @param env 一般传 process.env，测试时可传 mock 对象
 * @param keyEnvName 默认 "HIVE_ACCOUNT_KEY"
 */
export function loadAccountCrypto(
  env: NodeJS.ProcessEnv = process.env,
  keyEnvName = "HIVE_ACCOUNT_KEY"
): AccountCrypto {
  const raw = env[keyEnvName];
  if (!raw || raw.length === 0) {
    throw new AccountCryptoConfigError(
      `Missing env ${keyEnvName}; generate with: openssl rand -base64 32`
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch (cause) {
    throw new AccountCryptoConfigError(
      `${keyEnvName} must be base64-encoded; ${(cause as Error).message}`
    );
  }
  if (key.length !== KEY_LENGTH) {
    throw new AccountCryptoConfigError(
      `${keyEnvName} must decode to ${KEY_LENGTH} bytes (got ${key.length}); generate with: openssl rand -base64 32`
    );
  }
  return createAccountCryptoFromKey(key);
}

/**
 * 直接用一个 32 字节 key 构造加密器。测试用，或上层已经有解码后的 key。
 */
export function createAccountCryptoFromKey(key: Buffer): AccountCrypto {
  if (key.length !== KEY_LENGTH) {
    throw new AccountCryptoConfigError(`Account key must be ${KEY_LENGTH} bytes (got ${key.length})`);
  }
  const frozenKey = Buffer.from(key); // defensive copy

  function encrypt(plaintext: string): string {
    if (plaintext.length === 0) {
      return "";
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, frozenKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64"),
      tag.toString("base64"),
      ciphertext.toString("base64")
    ].join(":");
  }

  function decrypt(input: string): string {
    if (input.length === 0) {
      return "";
    }
    const parts = input.split(":");
    if (parts.length !== 4) {
      throw new AccountDecryptError(`Malformed ciphertext: expected 4 parts, got ${parts.length}`);
    }
    const version = parts[0] ?? "";
    const ivB64 = parts[1] ?? "";
    const tagB64 = parts[2] ?? "";
    const ctB64 = parts[3] ?? "";
    if (version !== VERSION) {
      throw new AccountDecryptError(`Unsupported ciphertext version: ${version}`);
    }
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ciphertext = Buffer.from(ctB64, "base64");
    if (iv.length !== IV_LENGTH) {
      throw new AccountDecryptError(`Invalid IV length: ${iv.length}`);
    }
    if (tag.length !== TAG_LENGTH) {
      throw new AccountDecryptError(`Invalid auth tag length: ${tag.length}`);
    }
    const decipher = createDecipheriv(ALGORITHM, frozenKey, iv);
    decipher.setAuthTag(tag);
    try {
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString("utf8");
    } catch (cause) {
      throw new AccountDecryptError(
        `Decryption failed (wrong key or tampered data): ${(cause as Error).message}`
      );
    }
  }

  return {
    encrypt,
    decrypt,
    encryptOptional(value) {
      if (value === null || value === undefined) return null;
      return encrypt(value);
    },
    decryptOptional(value) {
      if (value === null || value === undefined) return null;
      return decrypt(value);
    }
  };
}

/**
 * 测试 / 占位用：用一个零 key 构造加密器。**绝对不要在生产用**。
 * 仅用于不需要加密的单测路径（例如 db 层 round-trip 测试不关心密钥强度）。
 */
export function createInsecureZeroAccountCrypto(): AccountCrypto {
  return createAccountCryptoFromKey(Buffer.alloc(KEY_LENGTH, 0));
}
