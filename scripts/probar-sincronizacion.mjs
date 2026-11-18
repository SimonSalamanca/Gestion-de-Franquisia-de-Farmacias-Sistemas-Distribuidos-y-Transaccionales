import "./lib/owner.mjs";
// Prueba de punta a punta del flujo de stock entre el nodo local de la tienda y el nodo central
// (HU-01 criterio 4, HU-02 y RNF-04): un movimiento en la tienda llega a medicamento_tienda por el
// ciclo real de sincronización del API, y lo hecho sin conexión llega al reconectar.
// Requiere el API del nodo local corriendo (npm run api) con FARMAHUB_SIMULACION activo, apuntado a las MISMAS bases que
// este script: antes de escribir se comprueba que la sesión abierta por el API exista en la base local de esta configuración.
// ESCRIBE lotes y ajustes: ejecutar contra bases de prueba, nunca contra la base principal.
//   API_URL=http://127.0.0.1:4000  USUARIO=admin.tienda  PASSWORD=Farma123  MEDICAMENTO=MED-002
import { config } from "../apps/api/config.mjs";

if ([config.centralUrl, config.localUrl].some((url) => url.includes("neon.tech")) && process.env.PERMITIR_NEON !== "1") {
  console.error("Las bases del .env son de Neon. Use bases de prueba, o PERMITIR_NEON=1 si apuntan a una rama de prueba de Neon.");
  process.exit(2);
}

const { central, local } = await import("../apps/api/db.mjs");
const { createHash } = await import("crypto");
const API = process.env.API_URL || "http://127.0.0.1:4000";
const CODIGO = process.env.MEDICAMENTO || "MED-002";
// HU-01 "Actualización continua": ciclo de outbox (10 s) + refresco del POS (5 s).
const LIMITE_MS = 15000;

const fallos = [];
function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method === "POST") headers["Idempotency-Key"] = crypto.randomUUID();
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const sesion = await api("/api/local/auth/login", {
  method: "POST",
  body: { usuario: process.env.USUARIO || "admin.tienda", password: process.env.PASSWORD || "Farma123" },
});
if (sesion.status !== 200) {
  console.error(`No se pudo iniciar sesión en ${API}: ${sesion.status} ${sesion.data.mensaje || ""}`);
  process.exit(2);
}
const token = sesion.data.token;
// Candado: el API de API_URL puede estar conectado a otra base (p. ej. un "npm run dev" contra Neon en el puerto 4000)
// aunque este script apunte a bases de prueba. Su login crea la sesión en SU base local: si no está en la nuestra, se
// aborta antes de escribir lotes o ajustes.
const hashSesion = createHash("sha256").update(token).digest("hex");
if ((await local.query("select 1 from sesion_activa where token_hash = $1", [hashSesion])).rowCount !== 1) {
  console.error(`El API de ${API} no usa la base local de esta configuración: se aborta sin escribir. Indique API_URL del API de prueba.`);
  await Promise.allSettled([central.end(), local.end()]);
  process.exit(2);
}
const idTienda = (await api("/api/local/inventario/tiendas", { token })).data.find((t) => t.propia).id_tienda;
const med = (await api(`/api/local/inventario/buscar?q=${CODIGO}`, { token })).data.resultados.find((m) => m.codigo_interno === CODIGO);
check(`medicamento ${CODIGO} en el catálogo local`, med != null);

const stockLocal = async () =>
  (await api(`/api/local/inventario/buscar?q=${CODIGO}`, { token })).data.resultados.find((m) => m.id_medicamento === med.id_medicamento).stock_tienda;
const enCentral = async () =>
  (
    await central.query(
      "select cantidad_disponible, fecha_sincronizacion from medicamento_tienda where id_tienda = $1 and id_medicamento = $2 and fecha_sincronizacion is not null",
      [idTienda, med.id_medicamento],
    )
  ).rows[0];

// Espera a que el central tenga el stock esperado de la tienda; devuelve los ms que tardó o null.
async function esperarCentral(esperado, limite = LIMITE_MS) {
  const inicio = Date.now();
  while (Date.now() - inicio <= limite) {
    if (Number((await enCentral())?.cantidad_disponible) === esperado) return Date.now() - inicio;
    await esperar(500);
  }
  return null;
}
const duracion = (ms, stock) => (ms != null ? `${(ms / 1000).toFixed(1)} s, stock ${stock}` : "no llegó");

async function registrarLote(cantidad) {
  const proveedor = (await api("/api/local/proveedores", { token })).data[0].id_proveedor;
  const caducidad = new Date(Date.now() + 300 * 864e5).toISOString().slice(0, 10);
  return api("/api/local/lotes", {
    method: "POST",
    token,
    body: { id_medicamento: med.id_medicamento, id_proveedor: proveedor, numero_lote: `SYNC-${Date.now().toString(36)}`, fecha_caducidad: caducidad, cantidad },
  });
}

try {
  // 1. Entrada en la tienda → consolidado del central.
  const lote = await registrarLote(25);
  check("la tienda registra un lote de 25", lote.status === 201, String(lote.status));
  let stock = await stockLocal();
  let ms = await esperarCentral(stock);
  check(`la entrada llega al central en ≤ ${LIMITE_MS / 1000} s`, ms != null, duracion(ms, stock));
  const fila = await enCentral();
  check("el central guarda la hora del cálculo de la tienda", fila?.fecha_sincronizacion && Date.now() - new Date(fila.fecha_sincronizacion).getTime() < 60000);

  // 2. Ajuste en la tienda → baja en el central.
  const ajuste = await api(`/api/local/lotes/${lote.data.id_lote}/ajustes`, {
    method: "POST",
    token,
    body: { sentido: "RESTA", cantidad: 5, motivo: "prueba de sincronización con el central" },
  });
  check("la tienda ajusta -5", ajuste.status === 200, String(ajuste.status));
  stock = await stockLocal();
  ms = await esperarCentral(stock);
  check("el ajuste llega al central", ms != null, duracion(ms, stock));

  // 3. Sin conexión: la tienda sigue operando, el central no cambia y recibe todo al reconectar (RNF-04).
  // Demostración de conectividad (docs/operacion/demostracion-conectividad.md): «Central caído» con sesión de administrador.
  const caida = await api("/api/local/simulacion", { method: "POST", token, body: { escenario: "caido" } });
  check("el nodo local queda offline", caida.data.conectividad?.estado_real === "offline", caida.status === 404 ? "FARMAHUB_SIMULACION desactivado" : String(caida.status));
  const offline = await registrarLote(4);
  check("la tienda registra un lote sin conexión", offline.status === 201);
  const stockOffline = await stockLocal();
  await esperar(12000); // más que un ciclo de sincronización
  check("mientras está offline el central conserva el dato anterior", Number((await enCentral())?.cantidad_disponible) === stock);
  check("offline: la búsqueda local sigue", (await api(`/api/local/inventario/buscar?q=${CODIGO}`, { token })).status === 200);
  check("offline: la consulta de la red responde 503", (await api(`/api/local/inventario/red/${med.id_medicamento}`, { token })).status === 503);
} finally {
  await api("/api/local/simulacion", { method: "POST", token, body: { restablecer: true } });
}
const stockFinal = await stockLocal();
const ms = await esperarCentral(stockFinal);
check("al reconectar, el central recibe lo hecho offline", ms != null, duracion(ms, stockFinal));

console.log(fallos.length ? `\n${fallos.length} FALLO(S)\n- ${fallos.join("\n- ")}` : "\nTODO OK");
await Promise.allSettled([central.end(), local.end()]);
process.exit(fallos.length ? 1 : 0);
