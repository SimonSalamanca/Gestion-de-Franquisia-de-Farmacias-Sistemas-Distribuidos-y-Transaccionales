// Error de negocio con respuesta HTTP conocida. Lanzarlo dentro de una transacción la revierte
// y server.mjs lo responde tal cual: { codigo, mensaje, ...extra }.
export class ErrorNegocio extends Error {
  constructor(status, codigo, mensaje, extra = {}) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
    this.extra = extra;
  }

  get body() {
    return { codigo: this.codigo, mensaje: this.message, ...this.extra };
  }
}

export const invalido = (mensaje, extra) => new ErrorNegocio(400, "DATOS_INVALIDOS", mensaje, extra);
export const noEncontrado = (mensaje) => new ErrorNegocio(404, "NO_ENCONTRADO", mensaje);
export const conflicto = (codigo, mensaje, extra) => new ErrorNegocio(409, codigo, mensaje, extra);
