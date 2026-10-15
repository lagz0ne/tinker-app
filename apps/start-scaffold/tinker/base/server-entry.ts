import {
  createStartHandler as createStart,
  defaultStreamHandler as renderStream,
} from "@tanstack/react-start/server";
import type { Scope } from "@tinker/core";

import { raise } from "~/components/errors";
import { renderFrames } from "~/components/requests/index.server";

import { devErrorPage } from "./panics";
import type { createRouterEntry } from "./router-entry";

/** The command retains both roots; Start borrows context and observation. */
export declare namespace ServerEntry {
  type Next = (request: Request) => Promise<Response>;
  type Handle = {
    requestContext: { scope: Scope.Handle };
    close(): Promise<void>;
    fetch?(request: Request, next: Next): Promise<Response> | Response;
  };
}

/** Render over the supplied app; request bodies retain each render's close. */
export function createServerHandler(app: ServerEntry.Handle, { dev }: { dev: boolean }) {
  const renderRequest = createStart(async (context) => {
    const router: typeof context.router & {
      close?: Awaited<ReturnType<ReturnType<typeof createRouterEntry>>>["close"];
    } = context.router;
    if (typeof router.close !== "function") raise("StartScopeMissing", {});
    app.requestContext.scope.resolve(renderFrames).retain(context.request, router.close);

    try {
      return await renderStream(context);
    } catch (error) {
      await router.close();
      throw error;
    }
  });

  return {
    ...app,
    fetch(request: Request) {
      const next = async (forwarded: Request) => {
        const response = await renderRequest(forwarded, { context: app.requestContext });
        return dev ? devErrorPage(forwarded, response) : response;
      };
      return app.fetch ? app.fetch(request, next) : next(request);
    },
  };
}
