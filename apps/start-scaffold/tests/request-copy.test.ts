import { startRequests as packageRequests } from "@tinker/start";
import { startRequests as serverRequests } from "@tinker/start/server";
import {
  startRequests as testingRequests,
  requestHeaders as packageHeaders,
  retainRender as packageRender,
} from "@tinker/start/testing";
import { expect, test } from "vite-plus/test";

import { startRequests } from "~/components/requests";
import { retainRender, requestHeaders } from "~/components/requests/index.server";

test("package compatibility exports share the copied request middleware and state", () => {
  for (const requests of [packageRequests, serverRequests, testingRequests]) {
    expect(requests).toBe(startRequests);
  }

  expect(packageRequests.middleware).toBe(startRequests.middleware);
  expect(packageRender).toBe(retainRender);
  expect(packageHeaders).toBe(requestHeaders);
});
