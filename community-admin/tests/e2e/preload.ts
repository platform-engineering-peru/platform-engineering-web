/** Loaded in isolated supplemental Node processes before any old suite imports. */
import net from "node:net";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { validateDatabaseURL } from "./safety";
const target = validateDatabaseURL(process.env.DATABASE_URL),
  allowed = new Set([Number(new URL(target.url).port || "5432")]),
  violations: string[] = [],
  events: any[] = [],
  originalConnect = net.Socket.prototype.connect,
  originalListen = net.Server.prototype.listen,
  originalClose = net.Server.prototype.close;
const ownedServers = new Map<net.Server, number>();
function registerOwned(server: net.Server) {
  const address = server.address();
  if (address && typeof address === "object" && !ownedServers.get(server)) {
    ownedServers.set(server, address.port);
    allowed.add(address.port);
    events.push({ event: "owned", port: address.port });
    if (process.env.E2E_OWNED_PORTS_FILE)
      appendFileSync(
        process.env.E2E_OWNED_PORTS_FILE,
        String(address.port) + "\n",
      );
  }
}
net.Server.prototype.listen = function (this: net.Server, ...args: any[]): any {
  const first = args[0],
    requestedPort = typeof first === "object" ? first?.port : first,
    specialPort = Number(process.env.E2E_ALLOWED_TEST_PORT);

  if (
    requestedPort !== 0 &&
    (!specialPort || requestedPort !== specialPort || specialPort === 4455)
  )
    throw Error("E2E_EPHEMERAL_LISTEN_REQUIRED");
  const callback = args.find((arg) => typeof arg === "function");
  ownedServers.set(this, 0);
  this.once("listening", () => {
    if (ownedServers.get(this) === 0) ownedServers.delete(this);
    registerOwned(this);
  });
  return (originalListen as any).call(
    this,
    {
      ...(typeof first === "object" ? first : {}),
      port: requestedPort,
      host: "127.0.0.1",
    },
    callback,
  );
} as typeof originalListen;
net.Server.prototype.close = function (this: net.Server, ...args: any[]): any {
  const port = ownedServers.get(this);
  events.push({ event: "close", port });
  if (port) {
    allowed.delete(port);
    if (process.env.E2E_OWNED_PORTS_FILE)
      appendFileSync(process.env.E2E_OWNED_PORTS_FILE, `-${port}\n`);
  }
  ownedServers.delete(this);
  return (originalClose as any).apply(this, args);
} as typeof originalClose;
net.Socket.prototype.connect = function (
  this: net.Socket,
  ...args: any[]
): any {
  const input = Array.isArray(args[0]) ? args[0] : args,
    options =
      typeof input[0] === "object"
        ? input[0]
        : {
            port: input[0],
            host: typeof input[1] === "string" ? input[1] : "localhost",
          };
  for (const [server, port] of ownedServers) if (!port) registerOwned(server);
  if (process.env.E2E_OWNED_PORTS_FILE)
    for (const port of readFileSync(
      process.env.E2E_OWNED_PORTS_FILE,
      "utf8",
    ).split("\n"))
      if (/^\d+$/.test(port)) allowed.add(Number(port));
      else if (/^-\d+$/.test(port)) allowed.delete(-Number(port));
  const loopbackHost = ["127.0.0.1", "localhost", "::1"].includes(
    options.host ?? "localhost",
  );
  const originalLookup = options.lookup;
  const pinnedOwned =
    !loopbackHost &&
    typeof originalLookup === "function" &&
    allowed.has(Number(options.port));
  if (pinnedOwned)
    options.lookup = (
      hostname: string,
      lookupOptions: any,
      callback: (...args: any[]) => void,
    ) =>
      originalLookup(
        hostname,
        lookupOptions,
        (error: any, address: any, family: any) => {
          const addresses = Array.isArray(address)
            ? address.map((a: any) => a.address)
            : [address];
          if (
            !error &&
            addresses.some((a: string) => !["127.0.0.1", "::1"].includes(a))
          ) {
            violations.push("nonloopback-pinned-lookup");
            return callback(Error("E2E_NETWORK_BLOCKED"));
          }
          callback(error, address, family);
        },
      );
  if (
    options.path ||
    (!loopbackHost && !pinnedOwned) ||
    !allowed.has(Number(options.port)) ||
    Number(options.port) === 4455
  ) {
    events.push({
      event: "blocked",
      host: options.host,
      port: options.port,
      allowed: [...allowed],
      servers: [...ownedServers].map(([server, port]) => ({
        port,
        address: server.address(),
        listening: server.listening,
      })),
    });
    violations.push(
      `socket:${options.host}:${options.port}:path=${!!options.path}`,
    );
    throw Error(
      `E2E_NETWORK_BLOCKED:${options.host}:${options.port}:path=${!!options.path}`,
    );
  }
  return (originalConnect as any).apply(this, args);
} as typeof originalConnect;
for (const method of [
  "spawn",
  "execFile",
  "spawnSync",
  "execFileSync",
] as const) {
  const original = childProcess[method] as any;
  (childProcess as any)[method] = (
    file: string,
    args: any[] = [],
    options: any = {},
    ...rest: any[]
  ) => {
    // The only Git call is a fixed read of the source identity, never a provider mutation.
    if (
      file === "git" &&
      args.length === 2 &&
      args[0] === "rev-parse" &&
      args[1] === "HEAD" &&
      process.env.E2E_SOURCE_REPOSITORY
    )
      return original(
        "/usr/bin/git",
        args,
        {
          ...options,
          cwd: process.env.E2E_SOURCE_REPOSITORY,
          env: { ...process.env, ...(options.env ?? {}) },
        },
        ...rest,
      );
    // Playwright's own driver and Node test workers are the only child executables.
    if (
      (resolve(file) !== resolve(process.execPath) &&
        resolve(file) !==
          resolve(
            process.env.E2E_ALLOWED_BROWSER_EXECUTABLE ?? "/e2e-no-browser",
          ) &&
        !(
          [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/opt/google/chrome/chrome",
          ].includes(resolve(file)) &&
          process.env.E2E_BROWSER_CHANNEL === "chrome"
        ) &&
        !(
          [
            process.env.E2E_ALLOWED_BIN_ROOT,
            process.env.E2E_ALLOWED_ROOT_BIN_ROOT,
          ].some(
            (root) => root && resolve(file).startsWith(resolve(root) + "/"),
          ) && /\/[^/]+\/bin\/esbuild$/.test(file)
        )) ||
      !Array.isArray(args) ||
      args.some((arg) => String(arg).startsWith("--env-file"))
    ) {
      violations.push("subprocess");
      throw Error("E2E_SUBPROCESS_BLOCKED");
    }
    const env = {
      ...process.env,
      ...(options.env ?? {}),
      DATABASE_URL: target.url,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
    };
    return original(file, args, { ...options, env }, ...rest);
  };
}
for (const method of ["exec", "execSync", "fork"] as const)
  (childProcess as any)[method] = () => {
    violations.push("shell");
    throw Error("E2E_SUBPROCESS_BLOCKED");
  };
syncBuiltinESMExports();
process.on("exit", () => {
  if (process.env.E2E_GUARD_REPORT_DIR)
    writeFileSync(
      resolve(process.env.E2E_GUARD_REPORT_DIR, `guard-${process.pid}.json`),
      JSON.stringify({ violations, events: events.slice(-100) }),
    );
  if (violations.length) process.exitCode = 1;
});
