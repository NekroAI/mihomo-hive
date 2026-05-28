import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AccountCryptoConfigError,
  AccountDecryptError,
  createAccountCryptoFromKey,
  loadAccountCrypto
} from "./account-crypto.js";

function randomKey(): Buffer {
  return randomBytes(32);
}

describe("account-crypto", () => {
  describe("loadAccountCrypto", () => {
    it("throws when env is missing", () => {
      expect(() => loadAccountCrypto({}, "TEST_KEY")).toThrow(AccountCryptoConfigError);
    });

    it("throws when env is wrong length", () => {
      expect(() =>
        loadAccountCrypto({ TEST_KEY: Buffer.alloc(16).toString("base64") }, "TEST_KEY")
      ).toThrow(/must decode to 32 bytes/);
    });

    it("loads valid 32-byte base64 key", () => {
      const env = { TEST_KEY: randomKey().toString("base64") };
      const crypto = loadAccountCrypto(env, "TEST_KEY");
      const ct = crypto.encrypt("hello");
      expect(crypto.decrypt(ct)).toBe("hello");
    });
  });

  describe("round-trip", () => {
    const crypto = createAccountCryptoFromKey(randomKey());

    it("encrypts and decrypts ASCII strings", () => {
      const ct = crypto.encrypt("+1234567890");
      expect(ct).toContain("v1:");
      expect(ct.split(":")).toHaveLength(4);
      expect(crypto.decrypt(ct)).toBe("+1234567890");
    });

    it("handles long token-like payloads", () => {
      const long = "eyJ" + "A".repeat(1024);
      expect(crypto.decrypt(crypto.encrypt(long))).toBe(long);
    });

    it("handles unicode (Chinese)", () => {
      const text = "中文密码 你好世界 🎉";
      expect(crypto.decrypt(crypto.encrypt(text))).toBe(text);
    });

    it("encrypt produces different ciphertext for same plaintext (IV randomness)", () => {
      const a = crypto.encrypt("same");
      const b = crypto.encrypt("same");
      expect(a).not.toBe(b);
      expect(crypto.decrypt(a)).toBe("same");
      expect(crypto.decrypt(b)).toBe("same");
    });
  });

  describe("empty string short-circuit", () => {
    const crypto = createAccountCryptoFromKey(randomKey());

    it("encrypt('') returns ''", () => {
      expect(crypto.encrypt("")).toBe("");
    });

    it("decrypt('') returns ''", () => {
      expect(crypto.decrypt("")).toBe("");
    });
  });

  describe("optional variants", () => {
    const crypto = createAccountCryptoFromKey(randomKey());

    it("encryptOptional handles null/undefined", () => {
      expect(crypto.encryptOptional(null)).toBeNull();
      expect(crypto.encryptOptional(undefined)).toBeNull();
    });

    it("encryptOptional handles '' as ''", () => {
      expect(crypto.encryptOptional("")).toBe("");
    });

    it("decryptOptional round-trip with null/value", () => {
      expect(crypto.decryptOptional(null)).toBeNull();
      const ct = crypto.encryptOptional("secret");
      expect(crypto.decryptOptional(ct)).toBe("secret");
    });
  });

  describe("failure modes", () => {
    const crypto = createAccountCryptoFromKey(randomKey());

    it("rejects ciphertext with wrong version prefix", () => {
      expect(() => crypto.decrypt("v2:aaa:bbb:ccc")).toThrow(AccountDecryptError);
    });

    it("rejects malformed ciphertext (wrong part count)", () => {
      expect(() => crypto.decrypt("v1:onlyiv:onlytag")).toThrow(/4 parts/);
    });

    it("decrypts fail with wrong key", () => {
      const other = createAccountCryptoFromKey(randomKey());
      const ct = crypto.encrypt("payload");
      expect(() => other.decrypt(ct)).toThrow(AccountDecryptError);
    });

    it("detects tampered ciphertext", () => {
      const ct = crypto.encrypt("payload");
      const parts = ct.split(":");
      const ctPart = parts[3];
      if (!ctPart) throw new Error("expected 4-part ciphertext");
      // 篡改密文块（base64 末尾换一个字节）
      const tampered = Buffer.from(ctPart, "base64");
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;
      parts[3] = tampered.toString("base64");
      expect(() => crypto.decrypt(parts.join(":"))).toThrow(AccountDecryptError);
    });

    it("createAccountCryptoFromKey rejects wrong-length key", () => {
      expect(() => createAccountCryptoFromKey(Buffer.alloc(16))).toThrow(AccountCryptoConfigError);
    });
  });
});
