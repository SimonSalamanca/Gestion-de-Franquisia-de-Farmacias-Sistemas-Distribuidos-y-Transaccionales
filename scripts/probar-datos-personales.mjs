import "./lib/owner.mjs";
// Guardia de datos personales (docs/seguridad/datos-personales.md). Recorre las salidas de la API que contienen datos
// de clientes o pacientes, con el cajero y con el administrador de tienda, y el central con el administrador general.
// Comprueba: (1) el cajero no recibe documento completo, teléfono ni correo; (2) el administrador sí recibe el documento
// completo donde corresponde; (3) ningún documento completo de la base aparece en el texto de una respuesta que no
// corresponde. Solo lectura: necesita el API de la tienda 1 levantado en el puerto 4000 y el central en la misma base.
import { local, central } from "../apps/api/db.mjs";
import { abrirDocumento } from "../apps/api/datos-personales.mjs";

const BASE = process.env.FARMAHUB_API_PRUEBA || "http://localhost:4000";
const fallos = [];
function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}

const J = (r) => r.json().catch(() => ({}));
async function login(nodo, usuario) {
  const r = await fetch(`${BASE}/api/${nodo}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ usuario, password: "Farma123" }),
  });
  return (await J(r)).token;
}
async function get(token, ruta) {
  const r = await fetch(`${BASE}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
  const texto = await r.text();
  let datos = {};
  try {
    datos = JSON.parse(texto);
  } catch {
    /* respuesta no JSON */
  }
  return { status: r.status, datos, texto };
}

// Documentos completos de la base de la tienda y el central: son los que no deben filtrarse.
const docs = new Set(
  (await local.query("select documento_cifrado from cliente where documento_cifrado is not null")).rows.map((r) => abrirDocumento(r.documento_cifrado)),
);

// Tabla cliente de la tienda: el documento no está en claro (solo enmascarado y cifrado).
const clienteEnClaro = await local.query("select count(*)::int as n from cliente where documento_identidad is not null and (documento_identidad !~ $1 or documento_cifrado is null or documento_hmac is null)", ["^[*]{4}.{1,4}$"]);
check("cliente de la tienda: sin documentos en claro", clienteEnClaro.rows[0].n === 0, `en claro=${clienteEnClaro.rows[0].n}`);

const cajero = await login("local", "cajero1");
const admin = await login("local", "admin.tienda");
const general = await login("central", "admin.general");
check("logins de cajero, administrador y administrador general", Boolean(cajero && admin && general));

const cliente = (await get(admin, "/api/local/historial/clientes?q=Paciente")).datos.clientes?.[0];
const factura = (await get(admin, "/api/local/historial/facturas?cliente=Paciente")).datos.facturas?.[0];
const receta = (await get(admin, "/api/local/recetas")).datos.recetas?.[0];
check("hay datos de paciente para probar (cliente, factura y receta)", Boolean(cliente && factura), `cliente=${Boolean(cliente)} factura=${Boolean(factura)} receta=${Boolean(receta)}`);

const rutas = [
  ["clientes (lista)", "/api/local/historial/clientes?q=Paciente"],
  ["cliente (detalle)", cliente ? `/api/local/historial/clientes/${cliente.id_cliente}` : null],
  ["facturas del cliente", "/api/local/historial/facturas?cliente=Paciente"],
  ["factura (detalle)", factura ? `/api/local/historial/facturas/${factura.id_factura}` : null],
  ["venta (detalle)", factura ? `/api/local/ventas/${factura.id_factura}` : null],
  ["recetas (lista)", "/api/local/recetas"],
  ["receta (detalle)", receta ? `/api/local/recetas/${receta.id_receta}` : null],
].filter(([, r]) => r);

const restringidos = /"(telefono|correo|paciente_telefono|paciente_correo)":\s*"[^"]+"/;
for (const [nombre, ruta] of rutas) {
  const c = await get(cajero, ruta);
  const a = await get(admin, ruta);
  check(`${nombre}: cajero responde 200`, c.status === 200, `status ${c.status}`);
  check(`${nombre}: administrador responde 200`, a.status === 200, `status ${a.status}`);
  check(`${nombre}: el cajero no recibe teléfono ni correo`, !restringidos.test(c.texto));
  const filtrado = [...docs].filter((d) => c.texto.includes(d));
  check(`${nombre}: ningún documento completo aparece en la respuesta del cajero`, filtrado.length === 0, filtrado.slice(0, 2).join(","));
}

// El administrador sí ve el documento completo del cliente en el detalle (si la matriz lo permite).
if (cliente) {
  const a = await get(admin, `/api/local/historial/clientes/${cliente.id_cliente}`);
  check("administrador: el detalle del cliente trae el documento completo", a.datos.documento === cliente.documento || [...docs].includes(a.datos.documento));
  const c = await get(cajero, `/api/local/historial/clientes/${cliente.id_cliente}`);
  check("cajero: el detalle del cliente trae el documento enmascarado", String(c.datos.documento ?? "").startsWith("****"), String(c.datos.documento));
}

// Auditoría (F3): la búsqueda de clientes del administrador deja registro; la del cajero, no (no ve documentos completos).
const contarVer = async () => Number((await local.query("select count(*)::int n from registro_actividad where accion = 'CLIENTE_DATOS_CONSULTAR'")).rows[0].n);
const antesAdmin = await contarVer();
await get(admin, "/api/local/historial/clientes?q=Paciente");
check("auditoría: la búsqueda de clientes del administrador deja registro", (await contarVer()) === antesAdmin + 1);
const antesCajero = await contarVer();
await get(cajero, "/api/local/historial/clientes?q=Paciente");
check("auditoría: la búsqueda del cajero no registra documento completo", (await contarVer()) === antesCajero);

// Central (F4): ninguna receta guarda el documento en claro; todas tienen su valor cifrado y su HMAC.
const cifrado = (await central.query("select count(*) filter (where documento_cifrado is null or documento_hmac is null)::int sin_cifrar, count(*) filter (where paciente_documento not like '****%')::int en_claro from receta_emitida")).rows[0];
check("central: ninguna receta guarda el documento en claro", cifrado.en_claro === 0, `en claro ${cifrado.en_claro}`);
check("central: todas las recetas tienen documento cifrado y HMAC", cifrado.sin_cifrar === 0, `sin cifrar ${cifrado.sin_cifrar}`);

// Consola de red: las recetas emitidas nunca muestran el documento completo, ni siquiera al administrador general.
const consola = await get(general, "/api/central/recetas-emitidas");
check("consola: responde 200", consola.status === 200, `status ${consola.status}`);
const enConsola = [...docs].filter((d) => consola.texto.includes(d));
check("consola: ningún documento completo en el listado de recetas emitidas", enConsola.length === 0, enConsola.slice(0, 2).join(","));

console.log(fallos.length ? `FALLOS ${fallos.length}\n${fallos.join("\n")}` : "TODO OK");
await local.end();
await central.end();
if (fallos.length) process.exit(1);
