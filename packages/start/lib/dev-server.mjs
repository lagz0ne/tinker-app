import main from "#tinker/server-main";

let started;

const close = async () => {
  if (started) await (await started).close();
};

if (import.meta.hot) {
  import.meta.hot.dispose(close);
  import.meta.hot.on("vite:beforeFullReload", close);
}

export default {
  fetch: async (request) =>
    (
      await (started ??= main().catch((error) => {
        started = undefined;
        throw error;
      }))
    ).fetch(request),
};
