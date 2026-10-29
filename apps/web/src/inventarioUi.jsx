import { useEffect, useState } from "react";
import { api } from "./api.js";

// Piezas compartidas por HU-01 (Inventario) y HU-02 (Lotes y recepción).

export function fechaCorta(fecha) {
  if (!fecha) return "";
  // Las columnas date llegan como "AAAA-MM-DD": se muestran sin pasar por Date para no correr el día.
  const [a, m, d] = String(fecha).slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

export function fechaHora(fecha) {
  return fecha ? new Date(fecha).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "";
}

// Criterio 2 de HU-02: condición especial con texto además de color e ícono.
export function Indicadores({ medicamento }) {
  if (!medicamento.requiere_refrigeracion && !medicamento.requiere_receta) return null;
  return (
    <span className="indicadores">
      {medicamento.requiere_refrigeracion && <span className="badge frio">❄ Refrigeración 2–8 °C</span>}
      {medicamento.requiere_receta && <span className="badge receta">℞ Requiere receta</span>}
    </span>
  );
}

export function alertaCaducidad(lote) {
  if (lote.vencido) return "vencido";
  if (Number(lote.dias_para_vencer) <= Number(lote.dias_alerta_caducidad)) return "por-vencer";
  return "";
}

export function EstadoLote({ lote }) {
  const alerta = alertaCaducidad(lote);
  return (
    <>
      <span className={`pill lote-${lote.estado.toLowerCase()}`}>{lote.estado.toLowerCase()}</span>
      {alerta === "vencido" && <span className="pill agotado">vencido</span>}
      {alerta === "por-vencer" && <span className="pill bajo">vence en {lote.dias_para_vencer} d</span>}
    </>
  );
}

// Criterio 4 de HU-02: historial cronológico con saldo acumulado y verificación contra el lote.
export function HistorialLote({ token, idLote, version = 0 }) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let vigente = true;
    api(`/api/local/lotes/${idLote}/movimientos`, { token }).then((r) => {
      if (!vigente) return;
      if (r.ok) {
        setDatos(r.data);
        setError("");
      } else setError(r.data.mensaje || "No se pudo cargar el historial");
    });
    return () => {
      vigente = false;
    };
  }, [token, idLote, version]);

  if (error) return <div className="error">{error}</div>;
  if (!datos) return <p className="muted">Cargando historial…</p>;
  const { lote } = datos;
  return (
    <div className="historial">
      <p className="muted">
        Lote <strong>{lote.numero_lote}</strong> · {lote.nombre_comercial} · proveedor {lote.proveedor} · vence {fechaCorta(lote.fecha_caducidad)}
      </p>
      {!datos.consistente && (
        <div className="error">
          El saldo reconstruido ({datos.saldo_reconstruido}) no coincide con el saldo del lote ({lote.cantidad_disponible}). Revise escrituras fuera del sistema.
        </div>
      )}
      <div className="tabla-scroll">
        <table className="tabla">
          <thead>
            <tr>
              <th>Fecha y hora</th>
              <th>Tipo</th>
              <th className="num">Cantidad</th>
              <th className="num">Saldo</th>
              <th>Responsable</th>
              <th>Referencia</th>
              <th>Observaciones</th>
            </tr>
          </thead>
          <tbody>
            {datos.movimientos.map((m) => (
              <tr key={m.id_movimiento}>
                <td>{fechaHora(m.fecha_hora)}</td>
                <td>{m.tipo_movimiento}</td>
                <td className={`num ${m.sentido > 0 ? "suma" : "resta"}`}>{m.sentido > 0 ? "+" : "−"}{m.cantidad}</td>
                <td className="num">{m.saldo}</td>
                <td>{m.empleado}</td>
                <td>{m.referencia_documento || ""}</td>
                <td>{m.observaciones || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Detalle del medicamento: condiciones especiales y lotes, primero los que vencen antes.
export function DetalleMedicamento({ token, idMedicamento, onCerrar }) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState("");
  const [loteAbierto, setLoteAbierto] = useState(null);

  useEffect(() => {
    api(`/api/local/medicamentos/${idMedicamento}`, { token }).then((r) => {
      if (r.ok) setDatos(r.data);
      else setError(r.data.mensaje || "No se pudo cargar el medicamento");
    });
  }, [token, idMedicamento]);

  return (
    <div className="detalle-med">
      <div className="row detalle-cabecera">
        <strong>Detalle del medicamento</strong>
        <button className="ghost" onClick={onCerrar}>Cerrar</button>
      </div>
      {error && <div className="error">{error}</div>}
      {!datos && !error && <p className="muted">Cargando…</p>}
      {datos && (
        <>
          <p>
            <strong>{datos.nombre_comercial}</strong> · {datos.principio_activo} · {datos.codigo_interno}
            {datos.categoria ? ` · ${datos.categoria}` : ""}
          </p>
          <Indicadores medicamento={datos} />
          {datos.requiere_refrigeracion && <p className="aviso-frio">Conservar entre 2 y 8 °C. No congelar.</p>}
          {datos.lotes.length === 0 ? (
            <p className="muted">Esta tienda no tiene lotes de este medicamento.</p>
          ) : (
            <div className="tabla-scroll">
              <table className="tabla">
                <thead>
                  <tr>
                    <th>Lote</th>
                    <th>Proveedor</th>
                    <th>Caducidad</th>
                    <th className="num">Disponible</th>
                    <th>Estado</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {datos.lotes.map((lote) => (
                    <tr key={lote.id_lote} className={alertaCaducidad(lote)}>
                      <td>{lote.numero_lote}</td>
                      <td>{lote.proveedor}</td>
                      <td>{fechaCorta(lote.fecha_caducidad)}</td>
                      <td className="num">{lote.cantidad_disponible}</td>
                      <td><EstadoLote lote={lote} /></td>
                      <td>
                        <button className="ghost" onClick={() => setLoteAbierto(loteAbierto === lote.id_lote ? null : lote.id_lote)}>
                          {loteAbierto === lote.id_lote ? "Ocultar" : "Historial"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {loteAbierto && <HistorialLote token={token} idLote={loteAbierto} />}
        </>
      )}
    </div>
  );
}
