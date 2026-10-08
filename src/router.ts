import { createRouter, createWebHistory } from "vue-router";
import { admin } from "./store";

const routes = [
  { path: "/", redirect: "/dashboard" },
  { path: "/login", name: "login", component: () => import("./views/LoginView.vue"), meta: { public: true, bare: true } },
  { path: "/dashboard", name: "dashboard", component: () => import("./views/DashboardView.vue") },
  { path: "/tenants", name: "tenants", component: () => import("./views/TenantsView.vue") },
  { path: "/plans", name: "plans", component: () => import("./views/PlansView.vue") },
  { path: "/users", name: "users", component: () => import("./views/UsersView.vue") },
  { path: "/audit", name: "audit", component: () => import("./views/AuditView.vue") },
  { path: "/relays", name: "relays", component: () => import("./views/RelaysView.vue") },
  { path: "/system", name: "system", component: () => import("./views/SystemView.vue") },
  { path: "/:pathMatch(.*)*", name: "not-found", component: () => import("./views/NotFoundView.vue") },
];

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.beforeEach((to) => {
  if (to.meta.public) return true;
  if (!admin.authenticated) return { name: "login", query: { return_to: to.fullPath } };
  return true;
});
