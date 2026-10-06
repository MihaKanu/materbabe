export interface CardData {
  title: string; // unused: the logo is part of the frame artwork
  symbol: string;
  multiplier: string; // e.g. "156x"; empty = leave blank
  pnl: string; // USD, e.g. "+$156,343"; empty = leave blank
  profit: boolean;
  profitSol?: string; // e.g. "+134.03" (green/red banner, top right)
  initialBuy?: string; // SOL spent, e.g. "2.3"
  labels: { pnl: string; initial: string };
  coinImage?: string; // data URI
  character?: string; // data URI
  background?: string; // data URI; omitted = plain grey
  username?: string;
  bannerWidth?: number; // measured width of the banner number
  initWidth?: number; // measured width of the "Initial Buy" text
  tag: string; // "EXAMPLE" on /larp cards, the bot link on real cards
  frame: string; // data URI of the logo + ring artwork
}

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const FONT = "'Poppins', 'Noto Sans', 'Noto Sans SC', 'Noto Sans Arabic', 'DejaVu Sans', sans-serif";
const STYLE = `fill="url(#tg)" stroke="#ff2b1e" stroke-width="6" stroke-linejoin="round" paint-order="stroke" filter="url(#glow)"`;
const STYLE_SMALL = `fill="url(#tg)" stroke="#ff2b1e" stroke-width="4" stroke-linejoin="round" paint-order="stroke" filter="url(#glow)"`;

export const bannerSize = (t: string): number => Math.max(70, Math.min(200, Math.floor(620 / (Math.max(t.length, 1) * 0.42))));
const BANNER_FONT = "'Bebas Neue', 'Poppins', 'DejaVu Sans', sans-serif";

const solLogo = (cx: number, cy: number, r: number): string =>
  `<g transform="translate(${cx} ${cy}) scale(${r / 58})"><circle r="58" fill="#0b0b14"/><g fill="url(#sg)"><path d="M-18 -27 L36 -27 L26 -16 L-28 -16 Z"/><path d="M-28 -5 L26 -5 L36 6 L-18 6 Z"/><path d="M-18 17 L36 17 L26 28 L-28 28 Z"/></g></g>`;

/** 1672x941 sell card, red "Total" style. Ring: centre (377,475), radius 269. */
export function buildCardSvg(d: CardData): string {
  const multSize = Math.max(110, Math.min(430, Math.floor(930 / (Math.max(d.multiplier.length, 1) * 0.66))));
  const symText = `$${d.symbol}`;
  const symSize = Math.max(40, Math.min(112, Math.floor(580 / (symText.length * 0.66))));
  const pnlText = `${d.labels.pnl} ${d.pnl}`;
  const pnlSize = Math.max(34, Math.min(66, Math.floor(450 / (pnlText.length * 0.62))));
  const initText = d.initialBuy ? `${d.labels.initial}: ${d.initialBuy}` : "";
  const initSize = 40;
  const initEnd = 745 + (d.initWidth ?? Math.round(initText.length * 0.44 * initSize));
  const coin = d.coinImage
    ? `<clipPath id="c"><circle cx="377" cy="475" r="269"/></clipPath>
       <image href="${d.coinImage}" x="108" y="206" width="538" height="538" clip-path="url(#c)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="377" cy="475" r="269" fill="#fff"/>`;
  const bs = d.profitSol ? bannerSize(d.profitSol) : 0;
  const bw = d.bannerWidth ?? Math.round((d.profitSol?.length ?? 0) * 0.42 * bs);
  const banner = d.profitSol
    ? `<rect x="766" y="80" width="906" height="204" fill="${d.profit ? "#2fb300" : "#c0302b"}"/>
       <text x="812" y="${182 + Math.round(bs * 0.35)}" font-family="${BANNER_FONT}" font-weight="700" font-size="${bs}" fill="${d.profit ? "#d5f7c4" : "#ffd9d6"}">${esc(d.profitSol)}</text>
       ${solLogo(Math.min(1580, 812 + bw + 100), 182, 58)}`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1672" height="941" viewBox="0 0 1672 941" font-family="${FONT}" font-weight="700">
  <defs>
    <filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="1672" height="941">
      <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6a1010"/><stop offset="0.5" stop-color="#1a0000"/><stop offset="1" stop-color="#4a0808"/>
    </linearGradient>
    <linearGradient id="sg" gradientUnits="userSpaceOnUse" x1="-30" y1="28" x2="36" y2="-27">
      <stop offset="0" stop-color="#14f195"/><stop offset="1" stop-color="#9945ff"/>
    </linearGradient>
  </defs>
  <rect width="1672" height="941" fill="#121212"/>
  ${d.background ? `<image href="${d.background}" x="0" y="0" width="1672" height="941" preserveAspectRatio="xMidYMid slice"/>` : ""}
  <g opacity="${d.background ? 0.8 : 1}">
  ${coin}
  ${d.character ? `<image href="${d.character}" x="1060" y="300" width="580" height="640" preserveAspectRatio="xMidYMax meet"/>` : ""}
  <image href="${d.frame}" x="0" y="0" width="720" height="770"/>
  ${banner}
  ${d.symbol ? `<text x="377" y="868" font-size="${symSize}" text-anchor="middle" ${STYLE}>${esc(symText)}</text>` : ""}
  ${d.multiplier ? `<text x="730" y="640" font-size="${multSize}" ${STYLE}>${esc(d.multiplier)}</text>` : ""}
  ${d.pnl ? `<text x="745" y="752" font-size="${pnlSize}" ${STYLE}>${esc(pnlText)}</text>` : ""}
  ${initText ? `<text x="745" y="812" font-size="${initSize}" ${STYLE_SMALL}>${esc(initText)}</text>${solLogo(initEnd + 32, 798, 17)}` : ""}
  ${d.username ? `<text x="1640" y="880" font-size="36" text-anchor="end" fill="#ffffff">@${esc(d.username)}</text>` : ""}
  <text x="1640" y="922" font-size="28" text-anchor="end" fill="#b0b0b0">${esc(d.tag)}</text>
  </g>
</svg>`;
}
