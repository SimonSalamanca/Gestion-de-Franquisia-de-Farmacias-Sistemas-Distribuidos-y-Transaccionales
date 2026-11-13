// Las pruebas y el mantenimiento usan el dueño de la base: limpian datos y crean bases de prueba, cosas que el rol de
// aplicación no puede hacer (docs/seguridad/datos-personales.md, fase 5). Este import debe ir PRIMERO en cada script,
// antes de cualquier import de apps/api, porque db.mjs elige la conexión al cargarse.
process.env.FARMAHUB_ROL = "owner";
