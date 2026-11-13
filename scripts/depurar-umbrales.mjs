import "./lib/owner.mjs";
// HU-04: ningún medicamento activo puede operar sin umbral (stock mínimo y días de aviso) en una tienda activa, o el sistema
// de alertas no lo vigilaría. Este script revisa el nodo central del .env:
//   npm run db:depurar-umbrales                       lista los que no cumplen (no cambia nada)
//   npm run db:depurar-umbrales -- --aplicar          los da de baja si no tienen unidades en la red
//   npm run db:depurar-umbrales -- --aplicar --incluir-con-stock    también los que tienen unidades (¡dejan de venderse!)
// Una baja es lógica (activo = false), no un borrado: las facturas, recetas y movimientos que los referencian son
// inmutables. Se publica a las tiendas y queda en la auditoría del central. Reactivarlos exige crear sus umbrales.
import { central, withTx } from "../apps/api/db.mjs";
import { medicamentosSinUmbral } from "../apps/api/umbrales.mjs";

const aplicar = process.argv.includes("--aplicar");
const conStock = process.argv.includes("--incluir-con-stock");

const sin = await medicamentosSinUmbral(central);
if (sin.length === 0) {
  console.log("Todos los medicamentos activos tienen umbral en todas las tiendas activas.");
} else {
  console.log(`${sin.length} medicamento(s) activo(s) sin umbral:`);
  for (const m of sin) {
    console.log(`  ${m.codigo_interno}  ${m.nombre_comercial}  tiendas sin umbral: ${m.tiendas_sin_umbral.join(",")}  unidades en la red: ${m.unidades_en_red}`);
  }
  if (!aplicar) {
    console.log("\nNo se cambió nada. Use --aplicar para darlos de baja (los que tienen unidades requieren --incluir-con-stock).");
  } else {
    const aBaja = sin.filter((m) => conStock || m.unidades_en_red === 0);
    const omitidos = sin.length - aBaja.length;
    await withTx(central, async (client) => {
      for (const m of aBaja) {
        // guardia-permitido: publica su evento en la misma transacción (MEDICAMENTO_UPSERT, abajo)
        const fila = await client.query(
          `update medicamento set activo = false where id_medicamento = $1 and activo
           returning id_medicamento, codigo_interno, nombre_comercial, principio_activo, id_categoria,
                     requiere_receta, requiere_refrigeracion, activo, tasa_impuesto`,
          [m.id_medicamento],
        );
        if (fila.rowCount === 0) continue;
        await client.query("select append_replica_evento(null, 'MEDICAMENTO_UPSERT', 1, $1::jsonb)", [JSON.stringify(fila.rows[0])]);
        await client.query(
          `insert into registro_actividad_central (id_empleado, accion, entidad_afectada, id_entidad_afectada, detalle)
           values (null, 'MEDICAMENTO_BAJA_SIN_UMBRAL', 'medicamento', $1, $2)`,
          [m.id_medicamento, `${m.codigo_interno}: sin umbral en las tiendas ${m.tiendas_sin_umbral.join(",")}`.slice(0, 400)],
        );
      }
    });
    console.log(`\nDados de baja: ${aBaja.length}.${omitidos > 0 ? ` Omitidos por tener unidades en la red: ${omitidos} (use --incluir-con-stock).` : ""}`);
  }
}
await central.end();
