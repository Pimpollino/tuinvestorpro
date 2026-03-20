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

## v1.1.0 — Reorganización de menús

### Nueva estructura de navegación
- **📊 Cartera**: Resumen global · Fondos (Dashboard + Posiciones) · Acciones (Dashboard + Posiciones)
- **📈 Análisis**: Fondos (Análisis + Fiscal + Rebalanceo) · Acciones (Análisis + Fiscal)
- **🎯 Planificación**: 🔥 FIRE · Metas · Jubilación · Optimizador venta
- **⚙️ Gestión**: Ops. Fondos · Ops. Acciones · Importar datos

### Cambios técnicos
- `switchSection()` reemplaza a `switchBroker()` como función principal de navegación
- `switchBroker()` se mantiene como compatibilidad retroactiva interna
- `ST()` actualiza ahora el botón de sección activo además del sub-botón
- Vista inicial: **Resumen global** (antes era Fondos Dashboard)
- FIRE promovido a sección Planificación (antes estaba en Fondos)
- Importar datos movido a Gestión (antes estaba en Resumen global)

## v1.2.0 — Benchmark mejorado

### Nuevos índices de referencia
- Añadidos a `precio.php`: MSCI World (`URTH`), IBEX 35 (`^IBEX`), Euro Stoxx 50 (`^STOXX50E`), Oro (`GC=F`), Nasdaq 100 (`^NDX`)
- El usuario activa/desactiva cada índice con checkboxes

### Nueva pestaña: Análisis → 📊 Benchmark
- **Selector de índices**: activa los que quieras comparar, se persisten los datos en `price_history`
- **Gráfico comparativo**: % acumulado desde primera fecha disponible de la cartera vs índices seleccionados. Tooltip hover con fecha y valor de cada serie
- **Tabla CAGR**: rentabilidad anualizada por períodos (1A, 3A, 5A, Total) para la cartera y cada índice activo
- Los datos de índices se actualizan automáticamente en cada refresh de precios

### Técnico
- `BENCH_INDICES`: configuración global con key, color y estado enabled por índice
- `_saveBenchSnapshot()`: helper para guardar snapshot en `PRICE_HISTORY`
- `buildCarteSeries()`: construye la serie de rentabilidad de la cartera propia ponderando snapshots de posiciones
- `renderBenchmarkPanel()`, `drawBenchCompare()`, `renderCAGRTable()`, `calcCAGR()`: funciones de rendering

## v1.3.0 — X-Ray Morningstar

### Nueva pestaña: Análisis → 🔬 X-Ray
- **Importador PDF**: sube el X-Ray que genera MyInvestor con Morningstar y la app extrae todos los datos automáticamente
- **Distribución de activos**: % en acciones, obligaciones, efectivo y otro
- **Rentabilidad acumulada**: 3M, 6M, YTD, 1A, 3A, 5A vs benchmark (Mercado Monetario EUR)
- **Estadísticas de riesgo**: Volatilidad, Sharpe, Alfa, Beta, Tracking Error, R²
- **Exposición geográfica**: top 10 países con barras visuales
- **Sectores de renta variable**: todos los sectores con barras de color
- **Tabla de fondos**: rentabilidades oficiales Morningstar 1A/3A/5A y gastos corrientes por fondo

### Técnico
- `xray.php`: parser PHP que usa `pdftotext` para extraer texto y regex para estructurar los datos
- `uploadXRay()`, `renderXRay()`, `xrayOnEnter()`: funciones JS de upload y rendering
- Datos persistidos en `data.json` bajo clave `xray`

## v1.4.0 — X-Ray Morningstar (mejoras)

### Nuevas secciones en X-Ray
- **Top 10 posiciones subyacentes**: acciones y bonos reales que posees a través de los fondos, con tipo y % de cartera
- **Estilo de inversión**: matriz 3×3 (Grande/Mediana/Pequeña × Valor/Mixto/Crecimiento) con colores de intensidad, celda dominante y sesgo automático
- **Coste total ponderado (TER)**: coste real anual de la cartera ponderando gastos de cada fondo por su peso, con semáforo y desglose

### Correcciones X-Ray
- Parser PHP nativo sin shell_exec (compatible con hostings compartidos)
- Números europeos (1.234,56) parseados correctamente con patrón `\d{1,6},\d{2}`
- Rentabilidades: búsqueda en sección correcta del PDF
- Riesgo: evita la etiqueta del gráfico de dispersión
- Países: patrón sin `\b` (word boundary) para texto sin espacios
- Posiciones: ancla `Posiciones de Cartera` en lugar de `AXA` (que aparece en otra sección)
- Estilo matriz: algoritmo iterativo preferible a 2 dígitos → `[16,26,20,6,8,9,5,6,5]` correcto
- Acentos restaurados en nombres de países y sectores

### UX
- Panel de importación se oculta automáticamente cuando ya hay datos — queda barra compacta con fecha y botón Actualizar
- Modal de carga al actualizar precios (auto-refresh y manual)
- Auto-refresh solo se ejecuta tras autenticación (no antes del login)
- `_checkAutoRefresh` como función global nombrada (evitaba `ReferenceError`)
- Debounce guard anti-doble ejecución

### Benchmark
- Configuración de índices activos persiste en `data.json` (`bench_config`)
- Nuevos índices: MSCI World, IBEX 35, Euro Stoxx 50, Oro, Nasdaq 100

## v1.5.0 — Resumen Global & UX

### KPIs Resumen Global
- Nuevo orden: Valor cartera · G/P Latente · G/P Realizada+Dividendos · **G/P Histórica** (nuevo: latente+realiz.+div.) · G/P Histórica total · Fiscal realizado
- Eliminado KPI "Desde el origen" (redundante con G/P Histórica total)
- Eliminado panel fiscal del Resumen Global (ver Análisis → Fiscal)
- Cabecera: añadido % de ganancia junto a Fondos y Acciones (`+69,71 € · +1.4%`)
- Grid KPIs: 6 columnas

### Evolución patrimonial (Opción C)
- Dos líneas: capital aportado acumulado (verde) + punto valor actual hoy (lila/rojo)
- Línea vertical discontinua entre ambos puntos muestra la G/P
- Leyenda con ambos indicadores
- Tooltip hover con capital, valor hoy y diferencia en el último punto
- Título cambiado de "Evolución de aportaciones" a "Evolución patrimonial"

### Composición (tarta)
- Tarta centrada
- Leyenda rediseñada: nombre completo · peso% · G/P% · valor€ (sin ISINs ni texto partido)
- **Tooltip al hover** en cada porción: nombre, peso%, valor€, G/P€ y G/P%
- Tooltip activo también en tartas de Fondos y Acciones

### Desglose por activo
- Eliminado badge ticker redundante (ISIN o nombre corto). Solo tipo Fondo/Acción como píldora

### Distribución fondos / Distribución acciones
- Leyenda rediseñada: nombre completo una línea · peso% · G/P% · valor€
- Misma mejora aplicada a ambas secciones

### Acciones — tablas
- Columna TICKER eliminada de: Resumen posiciones, Posiciones abiertas, Posiciones cerradas, Dividendos cobrados
- Si hay Yahoo ticker real configurado aparece como badge pequeño junto al nombre
- Añadido panel ⚙ Yahoo Tickers para acciones en Cartera → Acciones → Posiciones (mismo diseño que fondos)
- Headers de tablas actualizados

### Modal carga
- Solo se ejecuta si el usuario está autenticado (no antes del login)

## v1.6.0 — Móvil & sincronización de cálculos

### App móvil — sincronización con desktop
- **G/P Histórica**: ahora coincide con desktop (`latente + realizada + dividendos`, sin fondos anteriores)
- **G/P Histórica total**: separada de la anterior (incluye fondos anteriores = "Desde el origen")
- **Acciones G/P**: alineada con desktop mediante FIFO recalculado desde operaciones con FX correcto
- Operaciones EUR ya no se dividen erróneamente por el tipo de cambio EURUSD
- `aRealized` recalculado desde operaciones raw (igual que desktop) en lugar de `DATA.acciones.total_realized`

### App móvil — UX
- KPI principal cambiado de "G/P Histórica" a **G/P Latente** con desglose Fondos / Acciones / Rentabilidad
- Cards de acciones: ISIN eliminado, se muestra **nombre** como título y Yahoo ticker (si existe) como subtítulo
- % cambio día en fondos: ahora funciona correctamente con `_prevClose` real del API

### prev_close — infraestructura
- `portafolio.js`: captura `prev_close` de `precio.php` y lo guarda en `FPOS_RAW._prevClose` / `APOS_RAW._prevClose`
- `portafolio.js`: incluye `prev_close` en el payload de `save_prices` → `guardar.php`
- `guardar.php`: persiste `_prevClose` en cada posición de fondos y acciones en `data.json`
- Resultado: el móvil muestra el % de variación real respecto al último NAV publicado

### Sintaxis
- Corregido bug `var` huérfano en `movil.html` que impedía el login
