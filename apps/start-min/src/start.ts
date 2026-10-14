import { createStart } from "@tanstack/react-start";

/** The command reads this app-owned Start setup; keep it even when options are empty. */
export const startInstance = createStart(() => ({}));
