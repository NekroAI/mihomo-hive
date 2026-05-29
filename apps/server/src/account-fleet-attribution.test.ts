import { describe, expect, it } from "vitest";
import { classifyCodexFailure, describeRegistrationFailure } from "./account-fleet-worker.js";

describe("describeRegistrationFailure (P5-AX)", () => {
  it("'timeouts'（取到号收不到验证码）→ 地区不可用", () => {
    const r = describeRegistrationFailure("'timeouts'", 3);
    expect(r).toContain("地区不可用");
    expect(r).toContain("3");
  });

  it("NO_NUMBERS（取不到号）→ 地区不可用", () => {
    expect(describeRegistrationFailure("HeroSMS NO_NUMBERS 没有可用号码", 5)).toContain("地区不可用");
  });

  it("余额不足 → 接码平台余额不足", () => {
    expect(describeRegistrationFailure("insufficient balance 余额不足", 0)).toContain("余额不足");
  });

  it("未知错误 → 原样带出但标注册失败", () => {
    expect(describeRegistrationFailure("weird thing", 0)).toContain("weird thing");
  });
});

describe("classifyCodexFailure region markers (P5-AX)", () => {
  it("地区不可用 → network_or_proxy（瞬时可重试，不退役账号）", () => {
    expect(classifyCodexFailure("地区不可用（取不到号或收不到验证码）")).toBe("network_or_proxy");
    expect(classifyCodexFailure("NO_NUMBERS 没有可用号码")).toBe("network_or_proxy");
  });

  it("缺少目标 URL → account_unusable", () => {
    expect(classifyCodexFailure("跟随 OAuth 跳转失败：缺少目标 URL")).toBe("account_unusable");
  });

  it("sentinel/超时 → network_or_proxy", () => {
    expect(classifyCodexFailure("sentinel 提取失败")).toBe("network_or_proxy");
    expect(classifyCodexFailure("curl timed out")).toBe("network_or_proxy");
  });
});
