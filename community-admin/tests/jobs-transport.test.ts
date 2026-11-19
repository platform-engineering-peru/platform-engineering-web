import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { pinnedLookup } from "../src/server/integrations/http";
test("Node22 autoSelectFamily connects with the pinned answer and legacy callback is preserved", async () => {
  const pin = { address: "127.0.0.1", family: 4 };
  let legacy: any[] = [];
  pinnedLookup(pin)(
    "untrusted.example",
    {},
    (...args: any[]) => (legacy = args),
  );
  assert.deepEqual(legacy, [null, "127.0.0.1", 4]);
  let all: any[] = [];
  pinnedLookup(pin)(
    "untrusted.example",
    { all: true },
    (...args: any[]) => (all = args),
  );
  assert.deepEqual(all, [null, [pin]]);
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({
        host: "pinned.example",
        port: (server.address() as net.AddressInfo).port,
        lookup: pinnedLookup(pin),
        autoSelectFamily: true,
      });
      socket.once("error", reject);
      socket.once("close", () => resolve());
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
