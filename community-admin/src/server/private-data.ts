import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  linkSync,
} from "node:fs";
import { resolve } from "node:path";
function keyPath(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid record key");
  return resolve(
    process.env.PRIVATE_KEY_DIR ?? ".local/record-keys",
    id + ".key",
  );
}
function key(id: string) {
  const path = keyPath(id);
  try {
    return readFileSync(path);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    mkdirSync(resolve(process.env.PRIVATE_KEY_DIR ?? ".local/record-keys"), {
      recursive: true,
      mode: 0o700,
    });
    const bytes = randomBytes(32);
    try {
      writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
      return bytes;
    } catch (error: any) {
      if (error.code === "EEXIST") return readFileSync(path);
      throw error;
    }
  }
}
export function encryptPrivate(id: string, payload: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(id), iv);
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
  ]);
  return {
    encrypted: true,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: bytes.toString("base64"),
  };
}
export function decryptPrivate(id: string, payload: any) {
  if (!payload?.encrypted) return payload;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    readFileSync(keyPath(id)),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]).toString(),
  );
}
export function erasePrivateKey(id: string) {
  try {
    unlinkSync(keyPath(id));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function exportPrivateKey(id: string) {
  try {
    return readFileSync(keyPath(id)).toString("base64");
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export function restorePrivateKey(id: string, value: string) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error("Invalid restored key");
  mkdirSync(resolve(process.env.PRIVATE_KEY_DIR ?? ".local/record-keys"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(keyPath(id), bytes, { mode: 0o600 });
}
export function rememberDeletion(entry: {
  recordId: string;
  communityId: string;
  reason: string;
  createdAt: string;
}) {
  const root = resolve(".local/deletion-ledger"),
    path = resolve(root, entry.recordId + ".json");
  if (!/^[a-f0-9-]{36}$/.test(entry.recordId))
    throw Error("Invalid deletion identity");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const syncDirectory = (directory: string) => {
    const descriptor = openSync(directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  };
  try {
    const prior = JSON.parse(readFileSync(path, "utf8"));
    if (
      prior.recordId !== entry.recordId ||
      prior.communityId !== entry.communityId
    )
      throw Error("Deletion identity conflict");
    syncDirectory(path);
    syncDirectory(root);
    syncDirectory(resolve(root, ".."));
    return;
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path + "." + randomBytes(12).toString("hex") + ".tmp";
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(entry));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporary, path);
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const prior = JSON.parse(readFileSync(path, "utf8"));
      if (
        prior.recordId !== entry.recordId ||
        prior.communityId !== entry.communityId
      )
        throw Error("Deletion identity conflict");
      syncDirectory(path);
    }
    syncDirectory(root);
    syncDirectory(resolve(root, ".."));
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
