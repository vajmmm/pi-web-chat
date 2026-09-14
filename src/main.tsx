import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatPage } from "./components/ChatPage";
import { initLocale } from "./lib/i18n";
import { initTheme } from "./lib/theme";
import { initViewportLock } from "./lib/viewport";
import "./styles.css";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ChatPage,
});

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$sessionId",
  component: ChatPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([chatRoute, sessionRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// 开发服务器重启后，注销此前由生产构建注册的 Service Worker，避免
// localhost 继续使用缓存的旧页面并在点击懒加载入口时请求不存在的源模块。
if (import.meta.env.DEV && "serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      void registration.unregister();
    }
  });
}

// 生产部署淘汰旧 hash chunk 时，刷新页面恢复动态 import，而不是让整个路由树进入错误页。
if (import.meta.env.PROD) {
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    window.location.reload();
  });
}

const queryClient = new QueryClient();

initViewportLock();
initTheme();
initLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
