import { resource } from "@tinker/core";
import type { Scope } from "@tinker/core";

import { asyncHooks } from "./modules";

/** Keep overlapping calls separate; a detached callback cannot reuse a finished flow. */
export const authCalls = resource({
  label: "auth.calls",
  depends: { hooks: asyncHooks },
  factory: async ({ hooks }, { defer }) => {
    const calls = new hooks.AsyncLocalStorage<Scope.ExtensionCtx>();
    defer(() => calls.disable());
    const live = new WeakSet<Scope.ExtensionCtx>();
    return {
      fire<T, R>(
        hook: (input: T, context: Scope.ExtensionCtx) => R,
        input: T,
        outside: Scope.ExtensionCtx,
      ): R {
        const context = calls.getStore();
        return hook(input, context && live.has(context) ? context : outside);
      },
      run(context: Scope.ExtensionCtx, next: () => unknown) {
        live.add(context);
        return calls.run(context, () => {
          try {
            const result = next();
            if (result instanceof Promise) return result.finally(() => live.delete(context));
            live.delete(context);
            return result;
          } catch (error) {
            live.delete(context);
            throw error;
          }
        });
      },
    };
  },
});
