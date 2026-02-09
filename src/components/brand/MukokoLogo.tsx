export function MukokoLogo({ className = "" }: { className?: string }) {
  return (
    <span
      className={`font-heading font-semibold tracking-tight ${className}`}
      aria-label="mukoko weather"
    >
      <span className="text-primary">mukoko</span>{" "}
      <span className="text-text-secondary">weather</span>
    </span>
  );
}
