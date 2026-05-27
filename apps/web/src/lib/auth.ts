export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const response = await fetch("/api/auth/status", { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error("无法读取登录状态");
  }
  return (await response.json()) as AuthStatus;
}

export async function submitPasswordAuth(input: {
  configured: boolean;
  password: string;
}): Promise<void> {
  const endpoint = input.configured ? "/api/auth/login" : "/api/auth/setup";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ password: input.password })
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "认证失败");
  }
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}
