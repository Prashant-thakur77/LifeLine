import { loadFont as archivo } from "@remotion/google-fonts/Archivo";
import { loadFont as plexMono } from "@remotion/google-fonts/IBMPlexMono";
import { film } from "./film";

// Lifeline's own type and palette (apps/web/src/app/globals.css): Archivo for display, IBM Plex Mono for readouts.
const display = archivo("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"] });
const code = plexMono("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });

/** Site palette. The older key names are kept so the shared components read the same slots. */
export const P = {
  paper: "#fff7ea", paper2: "#fbeedb", paper3: "#f2e6d1",
  ink: "#0b1533", ink2: "#24305a", ink3: "#5e6684",
  carbon: "#1d4bff", carbonSoft: "#8fb0ff", seaDeep: "#0e2fb3", seaLight: "#b7ccff",
  stamp: "#ff5a1f", stampText: "#c2410c", stampOnInk: "#ff7a45",
  flag: "#9a5b00", flagBg: "#fff1c9", ok: "#08805f", okBright: "#19c79a", flap: "#0b1533", mark: "#ffc93c",
  danger: "#e5243b", night: "#0a1230",
};

export const T = {
  ...film.theme,
  font: display.fontFamily,
  monoFont: code.fontFamily,
  hindiFont: display.fontFamily,
  h1: 112, h2: 76, h3: 52, body: 40, small: 30, label: 26,
  safeX: 96, safeY: 84,
};
