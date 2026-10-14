import { startRequests as packageRequests } from "@tinker/start";
import {
  startRequests as serverRequests,
  httpRequest as packageHttpRequest,
} from "@tinker/start/server";
import {
  startRequests as testingRequests,
  requestHeaders as packageHeaders,
  renderFrames as packageRender,
  httpBackend as packageHttpBackend,
} from "@tinker/start/testing";
import { expect, test } from "vite-plus/test";

import { httpBackend } from "~/components/http";
import { httpRequest } from "~/components/http/index.server";
import { startRequests } from "~/components/requests";
import { renderFrames, requestHeaders } from "~/components/requests/index.server";

test("package compatibility exports share the copied request middleware and state", () => {
  for (const requests of [packageRequests, serverRequests, testingRequests]) {
    expect(requests).toBe(startRequests);
  }

  expect(packageRequests.middleware).toBe(startRequests.middleware);
  expect(packageRender).toBe(renderFrames);
  expect(packageHeaders).toBe(requestHeaders);
});

test("package HTTP exports share the copied backend binding and operation", () => {
  expect(packageHttpBackend).toBe(httpBackend);
  expect(packageHttpRequest).toBe(httpRequest);
});
