import net from "node:net";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
/** Installed before importing compiled app code. No provider or credential CLI may escape fixtures. */
export function installNetworkFence(ports: Set<number>, violations: string[]) {
  const connect = net.Socket.prototype.connect,
    originals = new Map<string, any>();
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
            },
      host = options.host ?? "localhost",
      port = Number(options.port);
    if (
      options.path ||
      !["127.0.0.1", "localhost", "::1"].includes(host) ||
      !ports.has(port) ||
      port === 4455
    ) {
      violations.push("blocked-node-socket");
      throw Error("E2E_NETWORK_BLOCKED");
    }
    return (connect as any).apply(this, args);
  } as typeof connect;
  for (const key of [
    "spawn",
    "exec",
    "execFile",
    "execSync",
    "execFileSync",
    "spawnSync",
    "fork",
  ]) {
    originals.set(key, (childProcess as any)[key]);
    (childProcess as any)[key] = () => {
      violations.push("blocked-subprocess");
      throw Error("E2E_SUBPROCESS_BLOCKED");
    };
  }
  syncBuiltinESMExports();
  return () => {
    net.Socket.prototype.connect = connect;
    for (const [key, value] of originals) (childProcess as any)[key] = value;
    syncBuiltinESMExports();
  };
}
