import { once } from "node:events";
import { createServer, request } from "node:http";

import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { expect, onTestFinished, test } from "vite-plus/test";

import { writeResponse } from "../lib/host-response.mjs";

const text = new TextEncoder();

/**
 * The tinker serve reply path, in this process: each request writes the response `respond`
 * makes, with the join `beforeEnd` lends. It keeps what writeResponse returned, and how many
 * close listeners it added to the response and left there.
 * @param {(outgoing: import("node:http").ServerResponse) => Response | Promise<Response>} respond - From a test; why: the app's reply.
 * @param {() => Promise<void>} [beforeEnd] - From a test; why: the app's join.
 */
async function host(respond, beforeEnd) {
  const returned = [];
  const leftListeners = [];
  const server = createServer(async (incoming, outgoing) => {
    const hosted = { runtime: beforeEnd ? { beforeEnd } : {} };
    const response = await respond(outgoing);
    const before = outgoing.listenerCount("close");

    returned.push(await writeResponse(hosted, response, outgoing));
    leftListeners.push(outgoing.listenerCount("close") - before);
  });
  onTestFinished(() => server.close());

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, returned, leftListeners };
}

/**
 * @param {number} port - From host; why: the server under test.
 * @returns {Promise<{ status?: number, headers?: object, body?: string, broken: boolean }>}
 */
function read(port) {
  return new Promise((resolve) => {
    request({ port, host: "127.0.0.1" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("error", () => resolve({ status: response.statusCode, broken: true }));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body,
          broken: !response.complete,
        }),
      );
    })
      .on("error", () => resolve({ broken: true }))
      .end();
  });
}

/** @param {Uint8Array[]} parts - From a test; why: the parts enqueued at once, then the end. */
function closedStream(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

test("a reply with no body ends with its status and head, and no join is needed", async () => {
  const { port, returned } = await host(
    () => new Response(null, { status: 204, headers: { "x-kind": "empty" } }),
  );

  const reply = await read(port);

  expect(reply).toMatchObject({ status: 204, body: "", broken: false });
  expect(reply.headers["x-kind"]).toBe("empty");
  expect(returned).toEqual([RESPONSE_ALREADY_SENT]);
});

test("a whole body in parts goes out joined, with its exact length and every cookie", async () => {
  const headers = new Headers({ "content-type": "text/plain" });
  headers.append("set-cookie", "a=1");
  headers.append("set-cookie", "b=2");
  const { port } = await host(
    () => new Response(closedStream([text.encode("café "), text.encode("au lait")]), { headers }),
  );

  const reply = await read(port);

  expect(reply.body).toBe("café au lait");
  expect(reply.headers["content-length"]).toBe(String(Buffer.byteLength("café au lait")));
  expect(reply.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  expect(reply.headers["content-type"]).toBe("text/plain");
  expect(reply.headers["transfer-encoding"]).toBeUndefined();
});

test("a body that ends with no part goes out with length 0, and no cookie head", async () => {
  const { port } = await host(() => new Response(closedStream([]), { status: 201 }));

  const reply = await read(port);

  expect(reply).toMatchObject({ status: 201, body: "", broken: false });
  expect(reply.headers["content-length"]).toBe("0");
  expect(reply.headers).not.toHaveProperty("set-cookie");
});

test("the join runs before the head of a whole reply, and after the parts of a stream", async () => {
  const order = [];
  let kind = 0;
  const bodies = [
    () => null,
    () => closedStream([text.encode("whole")]),
    () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(text.encode("first "));
          setTimeout(() => {
            controller.enqueue(text.encode("late"));
            controller.close();
          }, 20);
        },
      }),
  ];
  const { port, leftListeners } = await host(
    (outgoing) => {
      const writeHead = outgoing.writeHead.bind(outgoing);
      outgoing.writeHead = (...args) => {
        order.push("head");
        return writeHead(...args);
      };
      return new Response(bodies[kind++]());
    },
    async () => {
      order.push("join");
    },
  );

  const replies = [await read(port), await read(port), await read(port)];

  expect(replies.map((reply) => reply.body)).toEqual(["", "whole", "first late"]);
  expect(order).toEqual(["join", "head", "join", "head", "head", "join"]);
  expect(leftListeners).toEqual([0, 0, 0]);
});

test.each([
  ["no body", () => null],
  ["a whole body", () => closedStream([text.encode("whole")])],
])("a join that fails breaks a reply with %s before any head", async (_, body) => {
  const { port, returned } = await host(
    () => new Response(body()),
    () => Promise.reject(new Error("commit failed")),
  );

  const reply = await read(port);

  expect(reply).toEqual({ broken: true });
  expect(returned).toEqual([RESPONSE_ALREADY_SENT]);
});

test("a join that fails breaks a streamed reply after its parts", async () => {
  const { port } = await host(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(text.encode("shell"));
            setTimeout(() => controller.close(), 20);
          },
        }),
      ),
    () => Promise.reject(new Error("commit failed")),
  );

  const reply = await read(port);

  expect(reply).toMatchObject({ status: 200, broken: true });
});

test("a stream with no part yet sends its head at once", async () => {
  let source;
  const { port } = await host(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            source = controller;
          },
        }),
        { status: 202, headers: { "x-kind": "slow" } },
      ),
  );

  const reply = await new Promise((resolve) => {
    request({ port, host: "127.0.0.1" }, (response) => {
      const head = { status: response.statusCode, headers: response.headers };
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ ...head, body }));

      source.enqueue(text.encode("late"));
      source.close();
    }).end();
  });

  expect(reply.status).toBe(202);
  expect(reply.headers["x-kind"]).toBe("slow");
  expect(reply.headers["transfer-encoding"]).toBe("chunked");
  expect(reply.body).toBe("late");
});

test("a slow client holds the stream: no part is read while the socket is full", async () => {
  const part = new Uint8Array(64 * 1024);
  let pulls = 0;
  const { port, leftListeners } = await host((outgoing) => {
    outgoing.socket.setSendBufferSize?.(64 * 1024);
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulls += 1;
            if (pulls > 400) controller.close();
            else controller.enqueue(part);
          },
        },
        { highWaterMark: 0 },
      ),
    );
  });

  const received = await new Promise((resolve) => {
    request({ port, host: "127.0.0.1" }, (response) => {
      response.pause();
      setTimeout(() => {
        const held = pulls;
        let size = 0;
        response.on("data", (chunk) => (size += chunk.length));
        response.on("end", () => resolve({ held, size }));
        response.resume();
      }, 200);
    }).end();
  });

  expect(received.held).toBeLessThan(200);
  expect(received.size).toBe(400 * part.byteLength);
  await expect.poll(() => leftListeners).toEqual([0]);
});

test("a client that leaves mid-stream cancels the body and skips the join", async () => {
  const cancelled = Promise.withResolvers();
  let joined = false;
  const { port, returned } = await host(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(text.encode("first"));
          },
          cancel: (reason) => cancelled.resolve(reason),
        }),
      ),
    async () => {
      joined = true;
    },
  );

  const client = request({ port, host: "127.0.0.1" }, (response) => {
    response.once("data", () => client.destroy());
  });
  client.on("error", () => {});
  client.end();

  await cancelled.promise;
  await expect.poll(() => returned).toEqual([RESPONSE_ALREADY_SENT]);
  expect(joined).toBe(false);
});

test("a slow client that leaves while the socket is full still ends the stream", async () => {
  const part = new Uint8Array(64 * 1024);
  const cancelled = Promise.withResolvers();
  let joined = false;
  const { port, returned } = await host(
    () =>
      new Response(
        new ReadableStream(
          {
            pull: (controller) => controller.enqueue(part),
            cancel: () => cancelled.resolve(),
          },
          { highWaterMark: 0 },
        ),
      ),
    async () => {
      joined = true;
    },
  );

  const client = request({ port, host: "127.0.0.1" }, (response) => {
    response.pause();
    setTimeout(() => client.destroy(), 100);
  });
  client.on("error", () => {});
  client.end();

  await cancelled.promise;
  await expect.poll(() => returned).toEqual([RESPONSE_ALREADY_SENT]);
  expect(joined).toBe(false);
});

test("a response its client closed before the reply cancels the body at once", async () => {
  let state = "open";
  let joined = false;
  const { port, returned } = await host(
    async (outgoing) => {
      outgoing.destroy();
      await once(outgoing, "close");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(text.encode("first"));
          },
          cancel: () => {
            state = "cancelled";
          },
        }),
      );
    },
    async () => {
      joined = true;
    },
  );

  expect(await read(port)).toEqual({ broken: true });

  await expect.poll(() => state).toBe("cancelled");
  await expect.poll(() => returned).toEqual([RESPONSE_ALREADY_SENT]);
  expect(joined).toBe(false);
});
