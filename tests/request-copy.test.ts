import { expect, test } from "vite-plus/test";

import { httpBackend } from "~/components/http";
import { httpBackend as internalHttpBackend } from "~/components/http/backend";
import { httpRequest as internalHttpRequest } from "~/components/http/http.server";
import { httpRequest } from "~/components/http/index.server";
import { startRequests } from "~/components/requests";
import { requestHeaders as internalHeaders } from "~/components/requests/headers.server";
import { startRequests as serverRequests } from "~/components/requests/index.server";
import { requestHeaders } from "~/components/requests/index.server";
import { startRequests as internalRequests } from "~/components/requests/start";

test("request public entries share one middleware and state", () => {
  for (const requests of [internalRequests, serverRequests]) {
    expect(requests).toBe(startRequests);
  }

  expect(internalRequests.middleware).toBe(startRequests.middleware);
  expect(internalHeaders).toBe(requestHeaders);
});

test("HTTP public entries share their owned backend binding and operation", () => {
  expect(internalHttpBackend).toBe(httpBackend);
  expect(internalHttpRequest).toBe(httpRequest);
});
