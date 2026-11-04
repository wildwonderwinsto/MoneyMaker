/** Tiny server-rendered trend line for cards (decorative; the card states the numbers). */
export function Sparkline({
  values,
  width = 120,
  height = 32,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  label: string;
}) {
  if (values.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (width - 4) + 2;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = values.at(-1)! >= values[0];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={up ? "var(--gain)" : "var(--loss)"}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
