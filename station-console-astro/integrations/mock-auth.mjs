import { fileURLToPath } from "node:url";

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/**
 * Local stand-in for @workos/authkit-astro: a signed cookie-less "session"
 * identified by a plain cookie. Development and tests only.
 */
export function mockAuth() {
  return {
    name: "mukoko-station-console-mock-auth",
    hooks: {
      "astro:config:setup": ({ addMiddleware, injectRoute }) => {
        if (process.env.WORKERS_CI || process.env.CF_PAGES) {
          throw new Error("AUTH_MODE=mock is not allowed on a hosted build.");
        }
        addMiddleware({
          entrypoint: at("../src/auth/mock-middleware.ts"),
          order: "pre",
        });
        injectRoute({
          pattern: "/auth/signin",
          entrypoint: at("../src/auth/mock-signin.ts"),
        });
        injectRoute({
          pattern: "/auth/logout",
          entrypoint: at("../src/auth/mock-logout.ts"),
        });
      },
    },
  };
}
