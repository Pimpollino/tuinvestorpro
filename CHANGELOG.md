# Changelog — tuinvestorPRO

## v1.0.0 (2026-03)

### Correcciones críticas
- **Importador XLS**: fechas convertidas correctamente de DD/MM/YYYY a YYYY-MM-DD
- **Importador XLS**: precios europeos (ej: `2.616,79`) parseados correctamente
- **Importador XLS**: codificación ISO-8859-1 para nombres con acentos
- **Importador XLS**: operaciones en divisa extranjera marcadas como `fx_pendiente`
- **Fiscal acciones**: IRPF calculado sobre base anual neta (no por operación individual)
- **FIFO acciones**: `calcRealizedAcc` devuelve `salesDetail` con G/P por venta
- **Dividendos**: todos los cálculos usan `importe` del broker (no `qty × precio`)
- **FX acciones**: `closedMap` usa `fx_aplicado` del broker cuando está disponible
- **guardar.php**: `rebalanceo` inicializado como `{universe:[], updated_at:""}` (no `[]`)
- **guardar.php**: `fire` inicializado como `{}` (no `[]`)

### Funcionalidades nuevas
- **Fondos → Cartera**: panel Yahoo Tickers (`f-ticker-config`) ahora visible
- **Fondos → Operaciones**: ordenación por columnas (Tipo, Fondo, Fecha, Total)
- **Fondos → Operaciones**: parser emails Inversis mejorado (más patrones, formato europeo)
- **Fondos → Fiscal**: historial de años completo (no solo año actual + siguiente)
- **Acciones → Fiscal**: tabla ventas con columnas G/P FIFO y Coste base
- **Acciones → Fiscal**: panel años con base imponible real (ventas + dividendos)
- **Resumen Global**: gráfico evolución con tooltip hover
- **FIRE**: gráfico proyección con tooltip hover
- **FIRE**: escenario base buscado por id (no por índice hardcodeado)
- **Rebalanceo**: tabla con nombre primero, ISIN secundario
- `NOMBRE_CORTO_F` y `TICKER_FONDO` poblados en `initMaps()` desde posiciones y operaciones
- Fila TOTAL añadida en tablas de cartera (fondos y acciones)
- Leyendas de tartas muestran nombre completo + ticker pequeño
- Fechas de operaciones renderizadas en formato DD/MM/YYYY (no ISO crudo)
- Columna `≈ EUR` en operaciones de acciones en divisa extranjera

### movil.html
- **divTotal por tarjeta**: dividendos en USD se convertían a EUR incorrectamente (se sumaba el importe nativo sin conversión). Ahora usa `toEUR()` igual que el resto de la app
- **Auto-refresh**: `_checkAutoRefresh` solo comprobaba posiciones de fondos para decidir si actualizar precios — si el usuario solo tenía acciones, nunca auto-refrescaba. Ahora comprueba fondos Y acciones, y usa `_priceDate` (ISO) cuando está disponible antes de caer al campo `fecha_precio`
