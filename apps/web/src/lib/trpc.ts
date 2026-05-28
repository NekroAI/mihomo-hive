import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import { QueryClient } from "@tanstack/react-query";
import type { AppRouter } from "../../../server/src/router.js";

export const trpc = createTRPCReact<AppRouter>();

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      // 默认 30s 内视为新鲜：切 workspace tab / 重挂组件不会立即重 fetch、
      // 也不会因为 data 短暂为 undefined 而误显示"未配置"假阳性。
      // 真正需要实时刷新的 query 用自己的 refetchInterval 覆盖（statusSnapshot 5s / jobs 3s 等）。
      staleTime: 30_000
    }
  }
});

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/trpc"
    })
  ]
});
