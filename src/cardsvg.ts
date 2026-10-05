export interface CardData {
  title: string; // unused: the logo is part of the frame artwork
  symbol: string;
  multiplier: string; // e.g. "100x"; empty = leave blank
  pnl: string; // e.g. "+$15,000"; empty = leave blank
  profit: boolean;
  coinImage?: string; // data URI
  character?: string; // data URI
  background?: string; // data URI; omitted = plain grey
  username?: string; // Telegram username, bottom-right
  tag: string; // "EXAMPLE" on /larp cards, the bot link on real cards
  frame: string; // data URI of the logo + ring artwork
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FONT = "'Poppins', 'DejaVu Sans', sans-serif";
const STYLE = `fill="url(#tg)" stroke="#ff2b1e" stroke-width="6" stroke-linejoin="round" paint-order="stroke" filter="url(#glow)"`;

/** 1672x941 sell card in the red "Total" style. Ring: centre (377,475), radius 269. */
export function buildCardSvg(d: CardData): string {
  const multSize = Math.max(110, Math.min(430, Math.floor(930 / (Math.max(d.multiplier.length, 1) * 0.66))));
  const symText = `$${d.symbol}`;
  const symSize = Math.max(40, Math.min(112, Math.floor(580 / (symText.length * 0.66))));
  const pnlText = `P&L ${d.pnl}`;
  const pnlSize = Math.max(34, Math.min(66, Math.floor(450 / (pnlText.length * 0.62))));
  const coin = d.coinImage
    ? `<clipPath id="c"><circle cx="377" cy="475" r="269"/></clipPath>
       <image href="${d.coinImage}" x="108" y="206" width="538" height="538" clip-path="url(#c)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="377" cy="475" r="269" fill="#fff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1672" height="941" viewBox="0 0 1672 941" font-family="${FONT}" font-weight="700">
  <defs>
    <filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="1672" height="941">
      <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6a1010"/><stop offset="0.5" stop-color="#1a0000"/><stop offset="1" stop-color="#4a0808"/>
    </linearGradient>
  </defs>
  <rect width="1672" height="941" fill="#121212"/>
  ${d.background ? `<image href="${d.background}" x="0" y="0" width="1672" height="941" preserveAspectRatio="xMidYMid slice"/><rect width="1672" height="941" fill="#000" opacity="0.45"/>` : ""}
  ${coin}
  ${d.character ? `<image href="${d.character}" x="1060" y="60" width="580" height="880" preserveAspectRatio="xMidYMax meet"/>` : ""}
  <image href="${d.frame}" x="0" y="0" width="720" height="770"/>
  ${d.symbol ? `<text x="377" y="868" font-size="${symSize}" text-anchor="middle" ${STYLE}>${esc(symText)}</text>` : ""}
  ${d.multiplier ? `<text x="730" y="640" font-size="${multSize}" ${STYLE}>${esc(d.multiplier)}</text>` : ""}
  ${d.pnl ? `<text x="745" y="752" font-size="${pnlSize}" ${STYLE}>${esc(pnlText)}</text>` : ""}
  ${d.username ? `<text x="1640" y="880" font-size="36" text-anchor="end" fill="#ffffff">@${esc(d.username)}</text>` : ""}
  <text x="1640" y="922" font-size="28" text-anchor="end" fill="#b0b0b0">${esc(d.tag)}</text>
</svg>`;
}
