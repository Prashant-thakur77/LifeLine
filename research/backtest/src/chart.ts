export type BarChart = {
  title: string;
  subtitle: string;
  series: string[];
  groups: { label: string; values: number[] }[];
  maxValue: number; // charts that get compared must share a scale
  unit: string;
};

const WIDTH = 720;
const PLOT_LEFT = 64;
const PLOT_RIGHT = WIDTH - 72; // room for the value at the tip
const PLOT_TOP = 92;
const BAR_HEIGHT = 18;
const BAR_GAP = 2;
const GROUP_GAP = 18;
const TIP_RADIUS = 4;
const SERIES_ROLES = 3;

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A bar with a rounded tip, square at the baseline. */
function barShape(x: number, y: number, width: number, height: number): string {
  const r = Math.min(TIP_RADIUS, width);
  return `M${x} ${y}h${(width - r).toFixed(2)}q${r} 0 ${r} ${r}v${height - 2 * r}q0 ${r} ${-r} ${r}h${(r - width).toFixed(2)}z`;
}

const STYLE = `
  svg { --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --rule: #c9c8c2; --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; }
  @media (prefers-color-scheme: dark) {
    svg { --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --rule: #4a4a46; --s1: #3987e5; --s2: #d95926; --s3: #199e70; }
  }
  text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--ink-2); font-size: 12px; }
  .title { fill: var(--ink); font-size: 16px; font-weight: 600; }
  .group { fill: var(--ink); font-size: 13px; font-weight: 600; }
  .value { fill: var(--ink); }
`;

/**
 * Horizontal grouped bars, so each value can sit at its bar's tip without
 * colliding. One scale, thin marks, and a legend, so identity isn't color alone.
 */
export function barChart(chart: BarChart): string {
  const { title, subtitle, series, groups, maxValue, unit } = chart;
  if (series.length > SERIES_ROLES) throw new Error(`at most ${SERIES_ROLES} series`);

  const scale = (PLOT_RIGHT - PLOT_LEFT) / maxValue;
  const parts: string[] = [];
  let y = PLOT_TOP;

  for (const group of groups) {
    if (group.values.length !== series.length) throw new Error(`${group.label}: needs one value per series`);
    const groupHeight = series.length * BAR_HEIGHT + (series.length - 1) * BAR_GAP;
    parts.push(`<text class="group" x="${PLOT_LEFT - 12}" y="${y + groupHeight / 2 + 4}" text-anchor="end">${escapeXml(group.label)}</text>`);

    group.values.forEach((value, i) => {
      if (!Number.isFinite(value) || value < 0 || value > maxValue) throw new Error(`${group.label}: bad value ${value}`);
      const width = value * scale;
      const shown = `${value.toFixed(1)}${unit}`;
      const tooltip = `${group.label}, ${series[i]}: ${shown}`;
      parts.push(
        `<path d="${barShape(PLOT_LEFT, y, Math.max(width, 1.5), BAR_HEIGHT)}" fill="var(--s${i + 1})" data-width="${width.toFixed(4)}"><title>${escapeXml(tooltip)}</title></path>`,
        `<text class="value" x="${(PLOT_LEFT + Math.max(width, 1.5) + 6).toFixed(2)}" y="${y + 13}">${escapeXml(shown)}</text>`,
      );
      y += BAR_HEIGHT + BAR_GAP;
    });
    y += GROUP_GAP - BAR_GAP;
  }

  const plotBottom = y - GROUP_GAP + 6;
  const height = plotBottom + 16;
  let legendX = PLOT_LEFT;
  const legend = series.map((name, i) => {
    const item = `<rect x="${legendX}" y="60" width="10" height="10" rx="2" fill="var(--s${i + 1})"/><text x="${legendX + 15}" y="69">${escapeXml(name)}</text>`;
    legendX += 15 + name.length * 6.6 + 18;
    return item;
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-label="${escapeXml(`${title}. ${subtitle}`)}">`,
    `<style>${STYLE}</style>`,
    `<rect width="${WIDTH}" height="${height}" fill="var(--surface)"/>`,
    `<text class="title" x="${PLOT_LEFT}" y="26">${escapeXml(title)}</text>`,
    `<text x="${PLOT_LEFT}" y="46">${escapeXml(subtitle)}</text>`,
    ...legend,
    `<line x1="${PLOT_LEFT}" x2="${PLOT_LEFT}" y1="${PLOT_TOP - 4}" y2="${plotBottom}" stroke="var(--rule)"/>`,
    ...parts,
    "</svg>",
    "",
  ].join("\n");
}
