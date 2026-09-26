export function currentWorkspaceId() {
  return (
    new URLSearchParams(globalThis.location?.search || "").get("workspace") ||
    "creation"
  );
}
export function apiPath(route, workspaceId = currentWorkspaceId()) {
  return (
    "/api/workspaces/" +
    encodeURIComponent(workspaceId) +
    "/" +
    route.replace(/^\/?api\//, "").replace(/^\//, "")
  );
}
