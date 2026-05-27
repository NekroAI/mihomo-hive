import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import { QueryClient } from "@tanstack/react-query";
import type { AppRouter } from "../../../server/src/router.js";

export const trpc = createTRPCReact<AppRouter>();

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1
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
