import { useResource } from "@tinker/react";

import { authClient } from "./auth-actions";

/** Better Auth owns its mounted session checks and explicit refresh POSTs. */
export function AuthSession() {
  const client = useResource(authClient);
  client.useSession();
  return <></>;
}
