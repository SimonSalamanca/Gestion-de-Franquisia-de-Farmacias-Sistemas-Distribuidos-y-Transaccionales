// Reparación del log de eventos (docs/seguridad/escritura-central.md, fase D): publica el estado actual de los registros
// que el último evento no refleja. Úsalo solo después de verificar-eventos.mjs; no cambia ninguna tabla del central.
import "./lib/owner.mjs";
import { repararEventos } from "./lib/central.mjs";
import { central } from "../apps/api/db.mjs";

const r = await repararEventos();
console.log(`eventos publicados: medicamentos ${r.medicamentos}, personal ${r.empleados}, precios ${r.precios}`);
await central.end();
