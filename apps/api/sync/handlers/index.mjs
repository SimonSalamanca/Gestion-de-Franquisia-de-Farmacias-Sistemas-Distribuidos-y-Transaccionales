import { dejarConflicto } from "../conflictos.mjs";
import catalogo from "./catalogo.mjs";
import empleado from "./empleado.mjs";
import acceso from "./acceso.mjs";
import tienda from "./tienda.mjs";

// Registro de handlers por tipo de evento de replica_evento.
// Para un tipo nuevo: crear handlers/<dominio>.mjs que exporte { TIPO: fn } y agregarlo aquí.
// Firma: async (client, event, idTienda) => void, dentro de la transacción del pull.
const GRUPOS = { catalogo, empleado, acceso, tienda };

export const HANDLERS = {};
for (const [grupo, handlers] of Object.entries(GRUPOS)) {
  for (const [tipo, fn] of Object.entries(handlers)) {
    if (HANDLERS[tipo]) throw new Error(`Handler duplicado para ${tipo} (${grupo})`);
    HANDLERS[tipo] = fn;
  }
}

export async function aplicarEvento(client, event, idTienda) {
  const handler = HANDLERS[event.tipo_evento];
  if (!handler) {
    // Un tipo que este nodo no conoce no debe frenar el resto (p. ej. revocaciones de sesión):
    // queda registrado y el evento sigue en el central para reaplicarlo tras actualizar el nodo.
    await dejarConflicto(
      client,
      null,
      "EVENTO_DESCONOCIDO",
      `evento ${event.id_evento} tipo ${event.tipo_evento} sin handler en este nodo`,
    );
    return false;
  }
  await handler(client, event, idTienda);
  return true;
}
