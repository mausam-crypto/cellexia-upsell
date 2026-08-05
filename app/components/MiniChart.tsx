// ─────────────────────────────────────────────────────────────────────────────
// MiniChart — dependency-free inline SVG line/area chart for the admin UI.
// Axis-less sparkline style: soft area fills, lines with dots, an HTML legend
// with each series' latest value, and last-value labels pinned to the line
// ends inside the SVG. Renders a graceful empty state when there is no data.
// ─────────────────────────────────────────────────────────────────────────────

export interface MiniChartPoint {
  /** e.g. "2026-07-14" — first and last dates are shown under the chart. */
  date: string;
  /** One number per series, aligned with `labels`. */
  values: number[];
}

export interface MiniChartProps {
  series: MiniChartPoint[];
  /** Series names, e.g. ["Impressions", "Accepts"]. */
  labels: string[];
  /** ViewBox height in px (the chart scales responsively to its container). */
  height?: number;
}

const VIEWBOX_WIDTH = 640;
const SERIES_COLORS = ["#2c6ecb", "#008060", "#b98900", "#d82c0d", "#5c6ac4"];
const PAD_LEFT = 10;
const PAD_RIGHT = 64; // room for last-value labels
const PAD_TOP = 14;
const PAD_BOTTOM = 10;
const LABEL_MIN_GAP = 12;

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(value * 100) / 100);
}

function EmptyState({ height, message }: { height: number; message: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height,
        color: "#6d7175",
        fontSize: 13,
        background: "#fafbfb",
        border: "1px dashed #d2d5d8",
        borderRadius: 8,
      }}
    >
      {message}
    </div>
  );
}

export function MiniChart({ series, labels, height = 160 }: MiniChartProps) {
  const seriesCount = labels.length;

  if (series.length === 0 || seriesCount === 0) {
    return <EmptyState height={height} message="No data for this period yet" />;
  }

  const valueAt = (pointIndex: number, seriesIndex: number): number => {
    const raw = series[pointIndex]?.values[seriesIndex];
    return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 0;
  };

  let hasAnyValue = false;
  for (let i = 0; i < series.length && !hasAnyValue; i++) {
    for (let s = 0; s < seriesCount; s++) {
      if (valueAt(i, s) > 0) {
        hasAnyValue = true;
        break;
      }
    }
  }
  if (!hasAnyValue) {
    return <EmptyState height={height} message="No activity recorded in this period yet" />;
  }

  const n = series.length;
  const innerWidth = VIEWBOX_WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = height - PAD_TOP - PAD_BOTTOM;
  const baselineY = height - PAD_BOTTOM;

  let maxValue = 1;
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < seriesCount; s++) {
      maxValue = Math.max(maxValue, valueAt(i, s));
    }
  }

  const xFor = (pointIndex: number): number =>
    n <= 1 ? PAD_LEFT + innerWidth / 2 : PAD_LEFT + (pointIndex / (n - 1)) * innerWidth;
  const yFor = (value: number): number => PAD_TOP + (1 - value / maxValue) * innerHeight;

  const showDots = n <= 45;

  interface RenderedSeries {
    color: string;
    label: string;
    polylinePoints: string;
    areaPath: string;
    dots: Array<{ x: number; y: number }>;
    lastX: number;
    lastY: number;
    lastValue: number;
  }

  const rendered: RenderedSeries[] = [];
  for (let s = 0; s < seriesCount; s++) {
    const color = SERIES_COLORS[s % SERIES_COLORS.length];
    const coords: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < n; i++) {
      coords.push({ x: xFor(i), y: yFor(valueAt(i, s)) });
    }
    const polylinePoints = coords
      .map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(" ");
    const first = coords[0];
    const last = coords[coords.length - 1];
    const areaPath =
      `M ${first.x.toFixed(1)} ${baselineY.toFixed(1)} ` +
      coords.map((c) => `L ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ") +
      ` L ${last.x.toFixed(1)} ${baselineY.toFixed(1)} Z`;
    rendered.push({
      color,
      label: labels[s],
      polylinePoints,
      areaPath,
      dots: coords,
      lastX: last.x,
      lastY: last.y,
      lastValue: valueAt(n - 1, s),
    });
  }

  // Nudge last-value labels apart so overlapping line ends stay readable.
  const labelYs = rendered.map((r) => Math.min(Math.max(r.lastY + 4, PAD_TOP), height - 4));
  const order = labelYs
    .map((y, index) => ({ y, index }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    if (order[k].y - order[k - 1].y < LABEL_MIN_GAP) {
      order[k].y = order[k - 1].y + LABEL_MIN_GAP;
    }
  }
  // Clamp back inside the viewbox from the bottom up.
  for (let k = order.length - 1; k >= 0; k--) {
    const maxY = height - 4 - (order.length - 1 - k) * LABEL_MIN_GAP;
    if (order[k].y > maxY) order[k].y = maxY;
  }
  const adjustedLabelY: number[] = [];
  for (const entry of order) adjustedLabelY[entry.index] = entry.y;

  const firstDate = series[0].date;
  const lastDate = series[n - 1].date;
  const ariaLabel = labels
    .map((label, s) => `${label}: latest ${compactNumber(rendered[s]?.lastValue ?? 0)}`)
    .join("; ");

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 6,
          fontSize: 12,
          color: "#616a75",
        }}
      >
        {rendered.map((r) => (
          <span
            key={r.label}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                background: r.color,
                display: "inline-block",
                flexShrink: 0,
              }}
            />
            <span>{r.label}</span>
            <span style={{ fontWeight: 600, color: "#1a1c1f" }}>
              {compactNumber(r.lastValue)}
            </span>
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`}
        role="img"
        aria-label={`Chart. ${ariaLabel}`}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        <line
          x1={PAD_LEFT}
          y1={baselineY}
          x2={VIEWBOX_WIDTH - PAD_RIGHT}
          y2={baselineY}
          stroke="#e3e5e7"
          strokeWidth={1}
        />
        {rendered.map((r, s) => (
          <g key={r.label}>
            <path d={r.areaPath} fill={r.color} fillOpacity={0.08} stroke="none" />
            <polyline
              points={r.polylinePoints}
              fill="none"
              stroke={r.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {showDots &&
              r.dots.map((dot, i) => (
                <circle
                  // eslint-disable-next-line react/no-array-index-key
                  key={i}
                  cx={dot.x}
                  cy={dot.y}
                  r={2}
                  fill={r.color}
                />
              ))}
            <circle cx={r.lastX} cy={r.lastY} r={3.5} fill={r.color} />
            <text
              x={r.lastX + 7}
              y={adjustedLabelY[s]}
              fontSize={11}
              fontWeight={600}
              fill={r.color}
            >
              {compactNumber(r.lastValue)}
            </text>
          </g>
        ))}
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "#8a9099",
          marginTop: 2,
        }}
      >
        <span>{firstDate}</span>
        {n > 1 ? <span>{lastDate}</span> : null}
      </div>
    </div>
  );
}

export default MiniChart;
