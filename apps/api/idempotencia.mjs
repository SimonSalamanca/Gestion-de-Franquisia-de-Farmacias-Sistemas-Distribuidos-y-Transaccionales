import crypto from "crypto";
import { withTx, PEPPER } from "./db.mjs";
import { ErrorNegocio } from "./errores.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ejecuta una operación de escritura una sola vez por Idempotency-Key (doble clic, reintento de red).
// Reutiliza auth_operacion, la tabla de idempotencia de HU-06: las claves son UUID por operación,
// así que no chocan con las de login. Errores de negocio no se guardan: revierten todo y se pueden reintentar.
export async function conIdempotencia(pool, { key, operacion, idEmpleado, body }, fn) {
  const clave = Array.isArray(key) ? key[0] : key;
  if (!clave) throw new ErrorNegocio(400, "IDEMPOTENCY", "Falta Idempotency-Key");
  if (!UUID_RE.test(String(clave))) throw new ErrorNegocio(400, "IDEMPOTENCY", "Idempotency-Key no es UUID");
  const hmac = crypto
    .createHmac("sha256", PEPPER)
    .update(`${operacion}|${idEmpleado}|${JSON.stringify(body ?? {})}`)
    .digest("hex");

  return withTx(pool, async (client) => {
    // Dos peticiones simultáneas con la misma clave: la segunda espera y ve el resultado de la primera.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [clave]);
    const previo = await client.query(
      "select payload_hmac, resultado_http, cuerpo_json from auth_operacion where idempotency_key = $1",
      [clave],
    );
    if (previo.rowCount > 0) {
      if (previo.rows[0].payload_hmac !== hmac) {
        throw new ErrorNegocio(409, "IDEMPOTENCY_CONFLICT", "La clave ya se usó con otros datos");
      }
      return { status: previo.rows[0].resultado_http, body: previo.rows[0].cuerpo_json, repetido: true };
    }
    const resultado = await fn(client);
    await client.query(
      `insert into auth_operacion (idempotency_key, payload_hmac, resultado_http, cuerpo_json)
       values ($1, $2, $3, $4::jsonb)`,
      [clave, hmac, resultado.status, JSON.stringify(resultado.body)],
    );
    return resultado;
  });
}
