/** Worker delivery, canonical commit, and verified deployment are separate facts. */
export function publicationView(value: any) {
  const result = value?.result ?? value ?? {};
  const mode =
    value?.publicationMode ??
    result.publicationMode ??
    (value?.pr_number || value?.prNumber || result.prNumber || result.prUrl
      ? "pull-request"
      : "direct");
  const commitSha = value?.commitSha ?? value?.commit_sha ?? result.commitSha;
  const deployment = value?.deployment ?? result.deployment;
  const deployedSha =
    deployment?.sha ??
    value?.deployedSha ??
    value?.deployed_sha ??
    result.deployedSha;
  let state = ["queued", "sending", "retry", "unknown"].includes(value?.state)
    ? value.state
    : (result.state ?? value?.state ?? "local");
  if (["unknown", "uncertain", "branch_pending"].includes(state))
    state = "uncertain";
  else if (["conflict", "blocked"].includes(state)) {
    /* Preserve failures over stale deployment metadata. */
  } else if (
    ["deploy_failed", "deployment_failed"].includes(state) ||
    deployment?.state === "failed"
  )
    state = "deployment_failed";
  else if (deployment?.state === "superseded" || state === "superseded")
    state = "superseded";
  else if (state === "deployed" || deployment?.state === "deployed")
    state =
      deployedSha &&
      (mode === "pull-request" || deployment?.state === "deployed")
        ? "deployed"
        : "deploying";
  else if (["main_committed", "committed", "merged"].includes(state))
    state = "committed";
  else if (
    [
      "sending",
      "publishing",
      "validating",
      "preparing",
      "queued",
      "retry",
    ].includes(state)
  )
    state = "publishing";
  else if (state === "prepared" && result.operationId) state = "publishing";
  else if (["prepared", "approved", "local"].includes(state)) state = "local";
  const labels: Record<string, string> = {
    local: "Cambio revisado · sin publicar",
    publishing: "Publicando en GitHub",
    committed: "Guardado en GitHub · despliegue pendiente",
    deploying: "Desplegando el sitio",
    deployed: "Publicado en el sitio",
    deployment_failed: "El commit está guardado; falló el despliegue",
    superseded: "Una versión posterior sustituyó este contenido",
    conflict: "Hay cambios en GitHub · tu revisión se conserva",
    uncertain: "Comprobando publicación · resultado por confirmar",
    blocked: "Publicación bloqueada · tu revisión se conserva",
    failed: "No se completó la publicación",
    deadletter: "No se completó la publicación",
    retryable: "El envío puede reintentarse tras comprobar su estado",
  };
  return {
    mode,
    state,
    commitSha,
    deployedSha,
    deployment,
    commitUrl: value?.commitUrl ?? result.commitUrl,
    label:
      labels[state] ??
      (mode === "pull-request"
        ? "Envío histórico mediante PR"
        : "Resultado pendiente de confirmar"),
  };
}
