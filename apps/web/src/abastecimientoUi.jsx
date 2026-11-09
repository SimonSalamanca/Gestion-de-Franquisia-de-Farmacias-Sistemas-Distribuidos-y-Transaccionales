import { useCallback, useState } from "react";
import { api } from "./api.js";

// Piezas compartidas por HU-13: proveedores y solicitudes de reabastecimiento.

// Algo más que un ciclo de sincronización (10 s), para releer la réplica de la tienda ya actualizada.
export const RELECTURA_MS = 12000;

// La clave de idempotencia se conserva hasta tener respuesta: un doble clic o un reintento tras un corte no duplica.
export function useEnvio(token) {
  const [ocupado, setOcupado] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const enviar = useCallback(
    async (ruta, method, body) => {
      setOcupado(true);
      try {
        const r = await api(ruta, { method, body: body ?? {}, token, key });
        // Con respuesta del servidor (éxito o error de negocio) se estrena clave; sin respuesta se reintenta con la misma.
        setKey(crypto.randomUUID());
        return r;
      } catch {
        return { ok: false, status: 0, data: { mensaje: "Sin respuesta del servidor. Puede reintentar: no se duplicará." } };
      } finally {
        setOcupado(false);
      }
    },
    [token, key],
  );
  return { enviar, ocupado };
}

export function mensajeError(r, { requiereCentral = false } = {}) {
  const { mensaje, ultima_sync: ultima } = r.data || {};
  const base = mensaje || "No se pudo completar la operación";
  if (r.status === 503 && requiereCentral) {
    return `${base}. Registrar o editar proveedores requiere conexión con el nodo central${ultima ? ` (última sync: ${new Date(ultima).toLocaleString()})` : ""}.`;
  }
  return base;
}

// Criterio 5: pendiente, enviada, recibida. Texto además del color.
export const ESTADOS = {
  PENDIENTE: { etiqueta: "Pendiente", pill: "bajo" },
  ENVIADA: { etiqueta: "Enviada", pill: "media" },
  RECIBIDA_PARCIAL: { etiqueta: "Recibida en parte", pill: "media" },
  RECIBIDA: { etiqueta: "Recibida", pill: "disponible" },
  CANCELADA: { etiqueta: "Cancelada", pill: "agotado" },
};
