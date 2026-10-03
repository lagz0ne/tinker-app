import { extension } from "@tinker/core";
import { migrate } from "@/lib/tinker.server";
export const setup = extension({
  label: "backend.setup",
  hooks: {
    async start(event) {
      await event.next();
      await event.scope.run(migrate);
    },
  },
});
