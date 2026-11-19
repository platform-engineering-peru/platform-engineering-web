import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { validateDatabaseURL } from "./safety";

export async function command(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    signal?: AbortSignal;
    log?: (value: string) => void;
  } = {},
) {
  if (options.signal?.aborted) throw Error("E2E_COMMAND_ABORTED");
  return new Promise<void>((done, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "",
      expired = false;
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (bytes) => {
        const text = String(bytes);
        output = (output + text).slice(-16000);
        options.log?.(text);
      });
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error: any) {
        if (error.code !== "ESRCH") reject(error);
      }
    };
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      expired = true;
      terminate("SIGTERM");
      hardStop ??= setTimeout(() => terminate("SIGKILL"), 5000);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => {
      expired = true;
      terminate("SIGTERM");
      hardStop = setTimeout(() => terminate("SIGKILL"), 5000);
    }, options.timeout ?? 120000);
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (hardStop) clearTimeout(hardStop);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (hardStop) clearTimeout(hardStop);
      code === 0 && !expired
        ? done()
        : reject(
            Error(
              `E2E_COMMAND_FAILED:${file.split("/").at(-1)}:${expired ? "timeout" : (code ?? signal)}\n${output}`,
            ),
          );
    });
  });
}
export async function freePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("E2E_PORT_REQUIRED");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  if (address.port === 4455) return freePort();
  return address.port;
}
async function postgresBin() {
  const candidates = [
    process.env.E2E_PG_BIN,
    ...(process.env.PATH ?? "").split(":"),
    "/opt/homebrew/opt/postgresql@14/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/16/bin",
    "/usr/lib/postgresql/15/bin",
    "/usr/lib/postgresql/14/bin",
  ].filter((p): p is string => !!p);
  for (const directory of candidates) {
    try {
      for (const file of ["initdb", "pg_ctl", "createdb"])
        await access(join(directory, file), constants.X_OK);
      return directory;
    } catch {
      /* Try the next explicit binary directory; never skip the database. */
    }
  }
  throw Error(
    "E2E_POSTGRES_PREREQUISITE: install local PostgreSQL binaries or set explicit loopback E2E_DATABASE_URL to a dedicated *_e2e database",
  );
}
export async function startPostgres(
  temporary: string,
  log: (text: string) => void,
  signal?: AbortSignal,
) {
  if (process.env.E2E_DATABASE_URL) {
    const target = validateDatabaseURL(process.env.E2E_DATABASE_URL);
    return { url: target.url, ownedCluster: false, stop: async () => {} };
  }
  const bin = await postgresBin(),
    data = resolve(temporary, "postgres"),
    sockets = resolve(temporary, "sockets"),
    port = await freePort();
  await mkdir(sockets, { recursive: true, mode: 0o700 });
  await command(
    join(bin, "initdb"),
    ["-D", data, "-A", "trust", "-U", "e2e", "--no-locale", "-E", "UTF8"],
    { log, signal },
  );
  let started = false;
  const stop = async () => {
    if (started) {
      try {
        await access(join(data, "postmaster.pid"));
      } catch (error: any) {
        if (error.code === "ENOENT") {
          started = false;
          return;
        }
        throw error;
      }
      await command(
        join(bin, "pg_ctl"),
        ["-D", data, "-m", "immediate", "-w", "stop"],
        { timeout: 30000, log },
      );
      started = false;
    }
  };
  try {
    started = true;
    await command(
      join(bin, "pg_ctl"),
      [
        "-D",
        data,
        "-l",
        resolve(temporary, "postgres.log"),
        "-o",
        `-h 127.0.0.1 -p ${port} -k ${sockets} -F`,
        "-w",
        "start",
      ],
      { log, signal, timeout: 30000 },
    );
    started = true;
    const database = "admin_e2e_" + randomUUID().replaceAll("-", "");
    await command(
      join(bin, "createdb"),
      ["-h", "127.0.0.1", "-p", String(port), "-U", "e2e", database],
      { log, signal },
    );
    const url = `postgresql://e2e@127.0.0.1:${port}/${database}`;
    validateDatabaseURL(url);
    return { url, ownedCluster: true, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
