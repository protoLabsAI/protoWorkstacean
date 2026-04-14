// Wildcard topic filter — supports * (single segment) and # (any suffix)
export function topicMatchesFilter(topic: string, filter: string): boolean {
  if (!filter) return true;
  const parts = filter.split(".");
  const topicParts = (topic || "").split(".");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "#") return true;
    if (parts[i] === "*") continue;
    if (parts[i] !== topicParts[i]) return false;
  }
  return parts.length === topicParts.length;
}
