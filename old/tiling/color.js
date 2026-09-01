// Small CSS color parser (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba()) so a
// category's fillColor (which may already carry its own alpha, e.g.
// "#c2a074ff") can be combined with its separate fillOpacity multiplier
// into one canvas-ready rgba() string, computed once per category per tile.

function parseColor(str) {
  if (!str) return { r: 0, g: 0, b: 0, a: 1 };
  const s = str.trim();

  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }

  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const hex = m[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }

  m = s.match(/^#([0-9a-f]{8})$/i);
  if (m) {
    const hex = m[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: parseInt(hex.slice(6, 8), 16) / 255,
    };
  }

  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    return {
      r: parseFloat(m[1]),
      g: parseFloat(m[2]),
      b: parseFloat(m[3]),
      a: m[4] !== undefined ? parseFloat(m[4]) : 1,
    };
  }

  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  // Unknown format (named color etc.) - fall back to opaque black rather
  // than throwing, since this is decorative fill color, not correctness-critical.
  return { r: 0, g: 0, b: 0, a: 1 };
}

// Combine a category's own color string with a separate opacity multiplier
// (catConfig.fillOpacity / strokeOpacity) into one rgba() string.
function toRgba(colorStr, opacityMultiplier = 1) {
  const { r, g, b, a } = parseColor(colorStr);
  const finalAlpha = Math.max(0, Math.min(1, a * opacityMultiplier));
  return `rgba(${r},${g},${b},${finalAlpha})`;
}

module.exports = { parseColor, toRgba };
