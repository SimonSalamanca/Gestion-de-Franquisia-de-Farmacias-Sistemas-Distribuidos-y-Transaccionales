import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { fechaCorta, fechaHora } from "./inventarioUi.jsx";
import { SolicitudDeAlerta } from "./Solicitudes.jsx";

// HU-04: panel único de alertas, de la más urgente a la menos (RF-03). Se calculan en la tienda: funciona sin conexión
// con el central. Se refresca solo; un lote vencido ya está bloqueado para la venta cuando aparece aquí.

const REFRESCO_MS = 30000;
const NIVELES = { CRITICA: ["agotado", "Crítica"], ALTA: ["bajo", "Alta"], MEDIA: ["media", "Media"] };
const TIPOS = {
  LOTE_VENCIDO: "Lote vencido",
  STOCK_AGOTADO: "Stock agotado",
  STOCK_BAJO: "Stock bajo",
  CADUCIDAD_PROXIMA: "Caducidad próxima",
  SIN_UMBRAL: "Sin umbral",
};

const unidades = (n) => `${n} unidad${Number(n) === 1 ? "" : "es"}`;
const dias = (n) => `${n} día${Number(n) === 1 ? "" : "s"}`;

function descripcion(a) {
  const d = a.detalle;
  switch (a.tipo) {
    case "LOTE_VENCIDO":
      return `Lote ${d.numero_lote} vencido hace ${dias(d.dias_vencido)} (${fechaCorta(d.fecha_caducidad)}). ${unidades(d.cantidad)} bloqueadas para la venta: retírelas del inventario.`;
    case "STOCK_AGOTADO":
      return `Sin unidades vendibles (mínimo configurado: ${d.stock_minimo}).`;
    case "STOCK_BAJO":
      return `Stock vendible ${d.stock} de un mínimo de ${d.stock_minimo}.`;
    case "CADUCIDAD_PROXIMA":
      return `Lote ${d.numero_lote}: ${unidades(d.cantidad)} caducan en ${dias(d.dias_restantes)} (${fechaCorta(d.fecha_caducidad)}). Aviso configurado: ${dias(d.dias_aviso)}.`;
    case "SIN_UMBRAL":
      return "Este medicamento no tiene umbral en esta tienda y nada lo vigila bien. Pida al administrador general que lo configure (Tiendas > Umbrales).";
    default:
      return "";
  }
}

export default function Alertas({ session }) {
  const token = session.token;
  const [datos, setDatos] = useState(null);
  const [resumen, setResumen] = useState(null);
  const [nivel, setNivel] = useState("");
  const [tipo, setTipo] = useState("");
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  // HU-13: el administrador genera la solicitud de reabastecimiento desde una alerta de stock. Alerta abierta por id.
  const puedeSolicitar = session.permisos.includes("PROVEEDOR_GESTIONAR");
  const [solicitando, setSolicitando] = useState(null);

  const cargar = useCallback(async () => {
    const query = new URLSearchParams();
    if (nivel) query.set("nivel", nivel);
    if (tipo) query.set("tipo", tipo);
    const [lista, res] = await Promise.all([api(`/api/local/alertas?${query}`, { token }), api("/api/local/alertas/resumen", { token })]);
    if (lista.ok) {
      setDatos(lista.data.alertas);
      setError("");
    } else setError(lista.data.mensaje || "No se pudieron cargar las alertas");
    if (res.ok) setResumen(res.data);
  }, [token, nivel, tipo]);

  useEffect(() => {
    cargar();
    const timer = setInterval(cargar, REFRESCO_MS);
    return () => clearInterval(timer);
  }, [cargar, version]);

  async function vista(id) {
    const r = await api(`/api/local/alertas/${id}/vista`, { method: "POST", token });
    if (r.ok) setVersion((v) => v + 1);
  }

  return (
    <div>
      <p className="muted">
        Todas las alertas activas en un solo panel, ordenadas por urgencia. Se calculan en esta tienda con los umbrales de cada producto:
        un lote vencido se bloquea para la venta automáticamente.
      </p>
      {resumen && (
        <div className="row" role="group" aria-label="Filtrar por nivel">
          <button className={nivel === "" ? "primary" : "ghost"} onClick={() => setNivel("")}>Todas ({resumen.total})</button>
          {Object.entries(NIVELES).map(([clave, [, etiqueta]]) => (
            <button key={clave} className={nivel === clave ? "primary" : "ghost"} onClick={() => setNivel(nivel === clave ? "" : clave)}>
              {etiqueta} ({resumen.por_nivel[clave].total})
            </button>
          ))}
        </div>
      )}
      <div className="inv-filtros dos">
        <select value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo de alerta">
          <option value="">Todos los tipos</option>
          {Object.entries(TIPOS).map(([clave, etiqueta]) => <option key={clave} value={clave}>{etiqueta}</option>)}
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      {datos && datos.length === 0 && <div className="inv-vacio">No hay alertas activas. El stock y los lotes están dentro de sus umbrales.</div>}
      <ul className="inv-lista">
        {(datos || []).map((a) => (
          <li key={a.id_alerta} className="inv-item">
            <div className="inv-fila">
              <div>
                <span className={`pill ${NIVELES[a.nivel][0]}`}>{NIVELES[a.nivel][1]}</span> <strong>{TIPOS[a.tipo]}</strong> · {a.nombre_comercial}
                <div>{descripcion(a)}</div>
                <div className="muted">
                  Desde {fechaHora(a.creada_en)}
                  {a.vista_en ? ` · vista por ${a.vista_por || "—"} el ${fechaHora(a.vista_en)}` : ""}
                </div>
              </div>
              <div className="inv-stock">
                {!a.vista_en && <button className="ghost" onClick={() => vista(a.id_alerta)}>Marcar como vista</button>}
                {puedeSolicitar && (a.tipo === "STOCK_BAJO" || a.tipo === "STOCK_AGOTADO") && (
                  <button className="ghost" onClick={() => setSolicitando(solicitando === a.id_alerta ? null : a.id_alerta)}>
                    {solicitando === a.id_alerta ? "Ocultar" : "Generar solicitud"}
                  </button>
                )}
              </div>
            </div>
            {solicitando === a.id_alerta && <SolicitudDeAlerta token={token} idAlerta={a.id_alerta} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
