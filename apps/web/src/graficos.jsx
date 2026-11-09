// HU-05: gráficos propios, sin librería. Cada barra lleva su texto y su valor (no depende solo del color) y se imprimen
// igual que en pantalla (PDF).

// Barras horizontales. datos: [{ clave, etiqueta, valor, texto?, detalle?, tono? }]. tono: "agotado" | "bajo" | "media".
export function BarrasH({ datos, formato = String, maximo, titulo }) {
  const tope = maximo ?? Math.max(0, ...datos.map((d) => d.valor));
  if (datos.length === 0) return <p className="muted">Sin datos en el periodo.</p>;
  return (
    <div className="barras" role="list" aria-label={titulo}>
      {datos.map((d) => (
        <div className="barra" role="listitem" key={d.clave ?? d.etiqueta}>
          <span className="barra-etiqueta" title={d.etiqueta}>{d.etiqueta}</span>
          <span className="barra-pista">
            <span
              className={`barra-relleno ${d.tono || ""}`}
              style={{ width: `${tope > 0 ? Math.max(0, Math.min(100, (d.valor / tope) * 100)) : 0}%` }}
            />
          </span>
          <span className="barra-valor">
            {d.texto ?? formato(d.valor)}
            {d.detalle && <span className="muted"> · {d.detalle}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// Stock frente a su mínimo: la pista es el mínimo (o el stock si lo supera) y la marca indica dónde está el mínimo.
export function StockContraMinimo({ datos }) {
  if (datos.length === 0) return <p className="muted">Ningún producto en nivel crítico.</p>;
  return (
    <div className="barras" role="list" aria-label="Stock vendible frente al mínimo">
      {datos.map((d) => {
        const tope = Math.max(d.stock_minimo || 0, d.stock, 1);
        return (
          <div className="barra" role="listitem" key={d.id_medicamento}>
            <span className="barra-etiqueta" title={d.nombre_comercial}>{d.nombre_comercial}</span>
            <span className={`barra-pista ${d.stock === 0 ? "vacia" : ""}`}>
              <span className={`barra-relleno ${d.tipo === "STOCK_AGOTADO" ? "agotado" : d.nivel === "ALTA" ? "bajo" : "media"}`} style={{ width: `${(d.stock / tope) * 100}%` }} />
              {d.stock_minimo > 0 && <span className="barra-marca" style={{ left: `${(d.stock_minimo / tope) * 100}%` }} />}
            </span>
            <span className="barra-valor">
              {d.stock} de mín. {d.stock_minimo ?? "—"}
              <span className="muted"> · {d.tipo === "STOCK_AGOTADO" ? "agotado" : "bajo"}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Columnas por día (tendencia). Con muchos días las columnas se adelgazan; se rotulan el primero, el último y el máximo.
export function Columnas({ datos, formato = String, titulo }) {
  const ancho = 640;
  const alto = 160;
  const base = alto - 18;
  const tope = Math.max(0, ...datos.map((d) => d.valor));
  const paso = ancho / Math.max(datos.length, 1);
  const iMax = datos.findIndex((d) => d.valor === tope);
  const resumen = `${titulo}: máximo ${formato(tope)}${iMax >= 0 ? ` el ${datos[iMax].etiqueta}` : ""}`;
  return (
    <svg className="columnas" viewBox={`0 0 ${ancho} ${alto}`} role="img" aria-label={resumen}>
      <title>{resumen}</title>
      <line x1="0" x2={ancho} y1={base} y2={base} className="eje" />
      {datos.map((d, i) => {
        const h = tope > 0 ? Math.max(0, (d.valor / tope) * (base - 16)) : 0;
        return (
          <rect key={d.etiqueta} x={i * paso + paso * 0.15} width={Math.max(paso * 0.7, 0.5)} y={base - h} height={h} className={d.valor < 0 ? "negativa" : "positiva"}>
            <title>{`${d.etiqueta}: ${formato(d.valor)}`}</title>
          </rect>
        );
      })}
      {datos.length > 0 && <text x="0" y={alto - 4} className="rotulo">{datos[0].etiqueta}</text>}
      {datos.length > 1 && <text x={ancho} y={alto - 4} className="rotulo" textAnchor="end">{datos[datos.length - 1].etiqueta}</text>}
      {tope > 0 && iMax >= 0 && (
        <text x={Math.min(Math.max(iMax * paso + paso / 2, 40), ancho - 40)} y="12" className="rotulo" textAnchor="middle">
          máx. {formato(tope)}
        </text>
      )}
    </svg>
  );
}

// Indicadores principales del reporte.
export function Indicador({ titulo, valor, detalle }) {
  return (
    <div className="kpi">
      <span className="muted">{titulo}</span>
      <strong>{valor}</strong>
      {detalle && <span className="muted">{detalle}</span>}
    </div>
  );
}
