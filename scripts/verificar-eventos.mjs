// Verificador de eventos (docs/seguridad/escritura-central.md, fase C). Compara, para cada dato que el central replica, el
// último evento publicado con el estado real de la tabla del central. Si no coinciden, hubo un cambio que no se publicó y
// las tiendas no lo reciben: la red queda desalineada. Sale con código 1 si hay diferencias.
// Uso: npm run verificar:eventos   (solo lectura)
import { central } from "../apps/api/db.mjs";

const ultimo = (tipo, clave) => `
  with ult as (
    select distinct on (${clave}) ${clave} as k, payload
    from replica_evento where tipo_evento = '${tipo}'
    order by ${clave}, id_evento desc
  )`;

const pruebas = [
  {
    nombre: "medicamentos: activo",
    sql: `${ultimo("MEDICAMENTO_UPSERT", "(payload->>'id_medicamento')::int")}
      select m.id_medicamento as id, m.activo as tabla, (u.payload->>'activo')::boolean as evento
      from medicamento m left join ult u on u.k = m.id_medicamento
      where u.k is null or u.payload->>'activo' is distinct from m.activo::text`,
  },
  {
    nombre: "proveedores: activo",
    sql: `${ultimo("PROVEEDOR_UPSERT", "(payload->>'id_proveedor')::int")}
      select p.id_proveedor as id, p.activo as tabla, (u.payload->>'activo')::boolean as evento
      from proveedor p left join ult u on u.k = p.id_proveedor
      where u.k is null or u.payload->>'activo' is distinct from p.activo::text`,
  },
  {
    nombre: "tiendas: activa",
    sql: `${ultimo("TIENDA_UPSERT", "(payload->>'id_tienda')::int")}
      select t.id_tienda as id, t.activa as tabla, (u.payload->>'activa')::boolean as evento
      from tienda t left join ult u on u.k = t.id_tienda
      where u.k is null or u.payload->>'activa' is distinct from t.activa::text`,
  },
  {
    nombre: "personal: activo y versión de credencial",
    sql: `${ultimo("EMPLEADO_UPSERT", "(payload->>'id_empleado')::int")}
      select e.id_empleado as id, e.activo as tabla, (u.payload->>'activo')::boolean as evento
      from empleado e left join ult u on u.k = e.id_empleado
      where u.k is null or u.payload->>'activo' is distinct from e.activo::text
         or u.payload->>'version_credencial' is distinct from e.version_credencial::text`,
  },
  {
    nombre: "precios: precio y fin de vigencia",
    sql: `${ultimo("PRECIO_UPSERT", "(payload->>'id_precio')::int")}
      select p.id_precio as id, p.precio::text as tabla, u.payload->>'precio' as evento
      from precio_medicamento p left join ult u on u.k = p.id_precio
      where u.k is null or u.payload->>'precio' is distinct from p.precio::text
         or (u.payload->>'fecha_fin_vigencia')::timestamp is distinct from date_trunc('milliseconds', p.fecha_fin_vigencia)`,
  },
  {
    nombre: "umbrales: stock mínimo y aviso",
    sql: `with ult as (
        select distinct on ((payload->>'id_tienda')::int, (payload->>'id_medicamento')::int)
               (payload->>'id_tienda')::int t, (payload->>'id_medicamento')::int m, payload
        from replica_evento where tipo_evento = 'UMBRAL_UPSERT'
        order by (payload->>'id_tienda')::int, (payload->>'id_medicamento')::int, id_evento desc)
      select u.id_tienda as id, u.stock_minimo::text as tabla, x.payload->>'stock_minimo' as evento
      from umbral_stock u left join ult x on x.t = u.id_tienda and x.m = u.id_medicamento
      where x.t is null or x.payload->>'stock_minimo' is distinct from u.stock_minimo::text
         or x.payload->>'dias_alerta_caducidad' is distinct from u.dias_alerta_caducidad::text`,
  },
];

let total = 0;
for (const p of pruebas) {
  const r = await central.query(p.sql);
  total += r.rowCount;
  console.log(`${r.rowCount === 0 ? "OK   " : "FALLO"} ${p.nombre}${r.rowCount ? `: ${r.rowCount} sin evento al día (ej. id ${r.rows[0].id})` : ""}`);
}
console.log(total === 0 ? "TODO OK: el log de eventos coincide con el central" : `DESALINEADO: ${total} diferencia(s)`);
await central.end();
process.exit(total === 0 ? 0 : 1);
