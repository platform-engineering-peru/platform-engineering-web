import { apiRequest, jsonBody, secureRequest, type Transport } from "./http";
import { IntegrationError } from "./security";
export interface Connector {
  destination: string;
  scopes: string[];
  secret: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    clientId?: string;
    clientSecret?: string;
  };
  config: Record<string, any>;
  health: string;
}
export function manualPackage(payload: any) {
  return {
    state: "manual-export",
    providerId: null,
    copy: String(payload.text ?? payload.description ?? ""),
    title: String(payload.title ?? ""),
    links: [payload.link, payload.existingVideoUrl].filter(Boolean),
    media: Array.isArray(payload.media) ? payload.media : [],
    instructions:
      "Review copy and media, publish manually in the provider, then record the confirmed URL.",
  };
}
export class LinkedIn {
  constructor(private transport: Transport = secureRequest) {}
  private options(account: Connector) {
    if (
      account.health !== "connected" ||
      !account.scopes.includes("w_organization_social") ||
      !/^urn:li:organization:\d+$/.test(account.destination) ||
      !/^\d{6}$/.test(account.config.apiVersion ?? "")
    )
      throw new IntegrationError("CONNECTOR_NOT_READY", 503);
    if (
      account.secret.expiresAt &&
      Date.parse(account.secret.expiresAt) <= Date.now()
    )
      throw new IntegrationError("NEEDS_RECONNECTION", 503);
    return {
      hosts: ["api.linkedin.com"],
      headers: {
        Authorization: `Bearer ${account.secret.accessToken}`,
        "LinkedIn-Version": account.config.apiVersion,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
      },
    };
  }
  async authority(account: Connector) {
    const opts = this.options(account);
    if (!account.scopes.includes("rw_organization_admin"))
      throw new IntegrationError("AUTHORITY_SCOPE_REQUIRED", 503);
    const result = jsonBody(
      await apiRequest(
        this.transport,
        "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED",
        opts,
      ),
    );
    if (
      !result.elements?.some(
        (e: any) =>
          e.organization === account.destination &&
          [
            "ADMINISTRATOR",
            "CONTENT_ADMIN",
            "DIRECT_SPONSORED_CONTENT_POSTER",
          ].includes(e.role) &&
          e.state === "APPROVED",
      )
    )
      throw new IntegrationError("ORGANIZATION_PERMISSION_REQUIRED", 403);
  }
  async publish(account: Connector, payload: any) {
    await this.authority(account);
    const options = this.options(account);
    const body: any = {
      author: account.destination,
      commentary: payload.text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (payload.link)
      body.content = {
        article: {
          source: payload.link,
          title: payload.title ?? "",
          description: payload.description ?? "",
        },
      };
    if (payload.imageUrn) {
      if (!/^urn:li:image:[\w-]+$/.test(payload.imageUrn))
        throw new IntegrationError("INVALID_IMAGE");
      body.content = {
        media: { id: payload.imageUrn, altText: payload.altText ?? "" },
      };
    }
    const result = await apiRequest(
      this.transport,
      "https://api.linkedin.com/rest/posts",
      { ...options, method: "POST", body: JSON.stringify(body) },
    );
    const id = result.headers["x-restli-id"];
    if (!id) throw new IntegrationError("UNKNOWN_REMOTE_RESULT", 503, true);
    return {
      id,
      url: `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}`,
      state: "published",
    };
  }
  async read(account: Connector, id: string) {
    const result = jsonBody(
      await apiRequest(
        this.transport,
        `https://api.linkedin.com/rest/posts/${encodeURIComponent(id)}?viewContext=AUTHOR`,
        this.options(account),
      ),
    );
    if (result.author !== account.destination)
      throw new IntegrationError("DESTINATION_MISMATCH");
    return {
      id: result.id,
      state: result.lifecycleState === "PUBLISHED" ? "published" : "processing",
      url: `https://www.linkedin.com/feed/update/${encodeURIComponent(result.id)}`,
    };
  }
  async imageReady(account: Connector, imageUrn: string) {
    const data = jsonBody(
      await apiRequest(
        this.transport,
        `https://api.linkedin.com/rest/images/${encodeURIComponent(imageUrn)}`,
        this.options(account),
      ),
    );
    if (data.owner !== account.destination)
      throw new IntegrationError("IMAGE_DESTINATION_MISMATCH");
    if (data.status !== "AVAILABLE")
      throw new IntegrationError("RETRY_LATER", 503, false, 30);
  }
  async refresh(account: Connector) {
    if (
      !account.secret.refreshToken ||
      !account.secret.clientId ||
      !account.secret.clientSecret
    )
      throw new IntegrationError("NEEDS_RECONNECTION", 503);
    const result = jsonBody(
      await apiRequest(
        this.transport,
        "https://www.linkedin.com/oauth/v2/accessToken",
        {
          hosts: ["www.linkedin.com"],
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: account.secret.refreshToken,
            client_id: account.secret.clientId,
            client_secret: account.secret.clientSecret,
          }).toString(),
        },
      ),
    );
    return {
      ...account.secret,
      accessToken: result.access_token,
      refreshToken: result.refresh_token ?? account.secret.refreshToken,
      expiresAt: new Date(Date.now() + result.expires_in * 1000).toISOString(),
    };
  }
  async uploadImage(account: Connector, bytes: Buffer, mime: string) {
    await this.authority(account);
    const options = this.options(account),
      init = jsonBody(
        await apiRequest(
          this.transport,
          "https://api.linkedin.com/rest/images?action=initializeUpload",
          {
            ...options,
            method: "POST",
            body: JSON.stringify({
              initializeUploadRequest: { owner: account.destination },
            }),
          },
        ),
      );
    const url = new URL(init.value.uploadUrl);
    if (!["www.linkedin.com", "api.linkedin.com"].includes(url.hostname))
      throw new IntegrationError("UPLOAD_HOST_NOT_APPROVED");
    await apiRequest(this.transport, url.href, {
      hosts: [url.hostname],
      method: "PUT",
      headers: {
        Authorization: `Bearer ${account.secret.accessToken}`,
        "Content-Type": mime,
      },
      body: bytes,
    });
    return init.value.image;
  }
}
export interface VideoState {
  sessionUrl?: string;
  offset?: number;
  videoId?: string;
  total: number;
  mime: string;
  metadataHash?: string;
}
export class YouTube {
  constructor(private transport: Transport = secureRequest) {}
  private options(account: Connector) {
    if (
      account.health !== "connected" ||
      !account.scopes.some((s) =>
        [
          "https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube",
          "https://www.googleapis.com/auth/youtube.force-ssl",
        ].includes(s),
      )
    )
      throw new IntegrationError("CONNECTOR_NOT_READY", 503);
    if (
      account.secret.expiresAt &&
      Date.parse(account.secret.expiresAt) <= Date.now()
    )
      throw new IntegrationError("NEEDS_RECONNECTION", 503);
    return {
      hosts: ["www.googleapis.com"],
      headers: {
        Authorization: `Bearer ${account.secret.accessToken}`,
        "Content-Type": "application/json",
      },
    };
  }
  async identity(account: Connector) {
    const response = jsonBody(
      await apiRequest(
        this.transport,
        "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true",
        this.options(account),
      ),
    );
    if (!response.items?.some((c: any) => c.id === account.destination))
      throw new IntegrationError("CHANNEL_MISMATCH");
  }
  async start(account: Connector, payload: any, state: VideoState) {
    await this.identity(account);
    if (
      !payload.recordingConsent ||
      state.total > 5 * 1024 ** 3 ||
      state.total <= 0 ||
      !state.mime.startsWith("video/")
    )
      throw new IntegrationError("VIDEO_NOT_APPROVED");
    const result = await apiRequest(
      this.transport,
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        ...this.options(account),
        method: "POST",
        headers: {
          ...this.options(account).headers,
          "X-Upload-Content-Length": String(state.total),
          "X-Upload-Content-Type": state.mime,
        },
        body: JSON.stringify({
          snippet: {
            title: payload.title,
            description: payload.description,
            defaultLanguage: payload.language ?? "es",
            categoryId: payload.categoryId ?? "28",
          },
          status: {
            privacyStatus: "private",
            selfDeclaredMadeForKids: payload.madeForKids === true,
          },
        }),
      },
    );
    const url = new URL(result.headers.location ?? "");
    if (url.protocol !== "https:" || url.hostname !== "www.googleapis.com")
      throw new IntegrationError("UPLOAD_HOST_NOT_APPROVED");
    return { ...state, sessionUrl: url.href, offset: 0 };
  }
  async resume(account: Connector, state: VideoState) {
    if (!state.sessionUrl)
      throw new IntegrationError("UPLOAD_SESSION_REQUIRED");
    const result = await apiRequest(this.transport, state.sessionUrl, {
      ...this.options(account),
      method: "PUT",
      headers: {
        ...this.options(account).headers,
        "Content-Length": "0",
        "Content-Range": `bytes */${state.total}`,
      },
    });
    if (result.status === 308)
      return {
        ...state,
        offset: result.headers.range
          ? Number(result.headers.range.split("-")[1]) + 1
          : 0,
      };
    const data = jsonBody(result);
    return { ...state, videoId: data.id, offset: state.total };
  }
  async chunk(account: Connector, state: VideoState, bytes: Buffer) {
    if (!state.sessionUrl || !bytes.length)
      throw new IntegrationError("UPLOAD_SESSION_REQUIRED");
    const offset = state.offset ?? 0;
    if (offset + bytes.length > state.total)
      throw new IntegrationError("UPLOAD_RANGE");
    const result = await apiRequest(this.transport, state.sessionUrl, {
      ...this.options(account),
      method: "PUT",
      body: bytes,
      timeoutMs: 60000,
      headers: {
        ...this.options(account).headers,
        "Content-Type": state.mime,
        "Content-Length": String(bytes.length),
        "Content-Range": `bytes ${offset}-${offset + bytes.length - 1}/${state.total}`,
      },
    });
    if (result.status === 308)
      return {
        ...state,
        offset: result.headers.range
          ? Number(result.headers.range.split("-")[1]) + 1
          : offset,
      };
    const data = jsonBody(result);
    if (!data.id)
      throw new IntegrationError("UNKNOWN_REMOTE_RESULT", 503, true);
    return { ...state, offset: state.total, videoId: data.id };
  }
  async read(account: Connector, id: string) {
    const data = jsonBody(
      await apiRequest(
        this.transport,
        `https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails,snippet&id=${encodeURIComponent(id)}`,
        this.options(account),
      ),
    );
    const video = data.items?.[0];
    if (!video || video.snippet.channelId !== account.destination)
      throw new IntegrationError("CHANNEL_MISMATCH");
    return {
      id,
      state:
        video.processingDetails?.processingStatus === "failed" ||
        video.status.uploadStatus === "failed"
          ? "failed"
          : video.processingDetails?.processingStatus !== "succeeded"
            ? "processing"
            : video.status.privacyStatus === "public"
              ? "published"
              : "uploaded-private",
      visibility: video.status.privacyStatus,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
    };
  }
  async visibility(
    account: Connector,
    id: string,
    visibility: "private" | "unlisted" | "public",
    publishAt?: string,
  ) {
    if (
      !account.scopes.some((s) =>
        [
          "https://www.googleapis.com/auth/youtube",
          "https://www.googleapis.com/auth/youtube.force-ssl",
        ].includes(s),
      )
    )
      throw new IntegrationError("VISIBILITY_SCOPE_REQUIRED", 403);
    await this.identity(account);
    await this.read(account, id);
    return jsonBody(
      await apiRequest(
        this.transport,
        "https://www.googleapis.com/youtube/v3/videos?part=status",
        {
          ...this.options(account),
          method: "PUT",
          body: JSON.stringify({
            id,
            status: {
              privacyStatus: publishAt ? "private" : visibility,
              ...(publishAt ? { publishAt } : {}),
            },
          }),
        },
      ),
    );
  }
  async metadata(account: Connector, id: string, payload: any) {
    if (
      !account.scopes.some((s) =>
        [
          "https://www.googleapis.com/auth/youtube",
          "https://www.googleapis.com/auth/youtube.force-ssl",
        ].includes(s),
      )
    )
      throw new IntegrationError("METADATA_SCOPE_REQUIRED", 403);
    await this.identity(account);
    return jsonBody(
      await apiRequest(
        this.transport,
        "https://www.googleapis.com/youtube/v3/videos?part=snippet",
        {
          ...this.options(account),
          method: "PUT",
          body: JSON.stringify({
            id,
            snippet: {
              title: payload.title,
              description: payload.description,
              categoryId: payload.categoryId ?? "28",
              defaultLanguage: payload.language ?? "es",
            },
          }),
        },
      ),
    );
  }
  async thumbnail(account: Connector, id: string, bytes: Buffer, mime: string) {
    if (
      bytes.length > 2 * 1024 * 1024 ||
      !["image/jpeg", "image/png"].includes(mime)
    )
      throw new IntegrationError("THUMBNAIL_INVALID");
    return jsonBody(
      await apiRequest(
        this.transport,
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(id)}`,
        {
          ...this.options(account),
          method: "POST",
          headers: { ...this.options(account).headers, "Content-Type": mime },
          body: bytes,
        },
      ),
    );
  }
  async playlist(account: Connector, id: string, playlistId: string) {
    const playlist = jsonBody(
      await apiRequest(
        this.transport,
        `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${encodeURIComponent(playlistId)}`,
        this.options(account),
      ),
    );
    if (playlist.items?.[0]?.snippet?.channelId !== account.destination)
      throw new IntegrationError("PLAYLIST_CHANNEL_MISMATCH");
    const existing = jsonBody(
      await apiRequest(
        this.transport,
        `https://www.googleapis.com/youtube/v3/playlistItems?part=id&playlistId=${encodeURIComponent(playlistId)}&videoId=${encodeURIComponent(id)}`,
        this.options(account),
      ),
    );
    if (existing.items?.length) return existing.items[0];
    return jsonBody(
      await apiRequest(
        this.transport,
        "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet",
        {
          ...this.options(account),
          method: "POST",
          body: JSON.stringify({
            snippet: {
              playlistId,
              resourceId: { kind: "youtube#video", videoId: id },
            },
          }),
        },
      ),
    );
  }
  async refresh(account: Connector) {
    if (
      !account.secret.refreshToken ||
      !account.secret.clientId ||
      !account.secret.clientSecret
    )
      throw new IntegrationError("NEEDS_RECONNECTION", 503);
    const result = jsonBody(
      await apiRequest(this.transport, "https://oauth2.googleapis.com/token", {
        hosts: ["oauth2.googleapis.com"],
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: account.secret.refreshToken,
          client_id: account.secret.clientId,
          client_secret: account.secret.clientSecret,
        }).toString(),
      }),
    );
    return {
      ...account.secret,
      accessToken: result.access_token,
      expiresAt: new Date(Date.now() + result.expires_in * 1000).toISOString(),
    };
  }
}
