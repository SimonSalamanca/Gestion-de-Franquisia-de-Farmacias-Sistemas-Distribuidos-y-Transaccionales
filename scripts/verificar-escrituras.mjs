// Guardia de escrituras en el central (docs/seguridad/escritura-central.md, fase C). Busca en los scripts de prueba y de
// mantenimiento escrituras directas sobre el nodo central que no pasan por scripts/lib/central.mjs. Esas escrituras cambian
// datos que las tiendas reciben por eventos y, si no publican su evento, dejan la red desalineada.
// Excepciones permitidas: transacciones que terminan en rollback (no dejan cambios). Sale con código 1 si encuentra algo.
import fs from "node:fs";
import path from "node:path";

const RAIZ = "scripts";
const LIB = path.join(RAIZ, "lib");
const ESCRITURA = /^\s*(insert\s+into|update\s+\w|delete\s+from|truncate\s)/i;

function archivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return p === LIB ? [] : archivos(p);
    return p.endsWith(".mjs") ? [p] : [];
  });
}

const hallazgos = [];
for (const f of archivos(RAIZ)) {
  const lineas = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lineas.forEach((linea, i) => {
    // central.query("...") o central.query(\n "...") con una sentencia de escritura
    if (/\bcentral\.query\(/.test(linea)) {
      const resto = linea.slice(linea.indexOf("central.query(") + "central.query(".length);
      const siguiente = lineas[i + 1] ?? "";
      if (ESCRITURA.test(resto.replace(/^[\s`"']+/, "")) || ESCRITURA.test(siguiente.replace(/^[\s`"']+/, ""))) {
        hallazgos.push(`${f}:${i + 1}: escritura directa en el central: ${linea.trim().slice(0, 110)}`);
      }
    }
  });
  // Cambios de estado (update/delete) sobre datos replicados, en cualquier forma de sentencia (también dentro de una CTE).
  // Los altas (insert) de catálogo las publica el arranque del nodo (migrate); los cambios de estado no, así que se exigen
  // por el helper.
  lineas.forEach((linea, i) => {
    if (!/\b(update|delete\s+from)\s+(medicamento|proveedor|tienda|empleado|precio_medicamento|umbral_stock|rol_permiso|control_acceso|bloqueo_canonico|sesion_activa)\b/i.test(linea)) return;
    // Escritura sobre la base local (no se replica): no aplica.
    const contexto = lineas.slice(Math.max(0, i - 2), i + 1).join("\n");
    if (/\blocal\.(query|connect)\(/.test(contexto) && !/\bcentral\.(query|connect)\(/.test(contexto)) return;
    // Excepción explícita y documentada en el código (intento rechazado a propósito, transacción que se revierte, o
    // una herramienta que publica su propio evento en la misma transacción).
    const marcado = lineas.slice(Math.max(0, i - 4), i + 1).some((l) => /guardia-permitido/.test(l));
    if (marcado) return;
    hallazgos.push(`${f}:${i + 1}: cambio de estado sobre dato replicado: ${linea.trim().slice(0, 110)}`);
  });
  // Conexión propia al central con escrituras confirmadas (commit)
  const texto = lineas.join("\n");
  if (/central\.connect\(\)/.test(texto) && /\bcommit\b/.test(texto) && /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(texto)) {
    const sinRollback = !/rollback/.test(texto);
    if (sinRollback) hallazgos.push(`${f}: transacción propia sobre el central con commit y escrituras (usar scripts/lib/central.mjs)`);
  }
}

if (hallazgos.length === 0) {
  console.log("TODO OK: ninguna escritura directa en el central fuera de scripts/lib/central.mjs");
  process.exit(0);
}
console.log(`FALLO: ${hallazgos.length} escritura(s) directa(s) en el central`);
for (const h of hallazgos) console.log("  " + h);
process.exit(1);
