import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
export interface PrivateStorage {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  backend: string;
}
const keySafe = (key: string) => {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9/_\-.]+$/.test(key) ||
    key.split("/").includes("..")
  )
    throw new Error("Unsafe private storage key");
  return key;
};
export function privateStorage(): PrivateStorage {
  if (process.env.STORAGE_BACKEND === "s3") {
    const bucket = process.env.S3_BUCKET;
    if (!bucket || !process.env.S3_REGION)
      throw new Error(
        "S3 storage requires an explicit private bucket and region",
      );
    const client = new S3Client({
      region: process.env.S3_REGION,
      ...(process.env.S3_ENDPOINT
        ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
        : {}),
    });
    return {
      backend: "s3",
      async remove(key) {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: keySafe(key) }),
        );
      },
      async put(key, bytes, mime) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: keySafe(key),
            Body: bytes,
            ContentType: mime,
            ServerSideEncryption: "AES256",
          }),
        );
      },
      async get(key) {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: keySafe(key) }),
        );
        if (!result.Body) throw new Error("Missing object");
        return Buffer.from(await result.Body.transformToByteArray());
      },
    };
  }
  const root = resolve(process.env.PRIVATE_STORAGE_DIR ?? ".local/storage");
  return {
    backend: "local",
    async remove(key) {
      try {
        await unlink(resolve(root, keySafe(key)));
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    },
    async put(key, bytes) {
      const path = resolve(root, keySafe(key));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = path + ".tmp-" + randomUUID();
      await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
      try {
        await link(temp, path);
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        if (!(await readFile(path)).equals(bytes))
          throw new Error("Immutable storage key collision");
      } finally {
        await unlink(temp);
      }
    },
    async get(key) {
      return readFile(resolve(root, keySafe(key)));
    },
  };
}
