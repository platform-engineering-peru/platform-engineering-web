const peru = /\bper[uú](?!\p{L})/iu;
const peruCode = /(?:^|[,;]\s*)PE(?:\s*[,;]|$)/i;
const latam = /\b(?:latam|latin america|latinoam[eé]rica|am[eé]rica latina)\b/i;
const remote = /\b(?:remote|remot[oa]|telecommute|teletrabajo)\b/i;
const clean = (value: unknown) =>
  typeof value === "string" ? value.trim().slice(0, 4000) : "";
/** Capture only explicit applicant/residency restrictions, not employer country mentions. */
export function applicantRestrictions(value: string) {
  const clauses = String(value ?? "")
    .slice(0, 20000)
    .split(/[.\n;]+/);
  const restriction =
    /\b(?:applicants?|candidates?)\s+(?:must|can only|may only)\s+(?:reside|live|be (?:based|located))|\bmust\s+(?:reside|live|be (?:based|located))|\bonly\s+(?:applicants?|candidates?)\s+(?:from|in)|\b(?:debe[n]?|deber[aá][n]?)\s+(?:residir|vivir|estar ubicad)|\b(?:solo|[uú]nicamente)\s+(?:residentes|candidatos)\s+(?:en|de)/i;
  return clauses
    .flatMap((sentence) => {
      const match = restriction.exec(sentence);
      if (match) return [sentence.slice(match.index).trim()];
      // Keep the country before “residents only”; a suffix-only capture loses the restriction.
      const residents =
        /\b([A-Z][\p{L}-]*(?:\s+[A-Z][\p{L}-]*){0,4})\s+residents?\s+only\b/u.exec(
          sentence,
        );
      if (residents) return [residents[0]];
      return /\bresidents?\s+only\b/i.test(sentence) ? [sentence.trim()] : [];
    })
    .join("; ")
    .slice(0, 2000);
}
/** Only vacancy location/applicant facts qualify, never employer names or generic prose. */
export function sourceGeography(
  locations: string[],
  workplace: string,
  applicantEvidence = "",
  restrictions = "",
) {
  const facts = [...locations.map(clean), clean(applicantEvidence)].filter(
    Boolean,
  );
  const excludesPeru =
    /(?:not|excluding|except|excepto|excluyendo|sin|no)\s+(?:(?:in|en)\s+)?per[uú](?!\p{L})|per[uú]\s+(?:excluded|not eligible|excluido)/iu;
  if (
    [...facts, restrictions].some((value) => excludesPeru.test(value)) ||
    (applicantEvidence &&
      !peru.test(applicantEvidence) &&
      !peruCode.test(applicantEvidence) &&
      !latam.test(applicantEvidence)) ||
    restrictions
      .split(";")
      .filter(Boolean)
      .some(
        (clause) =>
          !peru.test(clause) && !peruCode.test(clause) && !latam.test(clause),
      ) ||
    /(?:not|excluding|except|no|excepto)\s+(?:in\s+)?per[uú]/i.test(
      restrictions,
    )
  )
    return "restricted";
  if (facts.some((value) => peru.test(value) || peruCode.test(value)))
    return (workplace === "remote" &&
      (peru.test(applicantEvidence) || peruCode.test(applicantEvidence))) ||
      locations.some(
        (value) =>
          (peru.test(value) || peruCode.test(value)) && remote.test(value),
      )
      ? "remote-peru"
      : "peru";
  if (workplace === "remote" && facts.some((value) => latam.test(value)))
    return "remote-latam-confirmed";
  return "unknown";
}
export function jobGeography(job: any) {
  const locations = Array.isArray(job.locations)
    ? job.locations.filter((value: unknown) => typeof value === "string")
    : [];
  const evidence = [
    job.detailEvidence?.eligibilityText,
    job.intake?.sourceFacts?.evidence?.eligibilityText,
  ]
    .map(clean)
    .filter(Boolean)
    .join("; ");
  const restrictions = [
    job.geographyEvidence?.applicantRestrictions,
    job.detailEvidence?.applicantRestrictions,
    job.intake?.sourceFacts?.evidence?.applicantRestrictions,
    applicantRestrictions(job.sourceExcerpt ?? ""),
  ]
    .map(clean)
    .filter(Boolean)
    .join("; ");
  const observed = sourceGeography(
    locations,
    job.workplace,
    evidence,
    restrictions,
  );
  const declared = job.editorialEligibility ?? job.eligibility;
  const qualified =
    observed !== "restricted" &&
    declared !== "restricted" &&
    declared !== "unknown" &&
    ((["peru", "remote-peru"].includes(declared) &&
      ["peru", "remote-peru"].includes(observed)) ||
      (declared === "remote-latam-confirmed" &&
        observed === "remote-latam-confirmed"));
  return {
    qualified,
    eligibility: qualified ? declared : "unknown",
    reason: qualified
      ? observed === "remote-latam-confirmed"
        ? "explicit-remote-latam"
        : "explicit-peru"
      : declared === "restricted" || observed === "restricted"
        ? "restricted"
        : observed === "unknown"
          ? locations.length &&
            !locations.every((x: string) =>
              /^(remote|remoto|unknown|por confirmar|LATAM|Latin America)$/i.test(
                x.trim(),
              ),
            )
            ? "outside-region"
            : "location-unconfirmed"
          : "eligibility-unconfirmed",
  };
}
/** Already-public records must remain withdrawable even after geographic evidence changes. */
export function isClosedGeographicWithdrawal(job: any) {
  return (
    job.status === "closed" &&
    /^[a-f0-9]{64}$/.test(job.baseEntityHash ?? "") &&
    ["peru", "remote-peru", "remote-latam-confirmed"].includes(
      job.editorialWithdrawal?.publicRecord?.eligibility ?? job.eligibility,
    )
  );
}
