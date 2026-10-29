import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const PEPPER_DEV = "farmahub-dev-pepper";

// Lee .env; las variables del proceso tienen prioridad sobre el archivo.
export function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) {
    throw new Error("Falta el archivo .env en la raíz del proyecto. Cópielo de .env.example y complete las cadenas de Neon.");
  }
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    env[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^"|"$/g, "");
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "si", "sí", "yes", "on"].includes(String(value).toLowerCase());
}

function entero(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} debe ser un entero positivo (valor: ${raw})`);
  return value;
}

function urlDe(env, nodo) {
  const url = env[`${nodo}_DATABASE_URL_UNPOOLED`] || env[`${nodo}_DATABASE_URL`];
  if (!url || url.includes("USER:PASSWORD")) {
    throw new Error(`Falta ${nodo}_DATABASE_URL en .env (o aún tiene el valor de ejemplo).`);
  }
  return url;
}

const env = loadEnv();
const produccion = env.NODE_ENV === "production";

export const config = {
  produccion,
  port: entero(env, "PORT", 4000),
  // Identidad del nodo local: la tienda a la que pertenece esta instalación.
  tiendaId: entero(env, "LOCAL_TIENDA_ID", 1),
  centralUrl: urlDe(env, "CENTRAL"),
  localUrl: urlDe(env, "LOCAL"),
  pepper: env.AUTH_PEPPER || PEPPER_DEV,
  corsOrigins: (env.CORS_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  // Endpoint /api/conectividad/simular: herramienta de demo, nunca en producción por defecto.
  simulacion: bool(env.FARMAHUB_SIMULACION, !produccion),
  // Usuarios y tienda de demostración (contraseña conocida).
  seedDemo: bool(env.SEED_DEMO, !produccion),
  syncIntervaloMs: entero(env, "SYNC_INTERVALO_MS", 10000),
  syncLote: entero(env, "SYNC_LOTE", 500),
};

export const avisos = [];
if (config.pepper === PEPPER_DEV) {
  if (produccion) throw new Error("AUTH_PEPPER es obligatorio en producción.");
  avisos.push("AUTH_PEPPER no está definido: se usa el valor de desarrollo.");
}
if (produccion && config.seedDemo) avisos.push("SEED_DEMO activo en producción: hay cuentas con contraseña conocida.");
if (config.simulacion) avisos.push("Simulación de conectividad habilitada (FARMAHUB_SIMULACION).");
