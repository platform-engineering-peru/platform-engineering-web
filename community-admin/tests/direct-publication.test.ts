import test from "node:test";
import assert from "node:assert/strict";
import {
  publishDirect,
  type DirectStore,
} from "../src/server/editorial-sync/direct";
const H = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40);
const file = {
  path: "content/jobs/manual:detail:one.json",
  record: { id: "manual:detail:one", value: 1 },
  hash: "local",
};
function fixture() {
  let head = H,
    record: any = null,
    commits: any[] = [],
    attempts: any[] = [],
    writes = 0;
  let before: any = () => {};
  const transport: any = {
    snapshot: async (commit?: string) => ({
      commit: commit ?? head,
      records: commit === H ? [] : record ? [{ type: "jobs", record }] : [],
    }),
    inspectDirect: async (_: any, a: any) => {
      const commit = commits.find((c) => c.attemptId === a.id);
      return commit
        ? { state: "committed", commit }
        : head === a.expectedHeadOid
          ? { state: "head-unchanged", headCommit: head }
          : { state: "absent-proven", headCommit: head };
    },
    commitDirect: async (_: any, a: any) => {
      await before();
      if (head !== a.expectedHeadOid)
        throw Object.assign(Error("race"), {
          code: "HEAD_CHANGED",
          remoteMutationAttempted: false,
        });
      writes++;
      head = C;
      record = file.record;
      const c = {
        commitSha: C,
        commitUrl: "https://github.com/example/commit/" + C,
        parent: H,
        attemptId: a.id,
      };
      commits.push(c);
      return c;
    },
  };
  const store: DirectStore = {
    latest: async () => attempts.at(-1) ?? null,
    save: async (a: any) => {
      const i = attempts.findIndex((x) => x.id === a.id);
      if (i < 0) attempts.push({ ...a });
      else attempts[i] = { ...a };
    },
  };
  const input: any = {
    id: "1".repeat(64),
    subject: "42",
    baseCommit: H,
    baseHashes: { [file.path]: null },
    files: [file],
    repository: "platform-engineering-peru/platform-engineering-web",
    branch: "main",
  };
  return {
    transport,
    store,
    input,
    attempts,
    commits,
    head: (h: string, r: any = null) => {
      head = h;
      record = r;
    },
    before: (fn: any) => (before = fn),
    writes: () => writes,
  };
}
test("direct commit persists attempt before mutation and repeats recover same commit", async () => {
  const f = fixture();
  f.before(() => assert.equal(f.attempts.at(-1).state, "sending"));
  const a = await publishDirect(f.transport, f.input, f.store, async () => {});
  const b = await publishDirect(f.transport, f.input, f.store, async () => {});
  assert.equal(a.commitSha, b.commitSha);
  assert.equal(f.writes(), 1);
});
test("disjoint head races retry but same entity change conflicts without write", async () => {
  const f = fixture();
  let once = true;
  f.before(() => {
    if (once) {
      once = false;
      f.head(B);
    }
  });
  await publishDirect(f.transport, f.input, f.store, async () => {});
  assert.equal(f.writes(), 1);
  const other = fixture();
  other.head(B, { ...file.record, value: 2 });
  await assert.rejects(
    publishDirect(other.transport, other.input, other.store, async () => {}),
    { code: "REMOTE_RECORD_CONFLICT" },
  );
  assert.equal(other.writes(), 0);
});
test("lost response is recovered before any rebase or second mutation", async () => {
  const f = fixture();
  const actual = f.transport.commitDirect;
  f.transport.commitDirect = async (...args: any[]) => {
    await actual(...args);
    throw Error("connection lost");
  };
  await assert.rejects(
    publishDirect(f.transport, f.input, f.store, async () => {}),
    { code: "PUBLICATION_UNCERTAIN" },
  );
  f.head(B, file.record);
  const result = await publishDirect(
    f.transport,
    f.input,
    f.store,
    async () => {},
  );
  assert.equal(result.commitSha, C);
  assert.equal(f.writes(), 1);
});
test("proven absent attempts expose later same-record conflicts without uncertainty", async () => {
  for (const cause of ["timeout", "head-change"]) {
    const f = fixture();
    f.transport.commitDirect = async () => {
      if (cause === "head-change") f.head(B, { ...file.record, value: 2 });
      throw Object.assign(
        Error("interrupted"),
        cause === "head-change"
          ? { code: "HEAD_CHANGED", remoteMutationAttempted: false }
          : {},
      );
    };
    if (cause === "timeout") {
      await assert.rejects(
        publishDirect(f.transport, f.input, f.store, async () => {}),
        { code: "PUBLICATION_UNCERTAIN" },
      );
      f.head(B, { ...file.record, value: 2 });
    }
    await assert.rejects(
      publishDirect(f.transport, f.input, f.store, async () => {}),
      { code: "REMOTE_RECORD_CONFLICT", status: 409 },
    );
    assert.equal(f.attempts[0].state, "absent");
    assert.equal(f.writes(), 0);
  }
});
test("revoked current actor prevents remote write and bounded contention preserves intent", async () => {
  const f = fixture();
  await assert.rejects(
    publishDirect(f.transport, f.input, f.store, async () => {
      throw Object.assign(Error("revoked"), { code: "APPROVAL_REVOKED" });
    }),
    { code: "APPROVAL_REVOKED" },
  );
  assert.equal(f.writes(), 0);
  let counter = 2;
  f.transport.commitDirect = async () => {
    f.head((counter++).toString(16).padStart(40, "0"));
    throw Object.assign(Error("race"), {
      code: "HEAD_CHANGED",
      remoteMutationAttempted: false,
    });
  };
  await assert.rejects(
    publishDirect(f.transport, f.input, f.store, async () => {}),
    { code: "HEAD_CONTENTION" },
  );
  assert.equal(f.attempts.length <= 3, true);
});

test("in-flight H is replayed only at identical H when original completes before next read", async () => {
  const f = fixture();
  const { directDigest } = await import("../src/server/editorial-sync/direct");
  const { hashRevision } = await import("../src/shared/content");
  const digest = directDigest(f.input);
  const attempt: any = {
    id: hashRevision({ operation: f.input.id, head: H, digest }),
    operationId: f.input.id,
    expectedHeadOid: H,
    digest,
    state: "uncertain",
  };
  await f.store.save(attempt);
  const inspect = f.transport.inspectDirect;
  let once = true;
  f.transport.inspectDirect = async (i: any, a: any) => {
    if (once) {
      once = false;
      f.head(C, file.record);
      f.commits.push({
        commitSha: C,
        commitUrl: "https://github.com/example/commit/" + C,
        parent: H,
        attemptId: a.id,
      });
      return { state: "head-unchanged", headCommit: H };
    }
    return inspect(i, a);
  };
  const result = await publishDirect(
    f.transport,
    f.input,
    f.store,
    async () => {},
  );
  assert.equal(result.commitSha, C);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.writes(), 0);
});

test("a blocked replay never erases uncertainty about the original in-flight attempt", async () => {
  for (const phase of ["preflight", "mutation"]) {
    const f = fixture();
    const { directDigest } =
      await import("../src/server/editorial-sync/direct");
    const { hashRevision } = await import("../src/shared/content");
    const digest = directDigest(f.input);
    const a: any = {
      id: hashRevision({ operation: f.input.id, head: H, digest }),
      operationId: f.input.id,
      expectedHeadOid: H,
      digest,
      state: "uncertain",
    };
    await f.store.save(a);
    if (phase === "mutation")
      f.transport.commitDirect = async () => {
        throw Object.assign(Error("disabled"), {
          code: "REMOTE_WRITES_DISABLED",
          remoteMutationAttempted: false,
        });
      };
    await assert.rejects(
      publishDirect(f.transport, f.input, f.store, async () => {
        if (phase === "preflight")
          throw Object.assign(Error("revoked"), { code: "ACTOR_REVOKED" });
      }),
      { code: "PUBLICATION_UNCERTAIN" },
    );
    assert.equal(f.attempts[0].state, "uncertain");
    f.head(C, file.record);
    f.commits.push({
      commitSha: C,
      commitUrl: "https://github.com/example/commit/" + C,
      parent: H,
      attemptId: a.id,
    });
    const proof = await publishDirect(
      f.transport,
      f.input,
      f.store,
      async () => {
        throw Error("no new mutation allowed");
      },
    );
    assert.equal(proof.commitSha, C);
    assert.equal(f.writes(), 0);
  }
});

test("all read stages preserve prior uncertainty instead of exposing a retryable new intent", async () => {
  for (const stage of [
    "inspect",
    "snapshot",
    "hashes",
    "validation",
    "store",
  ]) {
    const f = fixture();
    const { directDigest } =
      await import("../src/server/editorial-sync/direct");
    const { hashRevision } = await import("../src/shared/content");
    const digest = directDigest(f.input),
      a: any = {
        id: hashRevision({ operation: f.input.id, head: H, digest }),
        operationId: f.input.id,
        expectedHeadOid: H,
        digest,
        state: "uncertain",
      };
    await f.store.save(a);
    if (stage === "inspect")
      f.transport.inspectDirect = async () => {
        throw Error("read unavailable");
      };
    if (stage === "snapshot")
      f.transport.snapshot = async () => {
        throw Error("read unavailable");
      };
    if (stage === "hashes")
      f.transport.hashesDirect = async () => {
        throw Error("read unavailable");
      };
    if (stage === "store")
      f.store.latest = async () => {
        throw Error("journal unavailable");
      };
    await assert.rejects(
      publishDirect(
        f.transport,
        f.input,
        f.store,
        async () => {},
        async () => {
          if (stage === "validation") throw Error("invalid response");
        },
      ),
      { code: "PUBLICATION_UNCERTAIN" },
    );
    assert.equal(f.attempts[0].state, "uncertain");
    assert.equal(f.writes(), 0);
  }
});
