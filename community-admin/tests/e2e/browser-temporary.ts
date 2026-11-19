import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** POSIX browser sockets must fit sun_path even when the CI workspace is deeply nested. */
export async function withBrowserTemporary<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "pep-browser-"),
  );
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
