import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { fechaHora, pesos } from "./inventarioUi.jsx";
import { useEnvio } from "./abastecimientoUi.jsx";

// HU-11: cierre de caja (RF-07). Totaliza el periodo por método de pago y por empleado, lo compara con lo contado (efectivo,
// vouchers de tarjeta, comprobantes), exige justificación si algo no cuadra y deja el cierre inmutable. Con la caja cerrada no
// se vende hasta abrir un nuevo periodo. Todo es local: funciona sin conexión con el central.

const ETIQUETA_CONTEO = {
  EFECTIVO: "Efectivo contado",
  VOUCHERS: "Total de vouchers",
  COMPROBANTES: "Total de comprobantes",
};
const ESTADO_CIERRE = { CONCILIADO: ["disponible", "Conciliado"], CON_DIFERENCIA: ["bajo", "Con diferencia justificada"] };

// "12.345,6" o "12345.60" -> centavos; null si no es un monto válido con máximo dos decimales.
function aCentavos(texto) {
  const t = String(texto ?? "").trim().replace(",", ".");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(t)) return null;
  const [e, d = ""] = t.split(".");
  return Number(e) * 100 + Number(d.padEnd(2, "0"));
}
const centavos = (decimal) => Math.round(Number(decimal) * 100);

function mensajeError(r) {
  const { mensaje } = r.data || {};
  return mensaje || "No se pudo completar la operación";
}

export default function CierreCaja({ session }) {
  const [pestana, setPestana] = useState("cierre");
  return (
    <article className="inventario">
      <header className="inv-cabecera">
        <h2>Cierre de caja</h2>
        <p className="muted">
          El total vendido del periodo por método de pago y por empleado, comparado con lo contado. El cierre queda registrado y no se puede modificar.
        </p>
        <div className="pestanas" role="tablist">
          <button role="tab" aria-selected={pestana === "cierre"} className={pestana === "cierre" ? "active" : ""} onClick={() => setPestana("cierre")}>Cerrar caja</button>
          <button role="tab" aria-selected={pestana === "historial"} className={pestana === "historial" ? "active" : ""} onClick={() => setPestana("historial")}>Cierres anteriores</button>
        </div>
      </header>
      {pestana === "cierre" && <Cierre session={session} />}
      {pestana === "historial" && <Historial token={session.token} />}
    </article>
  );
}

function Cierre({ session }) {
  const token = session.token;
  const { enviar, ocupado } = useEnvio(token);
  const [datos, setDatos] = useState(null);
  const [contado, setContado] = useState({});
  const [justificacion, setJustificacion] = useState("");
  const [turno, setTurno] = useState("");
  const [error, setError] = useState("");
  const [cerrado, setCerrado] = useState(null);

  const cargar = useCallback(async () => {
    const r = await api("/api/local/caja/resumen", { token });
    if (r.ok) {
      setDatos(r.data);
      setError("");
    } else setError(mensajeError(r));
  }, [token]);
  useEffect(() => {
    cargar();
  }, [cargar]);

  const resumen = datos?.resumen;
  // Diferencia por método frente a lo contado: se compara cada método por separado (un sobrante no tapa un faltante).
  const diferenciaDe = (m) => {
    const c = aCentavos(contado[m.id_metodo_pago]);
    if (c == null) return null;
    return c - centavos(m.calculado);
  };
  const filas = resumen?.por_metodo ?? [];
  const conMovimiento = (m) => centavos(m.vendido) !== 0 || centavos(m.devuelto) !== 0;
  const hayDiferencia = filas.some((m) => {
    const d = diferenciaDe(m);
    return d != null && d !== 0;
  });

  async function cerrar(event) {
    event.preventDefault();
    setError("");
    const faltan = filas.filter((m) => conMovimiento(m) && aCentavos(contado[m.id_metodo_pago]) == null);
    if (faltan.length > 0) return setError(`Registre lo contado de: ${faltan.map((m) => m.etiqueta).join(", ")}`);
    if (filas.some((m) => contado[m.id_metodo_pago] != null && contado[m.id_metodo_pago] !== "" && aCentavos(contado[m.id_metodo_pago]) == null)) {
      return setError("Cada monto contado debe ser un número con máximo dos decimales");
    }
    if (hayDiferencia && justificacion.trim().length < 10) return setError("Hay diferencias: escriba la justificación (mínimo 10 caracteres)");
    const r = await enviar("/api/local/caja/cierre", "POST", {
      contado: filas
        .filter((m) => aCentavos(contado[m.id_metodo_pago]) != null)
        .map((m) => ({ id_metodo_pago: m.id_metodo_pago, monto: String(contado[m.id_metodo_pago]).trim().replace(",", ".") })),
      turno: turno.trim() || undefined,
      justificacion: justificacion.trim() || undefined,
      firma: resumen.firma,
    });
    if (!r.ok) {
      if (r.data?.codigo === "RESUMEN_DESACTUALIZADO") await cargar();
      return setError(mensajeError(r));
    }
    setCerrado(r.data);
    setContado({});
    setJustificacion("");
    cargar();
  }

  async function abrir(event) {
    event.preventDefault();
    setError("");
    const r = await enviar("/api/local/caja/apertura", "POST", { turno: turno.trim() || undefined });
    if (!r.ok) return setError(mensajeError(r));
    setCerrado(null);
    setTurno("");
    cargar();
  }

  if (!datos) return error ? <div className="error">{error}</div> : <p className="muted">Calculando el periodo…</p>;
  return (
    <div>
      {cerrado && <ResultadoCierre cierre={cerrado} />}
      {!datos.abierta && (
        <form className="subform" onSubmit={abrir}>
          <p>
            <strong>La caja está cerrada.</strong> No se pueden registrar ventas hasta abrir un nuevo periodo.
            {datos.ultimo_cierre ? ` Último cierre: n.º ${datos.ultimo_cierre.id_cierre}, ${fechaHora(datos.ultimo_cierre.fecha_hora_cierre)}, por ${datos.ultimo_cierre.cerro}.` : ""}
          </p>
          <input placeholder="Turno (opcional, p. ej. Mañana)" value={turno} onChange={(e) => setTurno(e.target.value)} maxLength={20} aria-label="Turno" />
          <button className="primary" disabled={ocupado}>{ocupado ? "Abriendo…" : "Abrir nuevo periodo"}</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
      {datos.abierta && resumen && (
        <form className="formulario" onSubmit={cerrar}>
          <p className="muted">
            Periodo {resumen.periodo}{resumen.abierta_en ? ` abierto el ${fechaHora(resumen.abierta_en)}` : " (desde la primera venta)"} · {resumen.facturas} factura(s) · {resumen.notas} devolución(es).
            Si hay ventas nuevas mientras cuenta, el cierre le pedirá recalcular.
          </p>
          <h3>Por método de pago</h3>
          <div className="tabla-scroll">
            <table className="tabla">
              <thead>
                <tr>
                  <th>Método</th>
                  <th className="num">Vendido</th>
                  <th className="num">Devuelto</th>
                  <th className="num">Calculado</th>
                  <th>Contado</th>
                  <th>Diferencia</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((m) => {
                  const dif = diferenciaDe(m);
                  return (
                    <tr key={m.id_metodo_pago}>
                      <td>{m.etiqueta}</td>
                      <td className="num">{pesos(m.vendido)}</td>
                      <td className="num">{pesos(m.devuelto)}</td>
                      <td className="num"><strong>{pesos(m.calculado)}</strong></td>
                      <td>
                        <input
                          inputMode="decimal"
                          placeholder={ETIQUETA_CONTEO[m.tipo_conteo]}
                          value={contado[m.id_metodo_pago] ?? ""}
                          onChange={(e) => setContado((c) => ({ ...c, [m.id_metodo_pago]: e.target.value }))}
                          aria-label={`${ETIQUETA_CONTEO[m.tipo_conteo]} (${m.etiqueta})`}
                        />
                      </td>
                      <td>
                        {dif == null ? <span className="muted">—</span> : dif === 0 ? <span className="pill disponible">Cuadra</span> : <span className="pill agotado">{dif > 0 ? "Sobran" : "Faltan"} {pesos(Math.abs(dif) / 100)}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total del sistema</th>
                  <th />
                  <th />
                  <th className="num">{pesos(resumen.total_sistema)}</th>
                  <th />
                  <th />
                </tr>
              </tfoot>
            </table>
          </div>

          <h3>Por empleado</h3>
          {resumen.por_empleado.length === 0 && <p className="muted">Todavía no hay ventas en este periodo.</p>}
          {resumen.por_empleado.length > 0 && (
            <div className="tabla-scroll">
              <table className="tabla">
                <thead>
                  <tr>
                    <th>Empleado</th>
                    <th className="num">Vendido</th>
                    <th className="num">Devuelto</th>
                    <th className="num">Neto</th>
                    <th>Por método</th>
                  </tr>
                </thead>
                <tbody>
                  {resumen.por_empleado.map((e) => (
                    <tr key={e.id_empleado}>
                      <td>{e.nombre}</td>
                      <td className="num">{pesos(e.vendido)}</td>
                      <td className="num">{pesos(e.devuelto)}</td>
                      <td className="num"><strong>{pesos(e.neto)}</strong></td>
                      <td className="muted">
                        {e.metodos.map((x) => `${filas.find((m) => m.id_metodo_pago === x.id_metodo_pago)?.etiqueta ?? x.id_metodo_pago}: ${pesos(centavos(x.vendido) / 100 - centavos(x.devuelto) / 100)}`).join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {hayDiferencia && (
            <>
              <p className="error" role="alert">
                Lo contado no coincide con lo calculado. Para cerrar la caja escriba la justificación de la diferencia.
              </p>
              <label htmlFor="cierre-justificacion">Justificación de la diferencia (obligatoria, mínimo 10 caracteres)</label>
              <textarea id="cierre-justificacion" rows={3} maxLength={300} value={justificacion} onChange={(e) => setJustificacion(e.target.value)} />
            </>
          )}
          <label htmlFor="cierre-turno">Turno (opcional)</label>
          <input id="cierre-turno" value={turno} maxLength={20} onChange={(e) => setTurno(e.target.value)} />
          <div className="row">
            <button className="primary" disabled={ocupado}>{ocupado ? "Cerrando…" : "Cerrar caja"}</button>
            <button type="button" className="ghost" onClick={cargar}>Recalcular</button>
          </div>
        </form>
      )}
    </div>
  );
}

function ResultadoCierre({ cierre }) {
  const [clase, etiqueta] = ESTADO_CIERRE[cierre.estado];
  return (
    <div className="ok">
      Cierre n.º {cierre.id_cierre} registrado: <span className={`pill ${clase}`}>{etiqueta}</span> · total del sistema {pesos(cierre.total_sistema)} · efectivo contado {pesos(cierre.total_efectivo_contado)} · vouchers {pesos(cierre.total_vouchers)}
      {centavos(cierre.diferencia) !== 0 ? ` · diferencia ${pesos(cierre.diferencia)}` : ""}. La caja quedó cerrada.
    </div>
  );
}

function Historial({ token }) {
  const [cierres, setCierres] = useState(null);
  const [abierto, setAbierto] = useState(null);
  const [detalle, setDetalle] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/local/caja/cierres", { token }).then((r) => (r.ok ? setCierres(r.data.cierres) : setError(mensajeError(r))));
  }, [token]);

  async function ver(id) {
    if (abierto === id) return setAbierto(null);
    setAbierto(id);
    setDetalle(null);
    const r = await api(`/api/local/caja/cierres/${id}`, { token });
    if (r.ok) setDetalle(r.data);
    else setError(mensajeError(r));
  }

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {cierres && cierres.length === 0 && <div className="inv-vacio">Todavía no hay cierres de caja.</div>}
      <ul className="inv-lista">
        {(cierres || []).map((k) => {
          const [clase, etiqueta] = ESTADO_CIERRE[k.estado];
          return (
            <li key={k.id_cierre} className="inv-item">
              <div className="inv-fila">
                <div>
                  <strong>Cierre {k.id_cierre}</strong> <span className={`pill ${clase}`}>{etiqueta}</span> · {fechaHora(k.fecha_hora_cierre)} · {k.cerro}
                  {k.turno ? ` · turno ${k.turno}` : ""}
                  <div className="muted">
                    Sistema {pesos(k.total_sistema)} · efectivo contado {pesos(k.total_efectivo_contado)} · vouchers {pesos(k.total_vouchers)}
                    {centavos(k.diferencia) !== 0 ? ` · diferencia ${pesos(k.diferencia)}` : ""}
                  </div>
                </div>
                <button className="ghost" onClick={() => ver(k.id_cierre)}>{abierto === k.id_cierre ? "Ocultar" : "Ver detalle"}</button>
              </div>
              {abierto === k.id_cierre && detalle && <DetalleCierre d={detalle} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DetalleCierre({ d }) {
  return (
    <div className="historial">
      {d.justificacion && <p><strong>Justificación:</strong> {d.justificacion}</p>}
      <div className="tabla-scroll">
        <table className="tabla">
          <thead>
            <tr><th>Método</th><th className="num">Vendido</th><th className="num">Devuelto</th><th className="num">Calculado</th><th className="num">Contado</th><th className="num">Diferencia</th></tr>
          </thead>
          <tbody>
            {d.por_metodo.map((m) => (
              <tr key={m.id_metodo_pago}>
                <td>{m.etiqueta}</td>
                <td className="num">{pesos(m.vendido)}</td>
                <td className="num">{pesos(m.devuelto)}</td>
                <td className="num">{pesos(m.calculado)}</td>
                <td className="num">{pesos(m.reportado)}</td>
                <td className="num">{centavos(m.diferencia) === 0 ? "—" : pesos(m.diferencia)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.por_empleado.length > 0 && (
        <ul className="lineas">
          {d.por_empleado.map((e) => (
            <li key={e.id_empleado}>
              {e.nombre}: {e.metodos.map((x) => `${d.por_metodo.find((m) => m.id_metodo_pago === x.id_metodo_pago)?.etiqueta ?? x.id_metodo_pago} ${pesos(x.vendido)}${centavos(x.devuelto) ? ` (devuelto ${pesos(x.devuelto)})` : ""}`).join(" · ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
