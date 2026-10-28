import { central, local, withTx } from "./db.mjs";
import { registrarLote } from "./inventario/lotes.mjs";

// Datos de demostración del sprint 1 (SEED_DEMO). Son datos, no estructura, y todo es idempotente.
// En el sprint 1 no hay historias de alta de catálogo, pedidos ni ventas: esto permite demostrar HU-01 y HU-02.

const CATEGORIAS = ["Analgésicos", "Antibióticos", "Antihipertensivos", "Antidiabéticos", "Antialérgicos", "Gastrointestinales", "Biológicos"];

// [código, nombre comercial, principio activo, categoría, receta, refrigeración]
const MEDICAMENTOS = [
  ["MED-001", "Acetaminofén 500 mg", "Paracetamol", "Analgésicos", false, false],
  ["MED-002", "Ibuprofeno 400 mg", "Ibuprofeno", "Analgésicos", false, false],
  ["MED-003", "Acetaminofén Forte 500/65 mg", "Paracetamol + cafeína", "Analgésicos", false, false],
  ["MED-004", "Amoxicilina 500 mg", "Amoxicilina", "Antibióticos", true, false],
  ["MED-005", "Azitromicina 500 mg", "Azitromicina", "Antibióticos", true, false],
  ["MED-006", "Losartán 50 mg", "Losartán potásico", "Antihipertensivos", true, false],
  ["MED-007", "Enalapril 20 mg", "Enalapril maleato", "Antihipertensivos", true, false],
  ["MED-008", "Insulina NPH 100 UI/ml", "Insulina humana isófana", "Antidiabéticos", true, true],
  ["MED-009", "Metformina 850 mg", "Metformina clorhidrato", "Antidiabéticos", true, false],
  ["MED-010", "Loratadina 10 mg", "Loratadina", "Antialérgicos", false, false],
  ["MED-011", "Omeprazol 20 mg", "Omeprazol", "Gastrointestinales", false, false],
  ["MED-012", "Vacuna contra la influenza", "Virus de influenza inactivado", "Biológicos", true, true],
];

// [nombre, NIT, teléfono]
const PROVEEDORES = [
  ["Distribuidora Andina S.A.S.", "900100200-1", "6015550201"],
  ["Laboratorios del Valle Ltda.", "900300400-2", "6025550302"],
  ["MediSur Logística S.A.S.", "900500600-3", "6015550403"],
];

const TIENDA_RED = { nombre: "Farmacia Norte", direccion: "Calle 140 #15-30", ciudad: "Bogotá", telefono: "6015550111" };

// Umbrales de stock mínimo por tienda: [código, stock_minimo, dias_alerta_caducidad]
const UMBRALES_PROPIA = [
  ["MED-001", 20, 30],
  ["MED-004", 10, 30],
  ["MED-008", 5, 15],
  ["MED-010", 15, 30],
];
const UMBRALES_RED = [["MED-005", 5, 30]];

// Stock reportado por la tienda de la red: [código, cantidad]
const STOCK_RED = [
  ["MED-001", 64],
  ["MED-002", 12],
  ["MED-005", 18],
  ["MED-008", 9],
  ["MED-010", 40],
  ["MED-012", 6],
];

// Lotes iniciales de la tienda propia: [código, número de lote, proveedor (índice), días para vencer, cantidad]
const LOTES_PROPIA = [
  ["MED-001", "AC-2401", 0, 400, 40],
  ["MED-001", "AC-2398", 0, 20, 15],
  ["MED-002", "IB-1102", 1, 300, 60],
  ["MED-003", "AF-0777", 1, 250, 25],
  ["MED-004", "AM-5530", 2, 180, 8],
  ["MED-006", "LO-3021", 2, 365, 30],
  ["MED-008", "IN-0091", 0, 90, 4],
  ["MED-009", "ME-8812", 1, 500, 50],
  ["MED-011", "OM-2210", 2, 420, 35],
];

// Pedido pendiente para demostrar la recepción: [código, cantidad solicitada]
const PEDIDO_DEMO = [
  ["MED-010", 30],
  ["MED-005", 20],
];

async function idsPorCodigo(client, tabla) {
  const result = await client.query(`select id_medicamento, codigo_interno from ${tabla}`);
  return new Map(result.rows.map((row) => [row.codigo_interno, row.id_medicamento]));
}

// Nodo central, paso 1: catálogo y proveedores. migrate publica después los MEDICAMENTO_UPSERT, antes de
// que el paso 2 publique umbrales que dependen de ellos (el nodo local los aplica en ese orden).
export async function seedCatalogoDemo() {
  await withTx(central, async (client) => {
    for (const nombre of CATEGORIAS) {
      await client.query(
        "insert into categoria (nombre) values ($1) on conflict (nombre) do nothing",
        [nombre],
      );
    }
    const categorias = new Map(
      (await client.query("select id_categoria, nombre from categoria")).rows.map((row) => [row.nombre, row.id_categoria]),
    );
    for (const [codigo, nombre, principio, categoria, receta, refrigeracion] of MEDICAMENTOS) {
      await client.query(
        `insert into medicamento (codigo_interno, nombre_comercial, principio_activo, id_categoria, requiere_receta, requiere_refrigeracion)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (codigo_interno) do nothing`,
        [codigo, nombre, principio, categorias.get(categoria), receta, refrigeracion],
      );
    }
    for (const [nombre, nit, telefono] of PROVEEDORES) {
      await client.query(
        "insert into proveedor (nombre_empresa, nit, telefono) values ($1, $2, $3) on conflict (nit) do nothing",
        [nombre, nit, telefono],
      );
    }
  });
}

// Nodo central, paso 2: una segunda tienda con stock consolidado y umbrales de ambas tiendas.
export async function seedRedDemo(idTienda) {
  await withTx(central, async (client) => {
    const red = await client.query(
      `insert into tienda (nombre, direccion, ciudad, telefono, activa)
       select $1::varchar, $2::varchar, $3::varchar, $4::varchar, true
       where not exists (select 1 from tienda where nombre = $1::varchar)
       returning id_tienda, nombre, activa`,
      [TIENDA_RED.nombre, TIENDA_RED.direccion, TIENDA_RED.ciudad, TIENDA_RED.telefono],
    );
    if (red.rowCount > 0) {
      await client.query("select append_replica_evento(null, 'TIENDA_UPSERT', 1, $1::jsonb)", [JSON.stringify(red.rows[0])]);
    }
    const idRed = (await client.query("select id_tienda from tienda where nombre = $1", [TIENDA_RED.nombre])).rows[0].id_tienda;
    const medicamentos = await idsPorCodigo(client, "medicamento");

    const umbrales = [
      ...UMBRALES_PROPIA.map((umbral) => [idTienda, ...umbral]),
      ...UMBRALES_RED.map((umbral) => [idRed, ...umbral]),
    ];
    for (const [tienda, codigo, minimo, dias] of umbrales) {
      const idMedicamento = medicamentos.get(codigo);
      const nuevo = await client.query(
        `insert into umbral_stock (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad)
         values ($1, $2, $3, $4) on conflict do nothing`,
        [tienda, idMedicamento, minimo, dias],
      );
      // Mismo evento que publica HU-15 al configurar un umbral.
      if (nuevo.rowCount > 0) {
        await client.query("select append_replica_evento($1, 'UMBRAL_UPSERT', 1, $2::jsonb)", [
          tienda,
          JSON.stringify({ id_tienda: tienda, id_medicamento: idMedicamento, stock_minimo: minimo, dias_alerta_caducidad: dias }),
        ]);
      }
    }

    // La tienda de la red no tiene nodo propio en la demo: su stock consolidado se siembra directo.
    for (const [codigo, cantidad] of STOCK_RED) {
      await client.query(
        `insert into inventario_consolidado (id_tienda, id_medicamento, cantidad_disponible, fecha_sincronizacion)
         values ($1, $2, $3, now() at time zone 'UTC')
         on conflict (id_tienda, id_medicamento) do nothing`,
        [idRed, medicamentos.get(codigo), cantidad],
      );
    }
  });
}

// Nodo local, después del primer pull (necesita catálogo, proveedores y empleados replicados).
export async function seedLocalDemo(idTienda) {
  const listo = await local.query(
    `select (select count(*) from lote)::int as lotes,
            (select count(*) from medicamento_ref)::int as medicamentos,
            (select count(*) from proveedor_ref)::int as proveedores,
            (select id_empleado from empleado_ref where usuario = 'admin.tienda' and id_tienda = $1) as admin`,
    [idTienda],
  );
  const { lotes, medicamentos, proveedores, admin } = listo.rows[0];
  if (lotes > 0 || medicamentos === 0 || proveedores === 0 || !admin) return false;

  const proveedorIds = (await local.query("select id_proveedor from proveedor_ref order by id_proveedor")).rows.map((row) => row.id_proveedor);
  const ids = await idsPorCodigo(local, "medicamento_ref");
  const ctx = { idEmpleado: admin, idTienda };

  await withTx(local, async (client) => {
    for (const [codigo, numero, proveedor, dias, cantidad] of LOTES_PROPIA) {
      if (!ids.has(codigo)) continue;
      const fecha = (await client.query("select (current_date + $1::int)::text as fecha", [dias])).rows[0].fecha;
      await registrarLote(
        client,
        { id_medicamento: ids.get(codigo), id_proveedor: proveedorIds[proveedor], numero_lote: numero, fecha_caducidad: fecha, cantidad },
        ctx,
      );
    }
    const pedidos = await client.query("select count(*)::int as n from pedido");
    if (pedidos.rows[0].n === 0) {
      const pedido = await client.query(
        `insert into pedido (id_proveedor, id_empleado_solicitante, origen_solicitud, estado)
         values ($1, $2, 'MANUAL', 'SOLICITADO') returning id_pedido`,
        [proveedorIds[0], admin],
      );
      for (const [codigo, cantidad] of PEDIDO_DEMO) {
        if (!ids.has(codigo)) continue;
        await client.query(
          "insert into detalle_pedido (id_pedido, id_medicamento, cantidad_solicitada) values ($1, $2, $3)",
          [pedido.rows[0].id_pedido, ids.get(codigo), cantidad],
        );
      }
    }
  });
  return true;
}
