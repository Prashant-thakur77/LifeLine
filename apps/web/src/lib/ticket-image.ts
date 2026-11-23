import { ROLE_LABEL, WANT_LABEL, type Draft } from "./waitlist";

/** Draws the boarding pass as a PNG. It carries the name and the berth, never the email or the story. */
export async function ticketPng(draft: Draft, berth: string): Promise<Blob> {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 675;
  const g = canvas.getContext("2d")!;
  const family = getComputedStyle(document.body).fontFamily;
  const ink = "#0b1533";
  const fit = (text: string, size: number, width: number, weight = 900) => {
    let px = size;
    do g.font = `${weight} ${px}px ${family}`;
    while (g.measureText(text).width > width && (px -= 4) > 20);
  };
  g.fillStyle = "#ff5a1f";
  g.fillRect(0, 0, 1200, 675);
  g.fillStyle = "#fffcf5";
  g.strokeStyle = ink;
  g.lineWidth = 6;
  g.beginPath();
  g.roundRect(60, 60, 1080, 555, 20);
  g.fill();
  g.stroke();
  g.fillStyle = "#ffc93c";
  g.fillRect(63, 63, 1074, 84);
  g.fillStyle = ink;
  g.font = `900 46px ${family}`;
  g.fillText("LIFELINE · BOARDING PASS", 96, 122);
  g.font = `600 26px ${family}`;
  g.fillText("PASSENGER", 96, 208);
  fit(draft.name, 76, 640);
  g.fillText(draft.name, 96, 280);
  g.font = `600 26px ${family}`;
  g.fillText(draft.role === null ? "" : ROLE_LABEL[draft.role], 96, 330);
  const wants = draft.wants.slice(0, 3).map((w) => WANT_LABEL[w]);
  wants.forEach((want, i) => g.fillText(`· ${want}`, 96, 392 + i * 40));
  g.setLineDash([10, 12]);
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(780, 150);
  g.lineTo(780, 612);
  g.stroke();
  g.setLineDash([]);
  g.fillText("BERTH", 826, 208);
  fit(berth, 78, 290);
  g.fillText(berth, 826, 286);
  for (const [r, w, c] of [[90, 46, "#fffcf5"], [114, 5, ink], [66, 5, ink]] as const) {
    g.beginPath();
    g.strokeStyle = c;
    g.lineWidth = w;
    g.arc(960, 440, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.strokeStyle = "#ff5a1f";
  g.lineWidth = 44;
  for (let i = 0; i < 4; i += 1) {
    g.beginPath();
    g.arc(960, 440, 90, (i * Math.PI) / 2 - 0.39, (i * Math.PI) / 2 + 0.39);
    g.stroke();
  }
  g.fillStyle = ink;
  g.font = `600 24px ${family}`;
  g.fillText("lifeline.prashantthakur.dev", 96, 580);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"));
}
