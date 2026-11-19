import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash, createHmac } from "node:crypto";
import type { MultipartBackend } from "./video";
import { IntegrationError } from "./security";
const hex = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value).digest();
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
/** Private multipart uploads use short-lived SigV4 URLs; no browser AWS credentials. */
export class S3Multipart implements MultipartBackend {
  name = "s3";
  client: S3Client;
  constructor(
    private bucket: string,
    private region: string,
    private endpoint?: string,
  ) {
    if (!bucket || !region)
      throw new IntegrationError("S3_CONFIGURATION_REQUIRED");
    if (endpoint) {
      const url = new URL(endpoint);
      if (
        url.protocol !== "https:" &&
        !["127.0.0.1", "localhost"].includes(url.hostname)
      )
        throw new IntegrationError("S3_ENDPOINT_INVALID");
    }
    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }
  async begin(key: string, mime: string) {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mime,
        ServerSideEncryption: "AES256",
      }),
    );
    if (!result.UploadId) throw new IntegrationError("MULTIPART_FAILED");
    return result.UploadId;
  }
  async signPart(key: string, uploadId: string, part: number) {
    const credentials = await this.client.config.credentials(),
      now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
      date = now.slice(0, 8),
      scope = `${date}/${this.region}/s3/aws4_request`;
    const url = new URL(
      this.endpoint ?? `https://s3.${this.region}.amazonaws.com`,
    );
    url.pathname = [
      url.pathname.replace(/\/$/, ""),
      encode(this.bucket),
      ...key.split("/").map(encode),
    ].join("/");
    const query: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
      "X-Amz-Date": now,
      "X-Amz-Expires": "900",
      "X-Amz-SignedHeaders": "host",
      partNumber: String(part),
      uploadId,
    };
    if (credentials.sessionToken)
      query["X-Amz-Security-Token"] = credentials.sessionToken;
    const canonicalQuery = Object.entries(query)
      .map(([k, v]) => [encode(k), encode(v)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const canonical = [
      "PUT",
      url.pathname,
      canonicalQuery,
      `host:${url.host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const signingKey = hmac(
      hmac(
        hmac(hmac("AWS4" + credentials.secretAccessKey, date), this.region),
        "s3",
      ),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey)
      .update(`AWS4-HMAC-SHA256\n${now}\n${scope}\n${hex(canonical)}`)
      .digest("hex");
    url.search = canonicalQuery + "&X-Amz-Signature=" + signature;
    return url.href;
  }
  async complete(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }
  async read(key: string, offset: number, length: number) {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=${offset}-${offset + length - 1}`,
      }),
    );
    if (!result.Body) throw new IntegrationError("VIDEO_MISSING");
    return Buffer.from(await result.Body.transformToByteArray());
  }
  async digest(key: string) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new IntegrationError("VIDEO_MISSING");
    const hash = createHash("sha256"),
      signature = Buffer.alloc(32);
    let bytes = 0;
    for await (const chunk of result.Body as any) {
      const b = Buffer.from(chunk);
      if (bytes < 32)
        b.copy(signature, bytes, 0, Math.min(32 - bytes, b.length));
      bytes += b.length;
      if (bytes > 5 * 1024 ** 3) throw new IntegrationError("VIDEO_SIZE_LIMIT");
      hash.update(b);
    }
    return { bytes, signature, sha256: hash.digest("hex") };
  }
  async abort(key: string, uploadId: string) {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (e: any) {
      if (e.name !== "NoSuchUpload") throw e;
    }
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
