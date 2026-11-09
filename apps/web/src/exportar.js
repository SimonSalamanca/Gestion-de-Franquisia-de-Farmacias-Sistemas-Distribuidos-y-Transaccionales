// HU-05: exportación de lo que se ve en pantalla. Excel: .xlsx real generado en el navegador (la librería se carga
// solo al exportar). PDF: la impresión del navegador con la hoja de estilos @media print de styles.css.

export const dinero = (valor) => ({ value: Number(valor) || 0, format: "#,##0.00" });
export const entero = (valor) => ({ value: Number(valor) || 0, format: "#,##0" });
export const porcentaje = (valor) => ({ value: (Number(valor) || 0) / 100, format: "0.00%" });

// hojas: [{ nombre, columnas: ["Título", ...], filas: [[celda, ...], ...], anchos?: [n, ...] }]
// Una celda es un valor simple (texto, número, null) o { value, format }.
export async function exportarExcel(archivo, hojas) {
  const { default: writeExcelFile } = await import("write-excel-file/browser");
  await writeExcelFile(
    hojas.map((h) => ({
      sheet: h.nombre.replace(/[\\/?*[\]:]/g, " ").slice(0, 31),
      data: [h.columnas.map((c) => ({ value: c, fontWeight: "bold" })), ...h.filas.map((f) => f.map((c) => c ?? null))],
      columns: h.columnas.map((c, i) => ({ width: h.anchos?.[i] ?? Math.max(12, c.length + 2) })),
      stickyRowsCount: 1,
    })),
  ).toFile(archivo);
}

// La impresión de facturas (HU-09) oculta todo menos la factura; esta clase hace que salga el reporte en su lugar.
export function exportarPdf() {
  const quitar = () => {
    document.body.classList.remove("imprimiendo-reporte");
    window.removeEventListener("afterprint", quitar);
  };
  document.body.classList.add("imprimiendo-reporte");
  window.addEventListener("afterprint", quitar);
  window.print();
}

// Nombre de archivo: reporte-tienda_2026-11-01_2026-11-09.xlsx
export function nombreArchivo(prefijo, periodo, extension = "xlsx") {
  return `${prefijo}_${periodo.desde}_${periodo.hasta}.${extension}`;
}
