// Prueba de la aplicación en ejecución con su rol de solo datos (docs/seguridad/datos-personales.md, fase 5). Necesita el
// API de la tienda 1 levantado en el puerto 4000 (que ya usa el rol farmahub_datos) y la conexión del rol en .env.
// Recorre operaciones de lectura y de escritura por HTTP y comprueba que el rol no puede tocar la auditoría ni el esquema.
import pg from "pg";
import fs from "node:fs";

const BASE = process.env.FARMAHUB_API_PRUEBA || "http://localhost:4000";
const fallos = [];
function check(nombre, ok, detalle = "") {
  if (!ok) fallos.push(`${nombre}${detalle ? `: ${detalle}` : ""}`);
  console.log(ok ? "OK" : "FALLO", nombre, detalle);
}
const J = (r) => r.json().catch(() => ({}));
const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split(/\r?\n/).filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
  }),
);

async function login(usuario) {
  const r = await fetch(`${BASE}/api/local/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ usuario, password: "Farma123" }),
  });
  return (await J(r)).token;
}
const pedir = async (token, ruta, { method = "GET", body } = {}) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, datos: await J(r) };
};

const cajero = await login("cajero1");
const admin = await login("admin.tienda");
check("login de cajero y administrador con el rol de datos", Boolean(cajero && admin));

// Lectura: los módulos principales responden sin error interno.
for (const [nombre, ruta] of [
  ["inventario", "/api/local/inventario/buscar?q=ibu"],
  ["precios", "/api/local/precios?q=ibu"],
  ["historial de clientes", "/api/local/historial/clientes?q=Paciente"],
  ["estado de caja", "/api/local/caja/estado"],
  ["alertas", "/api/local/alertas"],
]) {
  const r = await pedir(cajero, ruta);
  check(`lectura: ${nombre} responde`, r.status === 200, `status ${r.status}`);
}
const resumen = await pedir(admin, "/api/local/caja/resumen");
check("lectura: resumen de caja (administrador) responde", resumen.status === 200, `status ${resumen.status}`);

// Escritura: una venta real de una unidad (el rol puede insertar facturas, líneas, pagos y movimientos).
const stock = await pedir(cajero, "/api/local/inventario/buscar?q=ibu");
const med = stock.datos.resultados?.find((m) => m.stock_tienda >= 2);
if (med) {
  const metodos = (await pedir(cajero, "/api/local/ventas/metodos-pago")).datos.metodos;
  const efectivo = metodos.find((m) => m.nombre === "efectivo");
  const calculo = await pedir(cajero, "/api/local/ventas/calcular", { method: "POST", body: { lineas: [{ id_medicamento: med.id_medicamento, cantidad: 1 }] } });
  check("escritura: vista previa de venta", calculo.status === 200 && calculo.datos.puede_vender === true, `status ${calculo.status}`);
  const venta = await pedir(cajero, "/api/local/ventas", {
    method: "POST",
    body: { lineas: [{ id_medicamento: med.id_medicamento, cantidad: 1 }], pagos: [{ id_metodo_pago: efectivo.id_metodo_pago, monto: calculo.datos.total }] },
  });
  check("escritura: venta registrada (factura y movimiento)", venta.status === 201, `status ${venta.status} ${venta.datos.mensaje ?? venta.datos.codigo ?? ""}`);
} else {
  check("escritura: hay stock para la venta de prueba", false, "ningún medicamento con 2 o más unidades");
}

// Auditoría: el rol de datos puede escribir auditoría pero no alterarla ni borrarla.
const ruta = (fs.existsSync(".env") && env.LOCAL_DATABASE_URL_UNPOOLED_APP) || null;
if (ruta) {
  const c = new pg.Client({ connectionString: ruta, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const intento = async (sql) => {
    try {
      await c.query(sql);
      return "permitido";
    } catch (e) {
      return e.code;
    }
  };
  check("auditoría: no se puede alterar", (await intento("update registro_actividad set detalle = 'x' where false")) === "42501");
  check("auditoría: no se puede borrar", (await intento("delete from registro_actividad where false")) === "42501");
  check("esquema: no se puede crear ni alterar tablas", (await intento("create table prueba_rol_x (x int)")) === "42501" && (await intento("alter table lote add column prueba_rol_x int")) === "42501");
  check("esquema: no se puede truncar", (await intento("truncate lote")) === "42501");
  await c.end();
} else {
  check("el rol de datos está en .env", false);
}

console.log(fallos.length ? `FALLOS ${fallos.length}\n${fallos.join("\n")}` : "TODO OK");
if (fallos.length) process.exit(1);
