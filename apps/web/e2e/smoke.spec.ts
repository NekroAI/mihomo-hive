import { expect, test } from "@playwright/test";

test.describe("Mihomo Hive 首次访问 + 主导航", () => {
  test("首次访问设密码、登录后 3 个 workspace tab 可切换", async ({ page }) => {
    await page.goto("/");

    // 首次访问应当展示"设置访问密码"
    await expect(page.getByRole("heading", { name: "设置访问密码" })).toBeVisible();

    const passwordFields = page.locator("input[type='password']");
    await passwordFields.nth(0).fill("e2e-test-pass-1234");
    await passwordFields.nth(1).fill("e2e-test-pass-1234");
    await page.getByRole("button", { name: "设置并进入" }).click();

    // 进入 dashboard，3 个 workspace tab 都出现
    const nav = page.getByRole("navigation", { name: "工作区" });
    await expect(nav.getByRole("button", { name: "节点池" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "自动化" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "高级运维" })).toBeVisible();

    // 默认在节点池：能看到导入订阅表单 + 节点池操作栏
    await expect(page.getByRole("heading", { name: "导入订阅" })).toBeVisible();
    await expect(page.getByRole("button", { name: "仅保存订阅源" })).toBeVisible();
    await expect(page.getByRole("button", { name: "拉取并预览" })).toBeVisible();
    await expect(page.getByRole("button", { name: "测试节点池" })).toBeVisible();
    await expect(page.getByRole("button", { name: "发布出口池" })).toBeVisible();

    // 切到自动化：连接配置、自动接管状态、任务流 都在同一页
    await nav.getByRole("button", { name: "自动化" }).click();
    await expect(page.getByRole("heading", { name: "连接配置" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "自动接管状态" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "任务流" })).toBeVisible();
    await expect(page.getByText("待配置")).toBeVisible();

    // 切到高级运维：能看到 Mihomo 运行控制 + 导出篮子
    await nav.getByRole("button", { name: "高级运维" }).click();
    await expect(page.getByRole("heading", { name: "Mihomo 运行控制" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "导出篮子" })).toBeVisible();

    // 回到节点池
    await nav.getByRole("button", { name: "节点池" }).click();
    await expect(page.getByRole("heading", { name: "导入订阅" })).toBeVisible();
  });

  test("点击拉取并预览需要先填 URL", async ({ page }) => {
    await page.goto("/");
    // 已存在密码，进入登录
    await expect(page.getByRole("heading", { name: "登录 Mihomo Hive" })).toBeVisible();
    await page.locator("input[type='password']").fill("e2e-test-pass-1234");
    await page.getByRole("button", { name: "登录" }).click();

    // 拉取并预览按钮默认 disabled
    const previewButton = page.getByRole("button", { name: "拉取并预览" });
    await expect(previewButton).toBeDisabled();
    const saveButton = page.getByRole("button", { name: "仅保存订阅源" });
    await expect(saveButton).toBeDisabled();
  });
});
