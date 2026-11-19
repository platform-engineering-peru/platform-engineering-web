import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Private copies: export reads the same pinned JSON without writing the checkout. */
export async function copyJourneyContracts(
  repository: string,
  temporary: string,
) {
  const source = join(repository, "contracts");
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries)
    if (!entry.isFile() || !/^[a-z][a-z0-9.-]*\.json$/.test(entry.name))
      throw Error("E2E_UNSAFE_CONTRACT_INPUT");
  const destination = join(temporary, "contracts");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries)
    await copyFile(join(source, entry.name), join(destination, entry.name));
}
