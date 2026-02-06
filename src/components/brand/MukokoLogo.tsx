export function MukokoLogo({ className = "" }: { className?: string }) {
  return (
    <span
      className={`font-sans font-semibold tracking-tight text-primary ${className}`}
      aria-label="mukoko weather"
    >
      mukoko weather
    </span>
  );
}
