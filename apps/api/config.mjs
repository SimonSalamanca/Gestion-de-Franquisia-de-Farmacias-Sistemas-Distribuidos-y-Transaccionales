import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const PEPPER_DEV = "farmahub-dev-pepper";
const DATOS_DEV = "farmahub-dev-datos-personales-no-usar-en-produccion";

// Lee .env; las variables del proceso tienen prioridad sobre el archivo. En el hosting (Render) no hay .env: las
// variables llegan por el entorno. Si tampoco están ahí, urlDe avisa qué conexión falta.
export function loadEnv() {
  const file = path.join(ROOT, ".env");
  const env = {};
  const lineas = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  if (!lineas.length && !process.env.CENTRAL_DATABASE_URL && !process.env.CENTRAL_DATABASE_URL_UNPOOLED) {
    throw new Error(
      "Falta la configuración: cree el archivo .env en la raíz del proyecto (cópielo de .env.example y complete las cadenas de Neon) o defina las variables de entorno.",
    );
  }
  for (const line of lineas) {
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

// Rol de aplicación (datos sin DDL, docs/seguridad/datos-personales.md, fase 5). Si no está configurado, la aplicación usa la
// misma conexión que las migraciones (compatibilidad con bases ya existentes).
// Lee una cadena de conexión: quita espacios y comillas que suelen colarse al pegarla en un panel (Render) y comprueba
// que sea una URL postgres(ql)://… con host. Si no, dice qué variable está mal sin mostrar su valor (lleva la contraseña).
// Sin esta revisión, pg toma un valor inválido como relativo y falla con "getaddrinfo ENOTFOUND base".
function urlValida(env, clave) {
  const cruda = env[clave];
  if (cruda === undefined || cruda === "") return null;
  const url = String(cruda).trim().replace(/^["']+|["']+$/g, "").trim();
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol === "postgres:" || u.protocol === "postgresql:") host = u.hostname;
  } catch {
    /* no es una URL */
  }
  if (!host) {
    const pista = url.includes("=") && !url.startsWith("postgres") ? " (¿se pegó también el nombre de la variable?)" : "";
    throw new Error(`${clave} no es una cadena de conexión válida: debe empezar con postgresql://usuario:clave@host/base${pista}.`);
  }
  return url;
}

function urlAppDe(env, nodo, respaldo) {
  return urlValida(env, `${nodo}_DATABASE_URL_UNPOOLED_APP`) || urlValida(env, `${nodo}_DATABASE_URL_APP`) || respaldo;
}

function urlDe(env, nodo) {
  const url = urlValida(env, `${nodo}_DATABASE_URL_UNPOOLED`) || urlValida(env, `${nodo}_DATABASE_URL`);
  if (!url || url.includes("USER:PASSWORD")) {
    throw new Error(`Falta ${nodo}_DATABASE_URL en .env o en las variables de entorno (o aún tiene el valor de ejemplo).`);
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
  // Migraciones y mantenimiento: dueño de la base (DDL). Aplicación: rol de solo datos, si está configurado.
  centralAppUrl: urlAppDe(env, "CENTRAL", urlDe(env, "CENTRAL")),
  localAppUrl: urlAppDe(env, "LOCAL", urlDe(env, "LOCAL")),
  pepper: env.AUTH_PEPPER || PEPPER_DEV,
  // Clave de cifrado del documento de los pacientes en el central (docs/seguridad/datos-personales.md). Si se pierde, los
  // documentos cifrados no se pueden recuperar.
  datosClave: env.DATOS_CLAVE || DATOS_DEV,
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
  // HU-16: cada cuánto la tienda envía la foto completa de su stock (consolidación periódica y latido), y desde cuántos
  // minutos sin foto la vista de red marca a una tienda como desactualizada.
  consolidacionIntervaloMs: entero(env, "CONSOLIDACION_INTERVALO_MS", 120000),
  consolidadoMaxRetrasoMin: entero(env, "CONSOLIDADO_MAX_RETRASO_MIN", 5),
};

export const avisos = [];
if (config.pepper === PEPPER_DEV) {
  if (produccion) throw new Error("AUTH_PEPPER es obligatorio en producción.");
  avisos.push("AUTH_PEPPER no está definido: se usa el valor de desarrollo.");
}
if (config.datosClave === DATOS_DEV) {
  if (produccion) throw new Error("DATOS_CLAVE es obligatoria en producción.");
  avisos.push("DATOS_CLAVE no está definida: se usa la clave de desarrollo.");
}
if (produccion && config.seedDemo) avisos.push("SEED_DEMO activo en producción: hay cuentas con contraseña conocida.");
if (config.simulacion) avisos.push("Simulación de conectividad habilitada (FARMAHUB_SIMULACION).");
