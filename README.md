# tuinvestorPRO 📈

**Herramientas Avanzadas para el Inversor**

Aplicación web de gestión de cartera de inversión personal, diseñada para inversores con fondos de inversión y acciones/ETF en MyInvestor (Inversis).

---

## 📸 Capturas

**Resumen Global — KPIs consolidados, evolución patrimonial y composición**
![Resumen Global](screenshots/screenshot_resumen.png)

**Acciones & ETF — Dashboard con G/P por posición y distribución**
![Acciones Dashboard](screenshots/screenshot_acciones.png)

---

## ✨ Características

### 📊 Cartera
- **Resumen Global** — KPIs consolidados (valor, G/P latente, realizada, dividendos, desde el origen), gráfico de evolución patrimonial, desglose por activo y panel fiscal
- **Fondos de Inversión** — Dashboard con rendimiento por fondo, posiciones con G/P vs coste adquisición y vs cash real, configuración de Yahoo Tickers
- **Acciones & ETF** — Dashboard con G/P por posición, dividendos cobrados, posiciones abiertas y cerradas con FIFO y FX real

### 📈 Análisis
- **Fiscal Fondos** — Reembolsos FIFO con IRPF correcto, traspasos (coste heredado), plusvalías por año
- **Rebalanceo** — Calculadora de aportación óptima con universo de fondos personalizable
- **Fiscal Acciones** — G/P FIFO por venta, base imponible anual, IRPF estimado
- **Benchmark** — Comparativa cartera vs índices de referencia (S&P 500, MSCI World, IBEX 35, Euro Stoxx 50, Oro, Nasdaq 100) con gráfico % acumulado y tabla CAGR 1A/3A/5A/Total
- **🔬 X-Ray Morningstar** — Importa el Resumen Morningstar de MyInvestor y extrae automáticamente:
  - Distribución de activos (acciones, bonos, efectivo, otro)
  - Exposición geográfica con desglose por regiones (Europa/América/Asia y subregiones)
  - Rentabilidades acumuladas vs benchmark (3M, 6M, YTD, 1A, 3A, 5A)
  - Estadísticas de riesgo (Volatilidad, Sharpe, Alfa, Beta, Tracking Error...)
  - Sectores de renta variable
  - Top 10 posiciones subyacentes reales
  - Matriz de estilo de inversión (Grande/Med/Peq × Valor/Mixto/Crecimiento)
  - Coste total ponderado (TER) de la cartera

### 🎯 Planificación
- **🔥 FIRE** — Simulador de independencia financiera con 6 escenarios (pesimista/base/optimista × inflación alta/baja), FIRE anticipado, herencia, ajuste fiscal España
- **Metas de ahorro** — Proyección para gastos futuros (universidad, viaje, etc.)
- **Jubilación & Herencia** — Simulación año a año con inflación, tasa de retiro, step-up fiscal
- **Optimizador de venta** — Plan de desinversión fiscalmente óptimo (FIFO, tramos IRPF, minusvalías primero)

### ⚙️ Gestión
- **Operaciones Fondos** — Formulario completo con parser de emails de confirmación Inversis
- **Operaciones Acciones** — Soporte multi-divisa (USD/GBP/CHF) con badge FX pendiente
- **📥 Importar datos** — Importador XLS desde Inversis con deduplicación automática y corrección de FX para operaciones en divisa extranjera

---

## 🗂️ Estructura de ficheros

```
tuinvestorpro/
├── index.html          # Interfaz principal (SPA)
├── movil.html          # Versión móvil optimizada (responsive, auto-refresh)
├── portafolio.js       # Lógica completa (~6500 líneas)
├── guardar.php         # API backend (operaciones CRUD, reset, importación)
├── precio.php          # Proxy Yahoo Finance / FT (precios NAV, cotizaciones e índices)
├── xray.php            # Parser PDF nativo para el Resumen Morningstar de MyInvestor
├── data.json           # Base de datos (NO subir con datos reales)
├── logo.png            # Logo de la aplicación
├── .gitignore          # Excluye data.json con datos reales y backups
├── screenshots/        # Capturas de pantalla
└── README.md           # Este fichero
```

---

## 🚀 Instalación

### Requisitos
- Servidor web con **PHP 8.x**
- Extensiones PHP: `zlib`, `mbstring` (para el parser X-Ray)
- Acceso a internet (para obtener precios de Yahoo Finance y FT)
- Navegador moderno (Chrome, Firefox, Safari, Edge)

### Pasos
1. Clona o descarga el repositorio
2. Sube todos los ficheros a tu servidor web (ej: `/public_html/tuinvestor/`)
3. Da permisos de escritura a `data.json`:
   ```bash
   chmod 664 data.json
   chown www-data:www-data data.json
   ```
4. Accede desde el navegador: `https://tudominio.com/tuinvestor/`
5. Credenciales por defecto: **`tuinvestor` / `12345678`**
6. **Cambia la contraseña inmediatamente** desde ⚙ → Configuración

---

## 🔐 Seguridad

- Autenticación por hash SHA-256 almacenado en `data.json`
- Cambio de credenciales desde la propia interfaz
- `data.json` **nunca debe ser público** — añade protección en `.htaccess`:
  ```apache
  <Files "data.json">
      Require all denied
  </Files>
  ```
- Los backups (`.bak`) se generan automáticamente antes de cada reset — elimínalos periódicamente
- `xray.php` funciona con PHP puro, sin `shell_exec` ni funciones de sistema deshabilitadas en hostings compartidos

---

## 📥 Importación de datos

### Desde Inversis (XLS)
1. En Inversis: **Mi cartera → Movimientos → Exportar → Excel (.XLS)**
2. En la app: **Gestión → Importar datos**
3. Las operaciones ya existentes se omiten automáticamente (deduplicación por referencia)
4. Las operaciones en divisa extranjera (USD, GBP) se marcan con ⚠ FX para verificar el tipo de cambio real

### X-Ray Morningstar
1. En MyInvestor: **Mi ahorro e inversión → Fondos de inversión → Resumen Morningstar**
2. Descarga el PDF
3. En la app: **Análisis → 🔬 X-Ray** → Seleccionar PDF X-Ray
4. La app extrae todos los datos automáticamente

---

## ⚙️ Configuración de precios

Cada fondo necesita un **Yahoo Ticker** para obtener el NAV actualizado:

1. Ve a **Cartera → Fondos → Posiciones** → panel ⚙ Yahoo Tickers (al final)
2. Usa el botón 🔍 para buscar automáticamente por ISIN
3. Pulsa 💾 para guardar

Para acciones, el ticker Yahoo se configura en **Cartera → Acciones → Posiciones**.

### Benchmark
En **Análisis → Benchmark** puedes activar los índices que quieras comparar con tu cartera:
- S&P 500, MSCI World, IBEX 35, Euro Stoxx 50, Oro, Nasdaq 100
- Los datos se acumulan diariamente con cada refresh — el gráfico mejora con el tiempo

---

## 🛠️ Tecnología

- **Frontend**: HTML5 + CSS3 + JavaScript ES5 (vanilla, sin dependencias)
- **Backend**: PHP 8.x (tres ficheros: `guardar.php`, `precio.php`, `xray.php`)
- **Datos**: JSON plano (`data.json`) — sin base de datos
- **Precios**: Yahoo Finance API + Financial Times (fallback para fondos)
- **Charts**: Canvas 2D nativo (sin librerías de gráficos)
- **PDF Parser**: PHP nativo con decodificación de fuentes CID (sin pdftotext)

---

## 📝 Notas importantes

- `data.json` es la única base de datos — **haz copias de seguridad regularmente**
- El servidor hace backup automático antes de cada reset (ficheros `.bak`)
- Los precios se actualizan automáticamente al entrar (si los datos no son de hoy)
- Los traspasos entre fondos son fiscalmente neutros (coste heredado automáticamente)
- El cálculo FIFO para acciones usa el tipo de cambio real del broker (`fx_aplicado`)
- El X-Ray Morningstar se actualiza mensualmente — reimporta el PDF cada mes

---

## 📄 Licencia

Uso personal. No redistribuir sin permiso del autor.
