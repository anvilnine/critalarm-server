// The path a request log line may show. The receipt route of the weekly check
// (api.md §4.5) carries the check_id in its path, and a check_id is in the
// push and nowhere else, so the log line gets a placeholder in its place.
export function loggedPath(pathname: string): string {
  return pathname.replace(/\/checks\/[^/]+\/receipt$/, "/checks/-/receipt");
}
