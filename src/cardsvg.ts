export interface CardData {
  title: string;
  symbol: string;
  multiplier: string; // e.g. "100x"; empty = leave blank
  pnl: string; // e.g. "+$15,000"; empty = leave blank
  profit: boolean;
  coinImage?: string; // data URI
  character?: string; // data URI
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FONT = "'Poppins Medium', 'Poppins', 'DejaVu Sans', sans-serif";

/** 1920x1080 sell card laid out like the supplied template. */
export function buildCardSvg(d: CardData): string {
  const multSize = Math.max(120, Math.min(440, Math.floor(940 / (Math.max(d.multiplier.length, 1) * 0.66))));
  const symText = `$${d.symbol}`;
  const symSize = Math.max(40, Math.min(82, Math.floor(600 / (symText.length * 0.64))));
  const coin = d.coinImage
    ? `<clipPath id="c"><circle cx="408" cy="592" r="314"/></clipPath>
       <image href="${d.coinImage}" x="94" y="278" width="628" height="628" clip-path="url(#c)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="408" cy="592" r="314" fill="#fff"/>`;
  const character = d.character
    ? `<image href="${d.character}" x="1250" y="170" width="600" height="910" opacity="0.35" preserveAspectRatio="xMidYMax meet"/>`
    : "";
  const color = d.profit ? "#19ff4d" : "#ff3b3b";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1920" height="1080" viewBox="0 0 1920 1080" font-family="${FONT}">
  <rect width="1920" height="1080" fill="#121212"/>
  ${character}
  <text x="60" y="112" font-size="76" fill="#fff">${esc(d.title)}</text>
  ${coin}
  ${d.symbol ? `<text x="384" y="1013" font-size="${symSize}" text-anchor="middle" fill="#fff">${esc(symText)}</text>` : ""}
  ${d.multiplier ? `<text x="842" y="749" font-size="${multSize}" fill="#fff">${esc(d.multiplier)}</text>` : ""}
  ${d.pnl ? `<text x="883" y="822" font-size="63" fill="${color}">P&amp;L ${esc(d.pnl)}</text>` : ""}
</svg>`;
}
