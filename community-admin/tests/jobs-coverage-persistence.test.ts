import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, migrate, COMMUNITY_ID } from "../src/server/db";
import { JobsPublisher } from "../src/server/jobs/publication";
import { normalizeJob } from "../src/server/jobs/engine";
import { directRemote } from "./direct-fixture";
import { VacancyIntakeService } from "../src/server/jobs/intake-service";
import { capabilitiesFor } from "../src/server/context";

test("explicit Peru vacancies with unknown modality publish the exact truthful reviewed revision", async () => {
  const schema = "test_coverage_" + randomUUID().replaceAll("-", ""),
    pool = createPool(process.env.DATABASE_URL!, schema),
    actor = "10000000-0000-4000-8000-000000000004";
  try {
    await migrate(pool, schema);
    await pool.query("UPDATE users SET provider_subject='42' WHERE id=$1", [
      actor,
    ]);
    const intake = new VacancyIntakeService(pool),
      user: any = {
        id: actor,
        communityId: COMMUNITY_ID,
        roles: ["owner"],
        capabilities: capabilitiesFor(["owner"]),
      };
    const fields: any = {
      url: "https://employer.example/jobs/english",
      title: "AWS Engineer",
      company: "Employer",
      locations: ["Remote, Peru"],
      workplace: "remote",
      eligibility: "remote-peru",
      eligibilityEvidence: "Original explicitly states Remote, Peru.",
      activeEvidence: "Original employer page accepts applications.",
      roleFamily: "infrastructure",
      contentLanguage: "en",
      summary: { "es-pe": "Infraestructura AWS.", en: "AWS infrastructure." },
    };
    const english = (await intake.save(user, fields, "english-original")).item;
    assert.equal(english.payload.contentLanguage, "en");
    assert.equal(english.payload.intake.curator.contentLanguage, "en");
    const { contentLanguage: _language, ...unchanged } = fields;
    const edited = (
      await intake.save(
        user,
        { ...unchanged, version: english.version },
        "english-edit",
        english.id,
      )
    ).item;
    assert.equal(edited.payload.contentLanguage, "en");
    assert.equal(edited.payload.roleFamily, "infrastructure");
    const undetermined = (
      await intake.save(
        user,
        { ...unchanged, url: "https://employer.example/jobs/unknown-language" },
        "unknown-original",
      )
    ).item;
    assert.equal(undetermined.payload.contentLanguage, "und");
    const remote = directRemote(),
      publisher = new JobsPublisher(pool, {
        config: {
          mode: "github",
          repository: "platform-engineering-peru/platform-engineering-web",
          branch: "main",
          remoteWritesEnabled: true,
        },
        transport: remote.view(["jobs"]),
      });
    const englishOperation = await publisher.create(
      COMMUNITY_ID,
      actor,
      [edited.id],
      "english-publication",
      { [edited.id]: edited.version },
    );
    await publisher.publish(COMMUNITY_ID, actor, englishOperation.subject_id);
    const englishPublic = remote.tree.get(`content/jobs/${edited.id}.json`);
    assert.equal(englishPublic.title, "AWS Engineer");
    assert.equal(englishPublic.contentLanguage, "en");
    for (const eligibility of ["peru", "unknown"]) {
      const payload = {
        ...normalizeJob(
          {
            id: randomUUID(),
            title: "Platform Engineer",
            location: { name: "Lima, Peru" },
            absolute_url: "https://employer.example/jobs/" + randomUUID(),
          },
          {
            id: "coverage",
            adapter: "smartrecruiters",
            boardIdentifier: "Employer",
            company: "Employer",
          },
          new Date(),
        ),
        eligibility,
        status: "needs-review",
        approved: false,
        summary: {
          "es-pe": "Ingeniería de plataforma en Lima.",
          en: "Platform engineering in Lima.",
        },
      };
      assert.equal(payload.workplace, "unknown");
      await pool.query(
        "INSERT INTO job_records(id,community_id,source_id,payload) VALUES($1,$2,$3,$4)",
        [payload.id, COMMUNITY_ID, "coverage", payload],
      );
      if (eligibility === "unknown") {
        await assert.rejects(
          publisher.create(COMMUNITY_ID, actor, [payload.id], randomUUID(), {
            [payload.id]: 1,
          }),
          { code: "JOB_APPROVAL_REQUIRED" },
        );
        assert.equal(remote.proofs.size, 2);
        continue;
      }
      const operation = await publisher.create(
        COMMUNITY_ID,
        actor,
        [payload.id],
        randomUUID(),
        { [payload.id]: 1 },
      );
      const sent = await publisher.publish(
        COMMUNITY_ID,
        actor,
        operation.subject_id,
      );
      assert.equal(sent.state, "committed");
      const published = remote.tree.get(`content/jobs/${payload.id}.json`);
      assert.equal(published.workplace, "unknown");
      assert.equal(published.eligibility, "peru");
      assert.equal(published.applyUrl, payload.applyUrl);
      assert.equal("locationEvidence" in published, false);
      assert.equal("workplaceEvidence" in published, false);
    }
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
