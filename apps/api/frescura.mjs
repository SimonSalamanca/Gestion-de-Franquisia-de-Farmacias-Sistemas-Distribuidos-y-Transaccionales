import { config } from "./config.mjs";

// HU-16: frescura de la información que una tienda consolidó en el central (RNF-13).
// AL_DIA: la última información tiene a lo sumo `maxMin` minutos. DESACTUALIZADA: más. SIN_DATOS: nunca envió nada.
// La referencia es la última foto de stock, que llega cada CONSOLIDACION_INTERVALO_MS aunque no haya movimientos (el
// latido); sin foto, la última venta consolidada. `ahora` es la hora del central, para no depender de otro reloj.
export function frescuraDe(ultimaFoto, ultimaVenta, ahora, maxMin = config.consolidadoMaxRetrasoMin) {
  const ref = ultimaFoto ?? ultimaVenta ?? null;
  if (!ref) return { estado: "SIN_DATOS", ultima_actualizacion: null, minutos: null };
  const minutos = Math.max(0, Math.floor((new Date(ahora) - new Date(ref)) / 60000));
  return { estado: minutos <= maxMin ? "AL_DIA" : "DESACTUALIZADA", ultima_actualizacion: ref, minutos };
}
