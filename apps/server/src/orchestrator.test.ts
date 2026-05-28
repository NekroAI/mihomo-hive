import { describe, expect, it } from "vitest";
import { isNodeSideError } from "./orchestrator.js";

describe("isNodeSideError 健康信号过滤（P5-V）", () => {
  describe("算节点的锅（计入 errorsInWindow）", () => {
    it.each<[number | null | undefined, string]>([
      [null, "EOF / 无 status"],
      [undefined, "缺字段"],
      [0, "连接断开"],
      [408, "请求超时"],
      [500, "上游 5xx"],
      [502, "OpenAI 自身 502 也归节点 — 不同地区路由可能避开"],
      [503, "上游 service unavailable"],
      [504, "上游 gateway timeout"],
      [522, "Cloudflare 类 5xx"]
    ])("status_code=%s (%s) → 算", (status_code) => {
      expect(isNodeSideError({ status_code })).toBe(true);
    });
  });

  describe("不算节点的锅（账号 / 客户端侧问题）", () => {
    it.each<[number, string]>([
      [400, "请求参数错（客户端 bug）"],
      [401, "OAuth token 失效（账号）"],
      [403, "权限拒绝（账号）"],
      [404, "路径错（客户端 bug）"],
      [429, "配额耗尽（账号）"]
    ])("status_code=%s (%s) → 跳过", (status_code) => {
      expect(isNodeSideError({ status_code })).toBe(false);
    });
  });

  describe("边界", () => {
    it("status_code 是字符串等异常类型 → 算（schema 兼容性）", () => {
      expect(isNodeSideError({ status_code: "weird" as unknown as number })).toBe(true);
    });
    it("204 这种 2xx 不在白名单也不在黑名单 → 不算（不是错误就不该出现，但偏稳）", () => {
      // 实际上 listUpstreamErrors 不会返回 2xx，但函数对未知 code 默认偏保守不算
      expect(isNodeSideError({ status_code: 204 })).toBe(false);
    });
    it("3xx 也不算节点（重定向不是错误）", () => {
      expect(isNodeSideError({ status_code: 301 })).toBe(false);
    });
  });
});
