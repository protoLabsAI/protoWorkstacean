interface PrBadgesProps {
  conflicting: number;
  stale: number;
  failing: number;
}

export default function PrBadges({ conflicting, stale, failing }: PrBadgesProps) {
  const hasBadges = conflicting > 0 || stale > 0 || failing > 0;

  if (!hasBadges) {
    return <span class="badge badge-green">clean</span>;
  }

  return (
    <span class="pr-badges">
      {conflicting > 0 && (
        <span class="badge badge-red">{conflicting} conflict{conflicting !== 1 ? "s" : ""}</span>
      )}
      {stale > 0 && (
        <span class="badge badge-yellow">{stale} stale</span>
      )}
      {failing > 0 && (
        <span class="badge badge-red">{failing} failing</span>
      )}
      <style>{`
        .pr-badges {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          flex-wrap: wrap;
        }
      `}</style>
    </span>
  );
}
