// ════════════════════════════════════════════════════════════════
//  PORTAFOLIO.JS  v4.0  —  datos reales gestora
// ════════════════════════════════════════════════════════════════

var FX_TABLE = {};
var FPOS_RAW = [];   // posiciones fondos (del broker, valores actuales)
var FOPS_RAW = [];   // todas las operaciones de fondos
var APOS_RAW = [];   // posiciones acciones (del broker)
var AOPS_RAW = [];   // todas las operaciones de acciones/ETF

// Datos procesados (rellenados por init)
var FPOS = [];       // fondos con campos calculados
var APOS = [];       // acciones con campos calculados
var FOPS = [];       // operaciones fondos normalizadas
var AOPS = [];       // operaciones acciones normalizadas
var PRICE_HISTORY = {}; // snapshots {isin: [{date,price}]}

var BENCH = [];
var DATA_RAW = null;
var _PRICES_LOADED = false;  // true solo tras un refresh real de precios
var REEMBOLSOS_BROKER = []; // reembolsos tributables calculados por el broker (FIFO exacto)

// ── Debounce para simuladores (evita recalcular en cada tecla) ──
function _debounce(fn, delay) {
  var timer = null;
  return function() { if (timer) clearTimeout(timer); timer = setTimeout(fn, delay); };
}
var debouncedOptimizador = _debounce(function(){ renderOptimizador(); }, 300);
var debouncedMetas       = _debounce(function(){ renderMetas(); },       300);
var debouncedJubilacion  = _debounce(function(){ renderJubilacion(); },  300);

function _canvasW(fraction) {
  var wrap = document.getElementById('wrap');
  var total = wrap ? wrap.offsetWidth : (window.innerWidth - 64);
  return Math.floor(total * (fraction || 0.48)) - 24;
}


function drawFundPerf(id) {
  var cv = document.getElementById(id); if (!cv) return;
  var priceHist = PRICE_HISTORY || {};
  if (!Object.keys(priceHist).length) return;

  var activeFunds = FPOS_RAW.filter(function(p){ return p.titulos > 0 && priceHist[p.isin]; });
  if (!activeFunds.length) return;

  // FIX 4: colores estables por ISIN (hash determinista, no por índice de array)
  var _colorPalette = ['#a78bfa','#f97316','#60a5fa','#f43f5e','#34d399','#00b8d4','#f5c842','#e879f9'];
  function _isinColor(isin) {
    var h = 0;
    for (var i = 0; i < isin.length; i++) h = (h * 31 + isin.charCodeAt(i)) & 0xfffffff;
    return _colorPalette[h % _colorPalette.length];
  }

  // FIX 2: guardar TODOS los puntos raw, sin downsampling aquí.
  // El downsampling se hace en redraw() después de filtrar por periodo,
  // para que periodos cortos (1M, 3M) tengan resolución completa.
  var series = activeFunds.map(function(fund) {
    var snaps = priceHist[fund.isin];
    var fundOps = FOPS_RAW.filter(function(o){
      return o.isin === fund.isin && (o.tipo === 'suscripcion' || o.tipo === 'traspaso_entrada');
    }).sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
    if (!fundOps.length) return null;
    var firstDate = fundOps[0].fecha;
    var baseSnap = snaps.filter(function(s){ return s.date >= firstDate; })[0];
    if (!baseSnap) return null;
    var basePrice = baseSnap.price;
    var rawPoints = [];
    snaps.forEach(function(s) {
      if (s.date >= firstDate)
        rawPoints.push({ date: s.date, pct: (s.price - basePrice) / basePrice * 100 });
    });
    if (rawPoints.length < 2) return null;
    return {
      isin:      fund.isin,
      name:      NOMBRE_CORTO_F[fund.isin] || fund.isin.substring(0,8),
      color:     _isinColor(fund.isin),
      rawPoints: rawPoints
    };
  }).filter(Boolean);

  // S&P 500 benchmark
  var sp500raw = priceHist['SP500'];
  var earliestDate = series.length ? series.reduce(function(min,s){
    var d = s.rawPoints[0] ? s.rawPoints[0].date : '9999'; return d < min ? d : min;
  }, '9999') : null;
  if (sp500raw && earliestDate) {
    var spBase = sp500raw.filter(function(s){ return s.date >= earliestDate; })[0];
    if (spBase) {
      var spRaw = [];
      sp500raw.forEach(function(s) {
        if (s.date >= earliestDate)
          spRaw.push({ date: s.date, pct: (s.price - spBase.price) / spBase.price * 100 });
      });
      if (spRaw.length >= 2)
        series.push({ isin: 'SP500', name: 'S&P 500', color: '#f5c84266', rawPoints: spRaw, isBench: true });
    }
  }

  if (!series.length) return;

  // Visibility state — persisted via legEl dataset
  var isModal = window._fundPerfModal && id === 'c-fund-perf-modal';
  var legEl = document.getElementById(isModal ? 'fund-perf-legend-modal' : 'fund-perf-legend');
  var hidden = {};
  if (legEl && legEl.dataset.hidden) {
    try { hidden = JSON.parse(legEl.dataset.hidden); } catch(e){}
  }

  // Cache para tooltip overlay (evita redibujado completo en mousemove)
  var _baseImageData = null;
  var _renderCtx     = null;
  var _renderState   = null;

  function redraw() {
    // ── Periodo ─────────────────────────────────────────────────
    var periodFrom = null;
    var nowD = new Date();
    var per = window._fundPerfPeriod || 'max';
    var pd;
    if (per === '1m')  { pd = new Date(nowD); pd.setMonth(pd.getMonth()-1);       periodFrom = pd.toISOString().substring(0,10); }
    if (per === '3m')  { pd = new Date(nowD); pd.setMonth(pd.getMonth()-3);       periodFrom = pd.toISOString().substring(0,10); }
    if (per === '6m')  { pd = new Date(nowD); pd.setMonth(pd.getMonth()-6);       periodFrom = pd.toISOString().substring(0,10); }
    if (per === '1y')  { pd = new Date(nowD); pd.setFullYear(pd.getFullYear()-1); periodFrom = pd.toISOString().substring(0,10); }
    if (per === 'ytd') { periodFrom = nowD.getFullYear()+'-01-01'; }

    // FIX 2: filtrar al periodo Y LUEGO downsamplear (máx 120 pts sobre el rango visible)
    var filteredSeries = series.map(function(s) {
      var pts = periodFrom
        ? s.rawPoints.filter(function(pt){ return pt.date >= periodFrom; })
        : s.rawPoints;
      if (pts.length < 2) return null;
      var base = pts[0].pct;
      var rebased = pts.map(function(pt){ return { date: pt.date, pct: pt.pct - base }; });
      var maxPts = 120;
      var step = Math.max(1, Math.floor(rebased.length / maxPts));
      var sampled = [];
      rebased.forEach(function(pt, i){
        if (i % step === 0 || i === rebased.length - 1) sampled.push(pt);
      });
      return Object.assign({}, s, { points: sampled });
    }).filter(Boolean);

    var isModalCanvas = (id === 'c-fund-perf-modal');
    var W = isModalCanvas ? (window.innerWidth - 48) : (_canvasW(1.0) || 600);
    if (W < 200) W = 600;
    var H = isModalCanvas ? (window.innerHeight - 130) : parseInt(cv.getAttribute('height') || 340);
    cv.width = W; cv.height = H;
    var pad = {t:14, r:16, b:28, l:50};
    var iW = W - pad.l - pad.r;
    var iH = H - pad.t - pad.b;
    // willReadFrequently: true evita la advertencia de Canvas2D al usar getImageData en el tooltip
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0,0,W,H);

    var visibleSeries = filteredSeries.filter(function(s){ return !hidden[s.isin]; });

    // Escala Y
    var allPcts = [0];
    visibleSeries.forEach(function(s){ s.points.forEach(function(pt){ allPcts.push(pt.pct); }); });
    var mn = Math.min.apply(null, allPcts);
    var mx = Math.max.apply(null, allPcts);
    var pad_pct = Math.max((mx - mn) * 0.08, 1);
    mn -= pad_pct; mx += pad_pct;
    var rng = mx - mn || 1;

    // Rango de fechas
    var allDates = [];
    visibleSeries.forEach(function(s){ s.points.forEach(function(pt){ allDates.push(pt.date); }); });
    allDates = allDates.filter(function(v,i,a){ return a.indexOf(v)===i; }).sort();
    var n = allDates.length; if (!n) return;
    var d0Ms = new Date(allDates[0]).getTime();
    var d1Ms = new Date(allDates[n-1]).getTime();

    function tx(date) {
      var ms = new Date(date).getTime();
      return pad.l + ((ms - d0Ms) / Math.max(d1Ms - d0Ms, 1)) * iW;
    }
    function ty(v) { return pad.t + iH - ((v - mn) / rng) * iH; }

    // Grid
    ctx.strokeStyle = '#1a2a3d'; ctx.lineWidth = 1;
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.t + iH*(gi/4);
      var gv = mx - rng*(gi/4);
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l+iW, gy); ctx.stroke();
      ctx.fillStyle = '#4a6785'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
      ctx.fillText((gv>=0?'+':'')+gv.toFixed(1)+'%', pad.l-3, gy+3);
    }
    // Línea de cero
    ctx.strokeStyle = '#2a3a4d'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pad.l, ty(0)); ctx.lineTo(pad.l+iW, ty(0)); ctx.stroke();

    // FIX 5: etiquetas X usando tx() (tiempo proporcional), no índice uniforme
    ctx.fillStyle = '#4a6785'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    var xStep = Math.max(1, Math.floor(n / 7));
    allDates.forEach(function(dt, i) {
      if (i % xStep !== 0 && i !== n-1) return;
      var parts = dt.split('-');
      var label = parts[2]+'/'+parts[1].replace(/^0/,'')+("'"+parts[0].substring(2));
      ctx.fillText(label, tx(dt), H-4);
    });

    // Dibujar líneas
    visibleSeries.forEach(function(s) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth    = s.isBench ? 1.5 : 2;
      ctx.setLineDash(s.isBench ? [4,3] : []);
      ctx.globalAlpha  = s.isBench ? 0.55 : 0.9;
      ctx.beginPath();
      var started = false;
      s.points.forEach(function(pt) {
        var x = tx(pt.date), y = ty(pt.pct);
        started ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
        started = true;
      });
      ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1.0;
      // Punto final
      var last = s.points[s.points.length-1];
      if (!last) return;
      ctx.beginPath(); ctx.arc(tx(last.date), ty(last.pct), s.isBench ? 2 : 3, 0, Math.PI*2);
      ctx.fillStyle = s.color; ctx.fill();
    });

    // FIX 3: etiquetas finales con detección de colisiones
    var endLabels = [];
    visibleSeries.forEach(function(s) {
      if (s.isBench) return;
      var last = s.points[s.points.length-1]; if (!last) return;
      endLabels.push({ s: s, lx: tx(last.date), ly: ty(last.pct), pct: last.pct });
    });
    // Ordenar por Y para resolver colisiones de arriba a abajo
    endLabels.sort(function(a,b){ return a.ly - b.ly; });
    var minGap = 12;
    var usedY = [];
    endLabels.forEach(function(el) {
      var y = el.ly - 5;
      usedY.forEach(function(uy){
        if (Math.abs(y - uy) < minGap) y = uy - minGap;
      });
      y = Math.max(pad.t + 8, Math.min(H - pad.b - 4, y));
      usedY.push(y);
      ctx.fillStyle   = el.s.color;
      ctx.font        = 'bold 9px monospace';
      ctx.textAlign   = 'right';
      ctx.fillText((el.pct>=0?'+':'')+el.pct.toFixed(1)+'%', el.lx - 5, y);
    });

    // Leyenda
    if (legEl && !legEl.dataset.built) {
      legEl.dataset.built = '1';
      legEl.innerHTML = series.map(function(s) {
        var opacity = hidden[s.isin] ? '0.3' : '1';
        var dash = s.isBench
          ? 'border-bottom:2px dashed '+s.color+';background:transparent'
          : 'background:'+s.color;
        return '<span data-isin="'+s.isin+'" style="cursor:pointer;opacity:'+opacity+
               '" title="'+(KNOWN_FONDOS[s.isin] ? KNOWN_FONDOS[s.isin].nombre : s.isin)+
               '" onclick="FUND_PERF_TOGGLE(\''+s.isin+'\')">' +
               '<span class="ld" style="'+dash+'"></span>'+s.name+'</span>';
      }).join('');
    } else if (legEl) {
      series.forEach(function(s) {
        var el = legEl.querySelector('[data-isin="'+s.isin+'"]');
        if (el) el.style.opacity = hidden[s.isin] ? '0.3' : '1';
      });
    }

    // Guardar imagen base para overlay de tooltip
    try { _baseImageData = ctx.getImageData(0, 0, W, H); } catch(e){}
    _renderCtx   = ctx;
    _renderState = { tx: tx, ty: ty, visibleSeries: visibleSeries,
                     pad: pad, W: W, H: H, iH: iH };
  }

  // FIX 1: Tooltip en hover ─────────────────────────────────────
  function drawTooltip(mouseX) {
    if (!_baseImageData || !_renderState) return;
    var rs  = _renderState;
    var ctx = _renderCtx;

    // Buscar la fecha más cercana al cursor entre todos los puntos visibles
    var bestDate = null, bestDist = Infinity;
    rs.visibleSeries.forEach(function(s) {
      s.points.forEach(function(pt) {
        var dist = Math.abs(rs.tx(pt.date) - mouseX);
        if (dist < bestDist) { bestDist = dist; bestDate = pt.date; }
      });
    });
    if (!bestDate || bestDist > 40) {
      ctx.putImageData(_baseImageData, 0, 0);
      return;
    }

    ctx.putImageData(_baseImageData, 0, 0);

    var xLine = rs.tx(bestDate);

    // Línea vertical crosshair
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4,3]);
    ctx.beginPath();
    ctx.moveTo(xLine, rs.pad.t);
    ctx.lineTo(xLine, rs.pad.t + rs.iH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Recoger valores de cada serie en esa fecha
    var rows = [];
    rs.visibleSeries.forEach(function(s) {
      var best = null, bd = Infinity;
      s.points.forEach(function(pt) {
        var d = Math.abs(new Date(pt.date) - new Date(bestDate));
        if (d < bd) { bd = d; best = pt; }
      });
      if (!best) return;
      rows.push({ name: s.name, color: s.color, pct: best.pct, isBench: s.isBench });
    });
    if (!rows.length) return;

    // Dimensiones del tooltip
    ctx.font = '10px monospace';
    var dp = bestDate.split('-');
    var dateLabel = dp[2]+'/'+dp[1]+'/'+dp[0].substring(2);
    var maxW = ctx.measureText(dateLabel).width;
    rows.forEach(function(r) {
      var w = ctx.measureText(r.name + '   ' + (r.pct>=0?'+':'')+r.pct.toFixed(2)+'%').width;
      if (w > maxW) maxW = w;
    });
    var tw = maxW + 28;
    var th = 18 + rows.length * 15 + 6;

    // Posición del tooltip
    var tx2 = xLine + 12;
    if (tx2 + tw > rs.W - 4) tx2 = xLine - tw - 12;
    var ty2 = rs.pad.t + 8;

    // Caja tooltip con esquinas redondeadas
    ctx.fillStyle   = 'rgba(13,20,32,0.93)';
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth   = 1;
    var cr = 5;
    ctx.beginPath();
    ctx.moveTo(tx2+cr, ty2);
    ctx.lineTo(tx2+tw-cr, ty2);
    ctx.quadraticCurveTo(tx2+tw, ty2,    tx2+tw, ty2+cr);
    ctx.lineTo(tx2+tw, ty2+th-cr);
    ctx.quadraticCurveTo(tx2+tw, ty2+th, tx2+tw-cr, ty2+th);
    ctx.lineTo(tx2+cr, ty2+th);
    ctx.quadraticCurveTo(tx2, ty2+th,    tx2, ty2+th-cr);
    ctx.lineTo(tx2, ty2+cr);
    ctx.quadraticCurveTo(tx2, ty2,       tx2+cr, ty2);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // Fecha (cabecera)
    ctx.fillStyle = '#7a98b8';
    ctx.font      = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(dateLabel, tx2+10, ty2+13);

    // Filas de series
    rows.forEach(function(r, i) {
      var y = ty2 + 26 + i*15;
      ctx.beginPath(); ctx.arc(tx2+13, y-3, 3, 0, Math.PI*2);
      ctx.fillStyle = r.color; ctx.fill();
      ctx.fillStyle = r.isBench ? '#7a98b8' : '#dde6f0';
      ctx.font      = (r.isBench ? '' : 'bold ') + '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(r.name, tx2+22, y);
      ctx.fillStyle = r.pct >= 0 ? '#00e5b0' : '#ff3d5a';
      ctx.font      = 'bold 10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText((r.pct>=0?'+':'')+r.pct.toFixed(2)+'%', tx2+tw-8, y);
    });

    // Punto sobre cada línea en la fecha del cursor
    rs.visibleSeries.forEach(function(s) {
      var best = null, bd = Infinity;
      s.points.forEach(function(pt) {
        var d = Math.abs(new Date(pt.date) - new Date(bestDate));
        if (d < bd) { bd = d; best = pt; }
      });
      if (!best) return;
      ctx.beginPath();
      ctx.arc(xLine, rs.ty(best.pct), s.isBench ? 3 : 4, 0, Math.PI*2);
      ctx.fillStyle  = s.color;
      ctx.globalAlpha = s.isBench ? 0.6 : 1.0;
      ctx.fill();
      ctx.globalAlpha = 1.0;
    });
  }

  // Registrar mousemove/mouseleave una sola vez por canvas
  if (!cv._fundPerfHover) {
    cv._fundPerfHover = true;
    cv.style.cursor = 'crosshair';
    cv.addEventListener('mousemove', function(e) {
      var rect   = cv.getBoundingClientRect();
      var mouseX = (e.clientX - rect.left) * (cv.width / rect.width);
      drawTooltip(mouseX);
    });
    cv.addEventListener('mouseleave', function() {
      if (_baseImageData && _renderCtx)
        _renderCtx.putImageData(_baseImageData, 0, 0);
    });
  }

  // Controles globales ──────────────────────────────────────────
  window.FUND_PERF_TOGGLE = function(isin) {
    hidden[isin] = !hidden[isin];
    if (legEl) legEl.dataset.hidden = JSON.stringify(hidden);
    redraw();
  };

  if (legEl) { legEl.dataset.built = ''; }

  window.FUND_PERF_PERIOD = function(period) {
    window._fundPerfPeriod = period;
    var btns = document.querySelectorAll('.fp-btn[data-period]');
    btns.forEach(function(b){ b.classList.toggle('active', b.dataset.period === period); });
    redraw();
  };

  window.FUND_PERF_EXPAND = function() {
    var modal = document.getElementById('fund-perf-modal');
    if (!modal) return;
    var isOpen = modal.classList.contains('open');
    if (isOpen) {
      modal.classList.remove('open');
      document.body.style.overflow = '';
      window._fundPerfModal = false;
      drawFundPerf('c-fund-perf');
    } else {
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
      window._fundPerfModal = true;
      setTimeout(function() { drawFundPerf('c-fund-perf-modal'); }, 30);
    }
  };

  if (!window._fundPerfEscBound) {
    window._fundPerfEscBound = true;
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        var modal = document.getElementById('fund-perf-modal');
        if (modal && modal.classList.contains('open')) FUND_PERF_EXPAND();
      }
    });
  }

  redraw();
}
function benchMonthEnd(label) {
  // FIX 6: usar Date(year, month, 0) para calcular el último día real del mes
  // Esto maneja años bisiestos (Feb 2024 = 29 días) automáticamente
  var ms = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
            Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
  var m3   = label.substring(0,3);
  var year = parseInt('20' + label.substring(4), 10);
  var mon  = parseInt(ms[m3], 10);
  var lastDay = new Date(year, mon, 0).getDate();
  return year + '-' + ms[m3] + '-' + (lastDay < 10 ? '0' : '') + lastDay;
}

function drawBench(id) {
  var cv = document.getElementById(id); if (!cv || !BENCH.length) return;
  var ctx = cv.getContext('2d');
  var W = _canvasW(0.62);
  if (W < 80) W = 380;
  cv.width = W; cv.height = parseInt(cv.getAttribute('height') || 190);
  var H = cv.height, p = {t:12, r:14, b:28, l:58}, iW = W-p.l-p.r, iH = H-p.t-p.b;
  ctx.clearRect(0,0,W,H);

  var vals = BENCH.map(function(b){ return b.v; });
  var invs = BENCH.map(function(b){ return b.i; });
  var all  = vals.concat(invs);
  var mn = Math.min.apply(null, all) * 0.97;
  var mx = Math.max.apply(null, all) * 1.02;
  var rng = mx - mn || 1;
  var n = BENCH.length;

  function tx(i) { return p.l + i * (iW / (n-1)); }
  function ty(v) { return p.t + iH - ((v - mn) / rng) * iH; }

  // Grid lines
  ctx.strokeStyle = '#1a2a3d'; ctx.lineWidth = 1;
  for (var gi = 0; gi <= 4; gi++) {
    var gy = p.t + iH * (gi/4), gv = mx - rng*(gi/4);
    ctx.beginPath(); ctx.moveTo(p.l, gy); ctx.lineTo(p.l+iW, gy); ctx.stroke();
    ctx.fillStyle = '#4a6785'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    ctx.fillText(gv >= 1000 ? (gv/1000).toFixed(1)+'k' : gv.toFixed(0), p.l-3, gy+3);
  }

  // X labels
  ctx.fillStyle = '#4a6785'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
  BENCH.forEach(function(b, i) {
    if (i % 2 === 0) ctx.fillText(b.m, tx(i), H-4);
  });

  // Fill area inversión
  ctx.beginPath();
  ctx.moveTo(tx(0), ty(invs[0]));
  invs.forEach(function(v, i) { ctx.lineTo(tx(i), ty(v)); });
  ctx.lineTo(tx(n-1), p.t+iH); ctx.lineTo(tx(0), p.t+iH); ctx.closePath();
  ctx.fillStyle = '#f5c84218'; ctx.fill();

  // Line inversión (dashed)
  ctx.setLineDash([5,4]); ctx.strokeStyle = '#f5c842'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  invs.forEach(function(v, i) { i ? ctx.lineTo(tx(i), ty(v)) : ctx.moveTo(tx(i), ty(v)); });
  ctx.stroke(); ctx.setLineDash([]);

  // Fill area valor
  ctx.beginPath();
  ctx.moveTo(tx(0), ty(vals[0]));
  vals.forEach(function(v, i) { ctx.lineTo(tx(i), ty(v)); });
  ctx.lineTo(tx(n-1), p.t+iH); ctx.lineTo(tx(0), p.t+iH); ctx.closePath();
  ctx.fillStyle = '#00e5b018'; ctx.fill();

  // Line valor (solid)
  ctx.strokeStyle = '#00e5b0'; ctx.lineWidth = 2.5;
  ctx.beginPath();
  vals.forEach(function(v, i) { i ? ctx.lineTo(tx(i), ty(v)) : ctx.moveTo(tx(i), ty(v)); });
  ctx.stroke();

  // Dot at last point
  var lx = tx(n-1), ly = ty(vals[n-1]);
  ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI*2);
  ctx.fillStyle = '#00e5b0'; ctx.fill();

  // Label last value
  var last = BENCH[n-1];
  var pctStr = (last.p >= 0 ? '+' : '') + last.p.toFixed(1) + '%';
  ctx.fillStyle = last.p >= 0 ? '#00e5b0' : '#ff3d5a';
  ctx.font = 'bold 11px monospace'; ctx.textAlign = 'right';
  ctx.fillText(pctStr, lx, ly - 8);

  // ── Per-fund lines ──────────────────────────────────────────
  var fundColors = ['#a78bfa','#f97316','#60a5fa','#f43f5e','#f5c842','#34d399'];
  var activeFunds = FPOS_RAW.filter(function(p){ return p.titulos > 0; });
  var months = BENCH.map(function(b){ return b.m; });

  activeFunds.forEach(function(fund, fi) {
    // For each benchmark month, estimate this fund's value proportionally
    var fundVals = months.map(function(mLabel, mi) {
      // Reconstruct each fund's coste_adq as of month end
      var mEnd = benchMonthEnd(mLabel);
      var costs = {};
      var lots  = {};
      FOPS_RAW.forEach(function(op) {
        if (op.fecha > mEnd) return;
        var isin = op.isin;
        if (!costs[isin]) { costs[isin] = 0; lots[isin] = []; }
        var qty = parseFloat(op.titulos)||0, price = parseFloat(op.precio)||0;
        if (op.tipo === 'suscripcion' || op.tipo === 'traspaso_entrada') {
          lots[isin].push({qty:qty, price:price});
          costs[isin] += qty * price;
        } else if (op.tipo === 'reembolso' || op.tipo === 'traspaso_salida') {
          var rem = qty;
          while (rem > 0.00001 && lots[isin] && lots[isin].length) {
            var use = Math.min(rem, lots[isin][0].qty);
            costs[isin] -= use * lots[isin][0].price;
            lots[isin][0].qty -= use; rem -= use;
            if (lots[isin][0].qty < 0.00001) lots[isin].shift();
          }
          costs[isin] = Math.max(0, costs[isin]);
        }
      });
      var totalCost = Object.keys(costs).reduce(function(s,k){ return s + costs[k]; }, 0);
      var fundCost  = costs[fund.isin] || 0;
      if (totalCost <= 0 || fundCost <= 0) return null;
      return BENCH[mi].v * (fundCost / totalCost);
    });

    // Only draw if fund existed in at least 2 months
    var validPoints = fundVals.filter(function(v){ return v !== null; });
    if (validPoints.length < 2) return;

    var col = fundColors[fi % fundColors.length];
    ctx.setLineDash([3,3]); ctx.strokeStyle = col; ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    var started = false;
    fundVals.forEach(function(v, i) {
      if (v === null) return;
      started ? ctx.lineTo(tx(i), ty(v)) : ctx.moveTo(tx(i), ty(v));
      started = true;
    });
    ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1.0;

    // Label at last valid point
    var lastIdx = fundVals.reduce(function(a,v,i){ return v !== null ? i : a; }, -1);
    if (lastIdx >= 0) {
      var flx = tx(lastIdx), fly = ty(fundVals[lastIdx]);
      var shortName = NOMBRE_CORTO_F[fund.isin] || fund.isin.substring(0,8);
      ctx.fillStyle = col; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'right';
      ctx.fillText(shortName, flx - 4, fly - 4);
    }
  });
}

var AUTH_HASH_CLIENT = 'b920988cc2ef76ff726fa53d13598502215935543361aa7557fb984905434a46'; // tuinvestor:12345678 — se sobreescribe con data.json en init()
// URLs y mapas construidos dinamicamente en initMaps() tras cargar data.json
var FT_URL = {};
var KNOWN_FONDOS   = {};
var KNOWN_ACCIONES = {};
var YAHOO_GLOBAL   = {};

function initMaps(data) {
  FT_URL = {}; KNOWN_FONDOS = {}; KNOWN_ACCIONES = {}; YAHOO_GLOBAL = {};
  // Fix: poblar NOMBRE_CORTO_F y TICKER_FONDO — eran mapas declarados pero nunca rellenados
  NOMBRE_CORTO_F = {}; TICKER_FONDO = {};
  PRICE_HISTORY = data.price_history || {};
  (data.fondos.posiciones || []).forEach(function(p) {
    if (p.isin) {
      FT_URL[p.isin]       = 'https://markets.ft.com/data/funds/tearsheet/summary?s=' + p.isin + ':EUR';
      KNOWN_FONDOS[p.isin] = { nombre: p.nombre, yahoo_ticker: p.yahoo_ticker || null };
      if (p.yahoo_ticker)  YAHOO_GLOBAL[p.isin] = p.yahoo_ticker;
      // Nombre corto: primeras 3 palabras del nombre del fondo
      NOMBRE_CORTO_F[p.isin] = p.nombre.split(' ').slice(0, 3).join(' ');
      TICKER_FONDO[p.isin]   = p.isin.substring(0, 8);
    }
  });
  // También incluir fondos de las operaciones (fondos cerrados que ya no están en posiciones)
  (data.fondos.operaciones || []).forEach(function(o) {
    if (o.isin && o.nombre && !NOMBRE_CORTO_F[o.isin]) {
      NOMBRE_CORTO_F[o.isin] = o.nombre.split(' ').slice(0, 3).join(' ');
      TICKER_FONDO[o.isin]   = o.isin.substring(0, 8);
    }
  });
  (data.acciones.posiciones || []).forEach(function(p) {
    if (p.ticker) {
      KNOWN_ACCIONES[p.ticker] = {
        nombre:       p.nombre,
        isin:         p.isin        || '',
        tipo:         p.tipo_activo || 'Acción',
        divisa:       p.divisa      || 'EUR',
        yahoo_ticker: p.yahoo_ticker || null,
      };
      if (p.isin && p.yahoo_ticker) YAHOO_GLOBAL[p.isin] = p.yahoo_ticker;
    }
  });
}
// ── Configuración de índices de Benchmark ────────────────────────
var BENCH_INDICES = {
  '^GSPC':     { name: 'S&P 500',       key: 'SP500',      color: '#f5c842', enabled: true  },
  'URTH':      { name: 'MSCI World',    key: 'MSCI_WORLD', color: '#00e5b0', enabled: false },
  '^IBEX':     { name: 'IBEX 35',       key: 'IBEX35',     color: '#f97316', enabled: false },
  '^STOXX50E': { name: 'Euro Stoxx 50', key: 'STOXX50',    color: '#60a5fa', enabled: false },
  'GC=F':      { name: 'Oro',           key: 'GOLD',       color: '#f5c842', enabled: false },
  '^NDX':      { name: 'Nasdaq 100',    key: 'NDX100',     color: '#a78bfa', enabled: false }
};
// Estado persistente (sobrescrito por data.json si existe)
window._benchConfig = window._benchConfig || null;

var COLORS  = ['#00e5b0','#0af','#f5c842','#a78bfa','#f97316','#f43f5e','#34d399','#60a5fa'];
var ACOLORS = ['#a78bfa','#f97316','#f43f5e','#60a5fa','#f5c842','#34d399','#0af','#00e5b0'];
var currentBroker = 'fondos';
var formOpenF = false, formOpenA = false;
var opsFilterA = 'all';
var opsFilterF = 'all';
var _desgloseSort  = {col: 'tot', dir: -1}; // fondos desglose
var _accionesSort  = {col: 'tot', dir: -1}; // acciones desglose
var _closedSort    = {col: 'res', dir: -1}; // operaciones cerradas

// ════════════════════════════════════════════════════════════════
//  FX UTILS
// ════════════════════════════════════════════════════════════════
function getFX(fecha) {
  if (FX_TABLE[fecha]) return FX_TABLE[fecha];
  var keys = Object.keys(FX_TABLE);
  if (!keys.length) return 1.08;
  return FX_TABLE[keys.reduce(function(a,b) {
    return Math.abs(new Date(b)-new Date(fecha)) < Math.abs(new Date(a)-new Date(fecha)) ? b : a;
  })];
}
function toEUR(amount, divisa, fecha) {
  if (divisa === 'EUR') return amount;
  return amount / getFX(fecha);
}

// ════════════════════════════════════════════════════════════════
//  UTILS
// ════════════════════════════════════════════════════════════════
function N(n, d) {
  d = d === undefined ? 2 : d;
  return new Intl.NumberFormat('es-ES', {minimumFractionDigits:d, maximumFractionDigits:d}).format(n);
}
function fmtD(s) {
  if (!s) return '—';
  var d = s.split(' ')[0];
  var p = d.split('-'); if (p.length !== 3) return s;
  return p[2]+'/'+p[1]+'/'+p[0].substring(2);
}
function fmtDMY(s) {
  if (!s) return '—';
  var d = s.split(' ')[0];
  var p = d.split('-'); if (p.length !== 3) return s;
  return p[2]+'/'+p[1]+'/'+p[0];
}
function fmtDT(s) {
  if (!s) return '—';
  var parts = s.split(' ');
  var d = parts[0].split('-');
  if (d.length !== 3) return s;
  var dateStr = d[2]+'/'+d[1]+'/'+d[0].substring(2);
  return parts[1] ? dateStr+' '+parts[1] : dateStr;
}
function E(n) { return new Intl.NumberFormat('es-ES', {style:'currency', currency:'EUR'}).format(n); }
function P(n) { return (n >= 0 ? '+' : '') + N(n) + '%'; }
function C(n) { return n >= 0 ? 'var(--ac)' : 'var(--red)'; }
function bdg(t, c) {
  return '<span class="bdg" style="color:'+c+';border-color:'+c+'55;background:'+c+'18">'+t+'</span>';
}
function kpi(items) {
  return items.map(function(k) {
    var sColor = (typeof k.s === 'string' && k.s.indexOf('<') === 0) ? '' : 'color:'+k.c+'55';
    return '<div class="kpi"><div class="kbar" style="background:'+k.c+'"></div>'+
           '<div class="klbl">'+k.l+'</div>'+
           '<div class="kval" style="color:'+k.c+'">'+k.v+'</div>'+
           (k.s ? '<div class="ksub" style="'+sColor+'">'+k.s+'</div>' : '')+
           '</div>';
  }).join('');
}
function irpf(g) {
  // Tramos IRPF ahorro vigentes desde 2025 (Ley 7/2024): 19%/21%/23%/27%/28%
  if (g <= 0) return 0;
  var t=0, r=g, tr=[[6000,.19],[44000,.21],[150000,.23],[100000,.27],[1e9,.28]];
  for (var i=0; i<tr.length&&r>0; i++) { var c=Math.min(r,tr[i][0]); t+=c*tr[i][1]; r-=c; }
  return Math.round(t*100)/100;
}
// Tipo marginal sobre el siguiente euro de plusvalía
function irpfMarginal(baseActual) {
  if (baseActual <   6000) return 0.19;
  if (baseActual <  50000) return 0.21;
  if (baseActual < 200000) return 0.23;
  if (baseActual < 300000) return 0.27;
  return 0.28;
}
// Cuánto queda en el tramo actual antes de saltar
function margenTramo(baseActual) {
  if (baseActual <   6000) return  6000 - baseActual;
  if (baseActual <  50000) return 50000 - baseActual;
  if (baseActual < 200000) return 200000 - baseActual;
  if (baseActual < 300000) return 300000 - baseActual;
  return Infinity;
}

// ════════════════════════════════════════════════════════════════
//  PROCESS DATA
// ════════════════════════════════════════════════════════════════
var NOMBRE_CORTO_F = {};  // Se popula dinámicamente desde data.json en initMaps()
var TICKER_FONDO = {};    // Se popula dinámicamente desde data.json en initMaps()

function processFondos() {
  FPOS = FPOS_RAW.map(function(p) {
    var gl = Math.round((p.valor_mercado - p.coste_adq) * 100) / 100;  // recalc always
    var glp = p.coste_adq > 0 ? (gl / p.coste_adq) * 100 : 0;
    var invReal = p.invertido_real || p.coste_adq;
    var glReal  = p.valor_mercado - invReal;
    var glpReal = invReal > 0 ? (glReal / invReal) * 100 : glp;
    return {
      ticker:         NOMBRE_CORTO_F[p.isin] || p.isin.substring(0,8),
      yahoo_ticker:   p.yahoo_ticker || null,
      nombre:         p.nombre,
      isin:           p.isin,
      qty:            p.titulos,
      avgPrice:       p.coste_medio,
      currentPrice:   p.precio,
      cost:           p.coste_adq,
      invertidoReal:  invReal,
      currentValue:   p.valor_mercado,
      gainLoss:       gl,
      gainLossPct:    glp,
      gainLossReal:   glReal,
      gainLossPctReal: glpReal,
      _priceDate:      p._priceDate || null,
      _hist:           p._hist      || null
    };
  });
  FOPS = FOPS_RAW.map(function(o) {
    var tl = o.tipo==='suscripcion'?'compra':o.tipo==='reembolso'?'venta':
             o.tipo==='traspaso_entrada'?'trasp.↓':o.tipo==='traspaso_salida'?'trasp.↑':o.tipo;
    return { type:tl, tipo_raw:o.tipo, ticker:TICKER_FONDO[o.isin]||o.isin.substring(0,8),
             isin:o.isin, name:o.nombre, date:o.fecha,
             qty:o.titulos, price:o.precio, importe:o.importe, commission:0 };
  });
}

function processAcciones() {
  var nameMap = {}, assetMap = {};
  AOPS_RAW.forEach(function(o) { nameMap[o.ticker]=o.nombre; assetMap[o.ticker]=o.tipo_activo; });

  // Pre-compute EUR cost per position from buy operations (for FX-correct gain)
  // Si la op tiene fx_aplicado → op.importe ya está en EUR exacto del broker, no reconvertir
  function importeEurReal(o) {
    // guardar.php almacena importe en divisa original (raw del XLS)
    // convertir aqui a EUR con FX del dia de la operacion
    if (o.fx_aplicado) return o.importe; // FX exacto del broker ya aplicado
    return toEUR(o.importe, o.divisa, o.fecha);
  }
  var costEurMap = {};
  AOPS_RAW.filter(function(o){return o.tipo==='compra';}).forEach(function(o){
    costEurMap[o.isin] = (costEurMap[o.isin]||0) + importeEurReal(o);
  });
  // Subtract cost of sold lots
  var lotsForCost = {};
  AOPS_RAW.slice().sort(function(a,b){return a.fecha<b.fecha?-1:1;}).forEach(function(o){
    if (o.tipo==='compra') {
      if (!lotsForCost[o.isin]) lotsForCost[o.isin]=[];
      lotsForCost[o.isin].push({qty:o.titulos, costEUR:importeEurReal(o)});
    } else if (o.tipo==='venta') {
      var rem=o.titulos;
      while (rem>0.0001 && lotsForCost[o.isin] && lotsForCost[o.isin].length) {
        var lot=lotsForCost[o.isin][0], use=Math.min(lot.qty,rem);
        var frac=use/lot.qty;
        lot.costEUR-=frac*lot.costEUR; lot.qty-=use; rem-=use;
        if (lot.qty<0.0001) lotsForCost[o.isin].shift();
      }
    }
  });
  var openCostEurMap = {};
  Object.keys(lotsForCost).forEach(function(isin){
    openCostEurMap[isin] = lotsForCost[isin].reduce(function(s,l){return s+l.costEUR;},0);
  });

  APOS = APOS_RAW.map(function(p) {
    var costEur = openCostEurMap[p.isin] || p.coste_adq;
    // Valor en EUR:
    // p.valor_eur contiene el EUR correcto (guardado en data.json o actualizado por refresh)
    // Despues de refreshPrices, p.valor_eur = titulos * precio_live / fx_live
    var valorEur = p.valor_eur || p.coste_adq;
    var glEur = valorEur - costEur;
    var glp = costEur > 0 ? (glEur / costEur) * 100 : 0;
    return { ticker:p.ticker, nombre:p.nombre, isin:p.isin,
             asset:assetMap[p.ticker]||'Acción', divisa:p.divisa,
             qty:p.titulos, avgPrice:p.coste_medio, currentPrice:p.precio,
             cost:costEur, currentValue:valorEur,
             gainLoss:glEur, gainLossPct:glp,
             _priceDate:   p._priceDate   || null,
             _priceDateUI: p._priceDateUI || p._priceDate || null };
  });
  AOPS = AOPS_RAW.map(function(o) {
    return { type:o.tipo, ticker:o.ticker, isin:o.isin, name:o.nombre,
             asset:o.tipo_activo||'Acción', date:o.fecha,
             qty:o.titulos, price:o.precio, importe:o.importe,
             divisa:o.divisa, commission:0, ref:o.ref,
             fx_pendiente: o.fx_pendiente || false,
             fx_aplicado:  o.fx_aplicado  || null };
  });
}

function calcRealizedAcc() {
  var lots = {}, realized = {}, sales = [];
  // importeEurOp: usa op.importe si ya está en EUR exacto (fx_aplicado), si no convierte
  function importeEurOp(o) {
    // guardar.php almacena importe en divisa original (raw del XLS)
    if (o.fx_aplicado) return o.importe;
    return toEUR(o.importe, o.divisa, o.date);
  }
  AOPS.filter(function(o){return o.type==='compra'||o.type==='venta';})
      .slice().sort(function(a,b){return a.date<b.date?-1:1;})
      .forEach(function(o) {
        if (!lots[o.ticker]) lots[o.ticker] = [];
        if (o.type === 'compra') {
          lots[o.ticker].push({qty:o.qty, costEUR:importeEurOp(o)});
        } else {
          var rem=o.qty, costBasis=0;
          while (rem>0.0001 && lots[o.ticker] && lots[o.ticker].length) {
            var lot=lots[o.ticker][0], use=Math.min(lot.qty,rem);
            costBasis+=(use/lot.qty)*lot.costEUR;
            lot.costEUR-=(use/lot.qty)*lot.costEUR;
            lot.qty-=use; rem-=use;
            if (lot.qty<0.0001) lots[o.ticker].shift();
          }
          var procEUR=importeEurOp(o), gain=procEUR-costBasis;
          var yr=o.date.substring(0,4);
          if (!realized[o.ticker]) realized[o.ticker]={gainEur:0,ventas:0,byYear:{}};
          realized[o.ticker].gainEur+=gain; realized[o.ticker].ventas++;
          realized[o.ticker].byYear[yr]=(realized[o.ticker].byYear[yr]||0)+gain;
          sales.push({date:o.date,yr:yr,ticker:o.ticker,name:o.name||o.ticker,
            qty:o.qty,price:o.price,divisa:o.divisa,
            proceeds:procEUR,costBasis:costBasis,gain:gain});
        }
      });
  return { byTicker:realized,
           totalEur:Object.values(realized).reduce(function(s,v){return s+v.gainEur;},0),
           salesDetail:sales };
}

function calcRealizedFondos() {
  // Reembolsos tributables: usamos directamente el cálculo FIFO del broker
  // (contenido en data.fondos.reembolsos_broker, extraído de los ficheros PLUSMINUS)
  var reembolsos = REEMBOLSOS_BROKER || [];

  // Traspasos: emparejar salida→entrada por fecha e importe
  var traspasos = [];
  var salidas  = FOPS_RAW.filter(function(o){return o.tipo==='traspaso_salida';});
  var entradas = FOPS_RAW.filter(function(o){return o.tipo==='traspaso_entrada';});
  var usadas = {};
  salidas.forEach(function(s) {
    var eIdx = -1;
    entradas.forEach(function(e, idx) {
      if (!usadas[idx] && Math.abs(e.importe-s.importe)<0.05 &&
          Math.abs(new Date(e.fecha)-new Date(s.fecha))<=4*24*3600*1000) {
        if (eIdx===-1) eIdx=idx;
      }
    });
    if (eIdx>=0) usadas[eIdx]=true;
    var entrada = eIdx>=0 ? entradas[eIdx] : null;
    var _fromName=s.nombre.split(' ').slice(0,4).join(' '); var _toName=entrada?entrada.nombre.split(' ').slice(0,4).join(' '):'—';
    traspasos.push({date:s.fecha, from:_fromName, to:_toName, imp:s.importe, fromFull:s.nombre, toFull:entrada?entrada.nombre:'—'});
  });
  return {reembolsos:reembolsos, traspasos:traspasos};
}


// ════════════════════════════════════════════════════════════════
//  BENCHMARK MEJORADO — V1
// ════════════════════════════════════════════════════════════════

// Calcular CAGR (tasa anualizada de crecimiento)
function calcCAGR(startVal, endVal, years) {
  if (!startVal || startVal <= 0 || years <= 0) return null;
  return (Math.pow(endVal / startVal, 1 / years) - 1) * 100;
}

// Renderizar panel de benchmark en Análisis
function renderBenchmarkPanel() {
  var el = document.getElementById('bench-panel');
  if (!el) return;

  // ── Configuración de índices activos ──────────────────────────
  var html = '<div style="margin-bottom:16px">';
  html += '<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mu);margin-bottom:10px">Índices de referencia</div>';
  html += '<div style="display:flex;flex-wrap:wrap;gap:8px">';

  Object.keys(BENCH_INDICES).forEach(function(sym) {
    var idx = BENCH_INDICES[sym];
    var hasData = PRICE_HISTORY[idx.key] && PRICE_HISTORY[idx.key].length >= 2;
    var checked = idx.enabled ? 'checked' : '';
    var opacity = hasData ? '1' : '0.4';
    var title   = hasData ? idx.name : idx.name + ' (sin datos — actualiza precios)';
    html += '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;opacity:'+opacity+';padding:5px 10px;border:1px solid var(--bd);border-radius:6px;font-size:12px" title="'+title+'">' +
      '<input type="checkbox" '+checked+' data-sym="'+sym+'" onchange="benchToggle(this)" style="accent-color:'+idx.color+'"> ' +
      '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:'+idx.color+'"></span> ' +
      idx.name +
    '</label>';
  });
  html += '</div></div>';

  // ── Gráfico comparativo ───────────────────────────────────────
  html += '<div class="panel" style="margin-bottom:16px"><div class="ph"><span class="ph-t">Rendimiento comparado — cartera vs índices</span></div><div class="pb">';
  html += '<canvas id="c-bench-compare" height="280"></canvas>';
  html += '</div></div>';

  // ── Tabla CAGR ────────────────────────────────────────────────
  html += '<div class="panel"><div class="ph"><span class="ph-t">Rentabilidad anualizada (CAGR)</span></div><div class="pb" id="bench-cagr-table"></div></div>';

  el.innerHTML = html;

  // Dibujar
  setTimeout(function() {
    drawBenchCompare();
    renderCAGRTable();
  }, 50);
}

function benchToggle(cb) {
  var sym = cb.dataset.sym;
  if (BENCH_INDICES[sym]) {
    BENCH_INDICES[sym].enabled = cb.checked;
    drawBenchCompare();
    renderCAGRTable();
    // Persistir configuración
    _saveBenchConfig();
  }
}

function _saveBenchConfig() {
  var config = {};
  Object.keys(BENCH_INDICES).forEach(function(sym) {
    config[sym] = BENCH_INDICES[sym].enabled;
  });
  fetch('guardar.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: AUTH_HASH_CLIENT, action: 'save_bench_config', config: config })
  }).catch(function(){});
}

function drawBenchCompare() {
  var cv = document.getElementById('c-bench-compare');
  if (!cv) return;

  // ── Construir series ─────────────────────────────────────────
  var series = [];

  // Cartera propia: usar PRICE_HISTORY de fondos para el valor real
  // Proxy: reconstruir valor relativo desde snapshots de posiciones
  var cartSeries = buildCarteSeries();
  if (cartSeries && cartSeries.length >= 2) {
    var base = cartSeries[0].pct;
    series.push({
      name:   'Mi Cartera',
      color:  'var(--ac)',
      points: cartSeries.map(function(p){ return { date: p.date, pct: p.pct - base }; }),
      dash:   []
    });
  }

  // Índices seleccionados
  Object.keys(BENCH_INDICES).forEach(function(sym) {
    var idx = BENCH_INDICES[sym];
    if (!idx.enabled) return;
    var hist = PRICE_HISTORY[idx.key];
    if (!hist || hist.length < 2) return;
    // Rebase desde la primera fecha disponible de la cartera
    var earliest = cartSeries && cartSeries.length ? cartSeries[0].date : hist[0].date;
    var baseSnap = null;
    for (var i = 0; i < hist.length; i++) {
      if (hist[i].date >= earliest) { baseSnap = hist[i]; break; }
    }
    if (!baseSnap) baseSnap = hist[0];
    var points = hist.filter(function(s){ return s.date >= baseSnap.date; })
      .map(function(s){ return { date: s.date, pct: (s.price - baseSnap.price) / baseSnap.price * 100 }; });
    if (points.length >= 2) {
      series.push({ name: idx.name, color: idx.color, points: points, dash: [5,3] });
    }
  });

  if (!series.length) {
    cv.style.display = 'none';
    var msg = document.getElementById('bench-no-data-msg');
    if (!msg) {
      msg = document.createElement('div');
      msg.id = 'bench-no-data-msg';
      msg.style.cssText = 'padding:32px;text-align:center;color:var(--mu);font-size:13px';
      cv.parentNode.insertBefore(msg, cv);
    }
    msg.style.display = '';
    msg.innerHTML = '⏳ Sin datos suficientes todavía — el gráfico se enriquecerá con el tiempo.<br>' +
      '<span style="font-size:12px;color:var(--mu2)">Activa índices y pulsa <strong>Actualizar</strong> para acumular historial diario.</span>';
    return;
  }
  var msg2 = document.getElementById('bench-no-data-msg');
  if (msg2) msg2.style.display = 'none';
  cv.style.display = '';

  // ── Render Canvas ─────────────────────────────────────────────
  var W = cv.parentElement.clientWidth || 800;
  if (W < 200) W = 600;
  var H = 280;
  cv.width = W; cv.height = H;
  var ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  var pad = { t:16, r:16, b:32, l:52 };
  var iW = W - pad.l - pad.r, iH = H - pad.t - pad.b;

  // Escala Y
  var allPcts = [0];
  series.forEach(function(s){ s.points.forEach(function(p){ allPcts.push(p.pct); }); });
  var mn = Math.min.apply(null, allPcts), mx = Math.max.apply(null, allPcts);
  var pad_pct = Math.max((mx - mn) * 0.08, 1);
  mn -= pad_pct; mx += pad_pct;
  var rng = mx - mn || 1;

  // Rango de fechas
  var allDates = [];
  series.forEach(function(s){ s.points.forEach(function(p){ allDates.push(p.date); }); });
  allDates = allDates.filter(function(v,i,a){ return a.indexOf(v)===i; }).sort();
  var n = allDates.length; if (!n) return;
  var d0 = new Date(allDates[0]).getTime();
  var d1 = new Date(allDates[n-1]).getTime();

  function tx(date) { return pad.l + ((new Date(date).getTime()-d0)/Math.max(d1-d0,1))*iW; }
  function ty(v)    { return pad.t + iH - ((v-mn)/rng)*iH; }

  // Grid
  ctx.strokeStyle='#1a2a3d'; ctx.lineWidth=1;
  for (var gi=0; gi<=4; gi++) {
    var gy=pad.t+iH*(gi/4), gv=mx-rng*(gi/4);
    ctx.beginPath(); ctx.moveTo(pad.l,gy); ctx.lineTo(pad.l+iW,gy); ctx.stroke();
    ctx.fillStyle='#4a6785'; ctx.font='10px monospace'; ctx.textAlign='right';
    ctx.fillText((gv>=0?'+':'')+gv.toFixed(1)+'%', pad.l-3, gy+3);
  }
  // Línea cero
  ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(pad.l,ty(0)); ctx.lineTo(pad.l+iW,ty(0)); ctx.stroke();

  // X labels
  ctx.fillStyle='#4a6785'; ctx.font='10px monospace'; ctx.textAlign='center';
  var xStep = Math.max(1, Math.floor(allDates.length/7));
  allDates.forEach(function(dt,i){
    if (i%xStep!==0 && i!==n-1) return;
    var p=dt.split('-'); ctx.fillText(p[2]+'/'+p[1].replace(/^0/,'')+"'"+p[0].substring(2), tx(dt), H-6);
  });

  // Series
  series.forEach(function(s) {
    var color = s.color.startsWith('var(') ? getComputedStyle(document.documentElement).getPropertyValue(s.color.slice(4,-1)).trim() || '#00e5b0' : s.color;
    ctx.strokeStyle = color;
    ctx.lineWidth   = s.dash.length ? 1.5 : 2.5;
    ctx.setLineDash(s.dash);
    ctx.globalAlpha = s.dash.length ? 0.75 : 1.0;
    ctx.beginPath();
    var started = false;
    s.points.forEach(function(p) {
      var x=tx(p.date), y=ty(p.pct);
      started ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
      started=true;
    });
    ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha=1.0;

    // Punto y etiqueta finales
    var last=s.points[s.points.length-1]; if(!last) return;
    ctx.beginPath(); ctx.arc(tx(last.date), ty(last.pct), s.dash.length?2:3, 0, Math.PI*2);
    ctx.fillStyle=color; ctx.fill();
    ctx.fillStyle=color; ctx.font='bold 9px monospace'; ctx.textAlign='right';
    ctx.fillText((last.pct>=0?'+':'')+last.pct.toFixed(1)+'%', tx(last.date)-5, ty(last.pct)-5);
  });

  // Leyenda
  var legY = pad.t + 4;
  series.forEach(function(s,i) {
    var color = s.color.startsWith('var(') ? '#00e5b0' : s.color;
    var legX  = pad.l + i*140;
    if (legX + 130 > W) return;
    ctx.beginPath(); ctx.moveTo(legX, legY+5); ctx.lineTo(legX+16, legY+5);
    ctx.strokeStyle=color; ctx.lineWidth=s.dash.length?1.5:2.5;
    ctx.setLineDash(s.dash); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle='#dde6f0'; ctx.font='10px monospace'; ctx.textAlign='left';
    ctx.fillText(s.name, legX+20, legY+8);
  });

  // Tooltip
  var _btip = document.getElementById('_bench-tip');
  if (!_btip) {
    _btip=document.createElement('div');
    _btip.id='_bench-tip';
    _btip.style.cssText='position:fixed;pointer-events:none;display:none;background:#0d1420;border:1px solid #1e3a5a;border-radius:6px;padding:5px 10px;font-size:12px;color:#dde6f0;z-index:9999;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.5)';
    document.body.appendChild(_btip);
  }
  cv.onmousemove = function(e) {
    var rect=cv.getBoundingClientRect();
    var mx2=(e.clientX-rect.left)*(cv.width/rect.width);
    if (mx2<pad.l||mx2>pad.l+iW){_btip.style.display='none';return;}
    var bestDate=null, bestDist=Infinity;
    series[0].points.forEach(function(p){
      var d=Math.abs(tx(p.date)-mx2); if(d<bestDist){bestDist=d;bestDate=p.date;}
    });
    if (!bestDate){_btip.style.display='none';return;}
    var parts=bestDate.split('-');
    var rows=series.map(function(s){
      var pt=null,bd=Infinity;
      s.points.forEach(function(p){var d=Math.abs(new Date(p.date)-new Date(bestDate));if(d<bd){bd=d;pt=p;}});
      if(!pt)return'';
      var c=s.color.startsWith('var(')?'#00e5b0':s.color;
      return'<div style="display:flex;justify-content:space-between;gap:16px;margin-top:2px">'+
        '<span style="color:'+c+'">'+s.name+'</span>'+
        '<span style="font-family:monospace;font-weight:700">'+(pt.pct>=0?'+':'')+pt.pct.toFixed(2)+'%</span></div>';
    }).join('');
    _btip.innerHTML='<strong style="color:#7a98b8">'+parts[2]+'/'+parts[1]+'/'+parts[0]+'</strong>'+rows;
    _btip.style.display='block';
    _btip.style.left=(e.clientX+14)+'px';
    _btip.style.top=(e.clientY-32)+'px';
  };
  cv.onmouseleave=function(){_btip.style.display='none';};
}

// Construir serie de rentabilidad de la cartera propia desde snapshots
function buildCarteSeries() {
  // Estrategia: para cada fondo con historial, calcular % desde su primer snapshot.
  // Luego promediar ponderado por coste_adq entre todos los fondos con suficientes datos.
  // Requiere mínimo MIN_SNAPS snapshots y 2 fondos, o 1 fondo con muchos snapshots.
  var MIN_SNAPS = 5;

  var fondosSeries = [];
  FPOS_RAW.forEach(function(p) {
    var hist = PRICE_HISTORY[p.isin];
    if (!hist || hist.length < 2) return;
    var base = hist[0].price;
    if (!base || base <= 0) return;
    var peso = p.coste_adq || 1;
    fondosSeries.push({
      peso:   peso,
      points: hist.map(function(s){ return { date: s.date, pct: (s.price - base) / base * 100 }; })
    });
  });

  if (!fondosSeries.length) return null;

  // Comprobar suficientes datos: al menos un fondo con MIN_SNAPS snapshots
  var hasEnough = fondosSeries.some(function(f){ return f.points.length >= MIN_SNAPS; });
  if (!hasEnough) return null;  // sin datos suficientes → no mostrar serie cartera

  // Reunir todas las fechas disponibles (union)
  var dateSet = {};
  fondosSeries.forEach(function(f){
    f.points.forEach(function(p){ dateSet[p.date] = true; });
  });
  var dates = Object.keys(dateSet).sort();
  if (dates.length < 2) return null;

  var totalPeso = fondosSeries.reduce(function(s,f){ return s+f.peso; }, 0);
  if (!totalPeso) return null;

  return dates.map(function(date) {
    var sumW = 0, sumPeso = 0;
    fondosSeries.forEach(function(f) {
      // Buscar el punto más cercano anterior o igual a esta fecha
      var pt = null;
      for (var i = f.points.length-1; i >= 0; i--) {
        if (f.points[i].date <= date) { pt = f.points[i]; break; }
      }
      if (pt) { sumW += pt.pct * f.peso; sumPeso += f.peso; }
    });
    var pct = sumPeso > 0 ? sumW / sumPeso : 0;
    return { date: date, pct: pct };
  });
}

// Tabla CAGR
function renderCAGRTable() {
  var el = document.getElementById('bench-cagr-table');
  if (!el) return;

  var periods = [
    { label: '1 año',   days: 365  },
    { label: '3 años',  days: 1095 },
    { label: '5 años',  days: 1825 },
    { label: 'Total',   days: null  }
  ];

  // Cartera: usar el fondo con más historial como proxy de rentabilidad
  var cartPH = null, cartPHLen = 0;
  FPOS_RAW.forEach(function(p) {
    var h = PRICE_HISTORY[p.isin];
    if (h && h.length > cartPHLen) { cartPH = h; cartPHLen = h.length; }
  });

  // CAGR fiable solo cuando el historial real cubre >= 50% del período solicitado
  function cagrForHist(hist, per) {
    if (!hist || hist.length < 2) return null;
    var last = hist[hist.length-1];
    var targetDate = per.days
      ? new Date(new Date(last.date).getTime() - per.days*86400000).toISOString().substring(0,10)
      : hist[0].date;
    // Buscar base: primer snapshot >= targetDate
    var base = null;
    for (var i = 0; i < hist.length; i++) {
      if (hist[i].date >= targetDate) { base = hist[i]; break; }
    }
    if (!base) base = hist[0];
    var actualDays = (new Date(last.date) - new Date(base.date)) / 86400000;
    // Si el historial no cubre al menos el 50% del período → no mostrar
    if (per.days && actualDays < per.days * 0.5) return null;
    // Mínimo 14 días de historial real para cualquier cálculo
    if (actualDays < 14) return null;
    var years = actualDays / 365.25;
    return calcCAGR(base.price, last.price, years);
  }

  var rows = [];

  // Fila cartera
  var cartRow = { name: '<span style="color:var(--ac)">Mi Cartera</span>', vals: [] };
  periods.forEach(function(per) { cartRow.vals.push(cagrForHist(cartPH, per)); });
  rows.push(cartRow);

  // Filas índices
  Object.keys(BENCH_INDICES).forEach(function(sym) {
    var idx = BENCH_INDICES[sym];
    if (!idx.enabled) return;
    var hist = PRICE_HISTORY[idx.key];
    if (!hist || hist.length < 2) return;
    var row = { name: '<span style="color:'+idx.color+'">'+idx.name+'</span>', vals: [] };
    periods.forEach(function(per) { row.vals.push(cagrForHist(hist, per)); });
    rows.push(row);
  });

  var hdrs = periods.map(function(p){ return '<th style="text-align:right">'+p.label+'</th>'; }).join('');
  var trs  = rows.map(function(r){
    var tds = r.vals.map(function(v){
      if (v===null) return '<td class="mono mu" style="text-align:right">—</td>';
      var col = v>=0 ? 'var(--ac)' : 'var(--red)';
      return '<td class="mono" style="text-align:right;color:'+col+';font-weight:700">'+(v>=0?'+':'')+v.toFixed(1)+'%</td>';
    }).join('');
    return '<tr><td>'+r.name+'</td>'+tds+'</tr>';
  }).join('');

  el.innerHTML = '<div class="tw"><table style="width:100%"><thead><tr><th>Activo</th>'+hdrs+'</tr></thead><tbody>'+trs+'</tbody></table></div>';
}

// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
//  NAVIGATION
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
//  X-RAY MORNINGSTAR — IMPORTADOR Y VISUALIZADOR
// ════════════════════════════════════════════════════════════════

function uploadXRay(input) {
  var file = input.files[0]; if (!file) return;
  var statusEl = document.getElementById('xray-upload-status');
  var resultEl = document.getElementById('xray-result');
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--yel)">⏳ Procesando PDF…</span>';
  if (resultEl) resultEl.style.display = 'none';

  var fd = new FormData();
  fd.append('pdf', file);
  fd.append('token', AUTH_HASH_CLIENT);

  fetch('xray.php', { method: 'POST', body: fd })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      input.value = '';
      if (d.ok) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--ac)">✅ X-Ray importado correctamente</span>';
        // Update local cache
        if (window._xrayData) window._xrayData = d.data;
        else window._xrayData = d.data;
        renderXRay(d.data);
        if (resultEl) resultEl.style.display = '';
      } else {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--red)">❌ ' + (d.msg||'Error desconocido') + '</span>';
      }
    })
    .catch(function(e) {
      input.value = '';
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--red)">❌ Error de conexión: ' + e.message + '</span>';
    });
}

function renderXRay(xr) {
  var el = document.getElementById('xray-content');
  if (!el) return;
  if (!xr || !xr.fecha) {
    el.innerHTML = '<div style="color:var(--mu);text-align:center;padding:32px">No hay datos X-Ray importados todavía.</div>';
    return;
  }

  var fecha = xr.fecha ? (function(){var p=xr.fecha.split('-');return p[2]+'/'+p[1]+'/'+p[0];})() : '—';

  // Barra compacta: solo fecha + botón actualizar (el panel grande queda oculto)
  var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:8px;padding:10px 14px;background:var(--s2);border:1px solid var(--bd);border-radius:10px">' +
    '<div style="font-size:12px;color:var(--mu2)">📊 Informe Morningstar · <strong style="color:var(--text)">' + fecha + '</strong> · importado ' + xr.importado_en + '</div>' +
    '<label style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;background:var(--s);border:1px solid var(--bd);color:var(--mu2);border-radius:7px;padding:5px 12px;font-size:12px">' +
      '🔄 Actualizar X-Ray <input type="file" accept=".pdf" style="display:none" onchange="uploadXRay(this)">' +
    '</label>' +
  '</div>';

  // Ocultar el panel de instrucciones una vez que hay datos
  var uploadPanel = document.getElementById('xray-upload-panel');
  if (uploadPanel) uploadPanel.style.display = 'none';
  var resultEl2 = document.getElementById('xray-result');
  if (resultEl2) resultEl2.style.display = '';

  // ── KPIs distribución activos ──────────────────────────────
  html += '<div class="krow">';
  var act = xr.distribucion_activos || {};
  var actItems = [
    {k:'acciones',    l:'📈 Acciones',     c:'var(--ac)'},
    {k:'obligaciones',l:'📄 Obligaciones',  c:'var(--fondos)'},
    {k:'efectivo',    l:'💶 Efectivo',      c:'var(--yel)'},
    {k:'otro',        l:'🔷 Otro',          c:'var(--pur)'},
  ];
  actItems.forEach(function(a) {
    var v = act[a.k] ? act[a.k].port : null;
    html += '<div class="kpi" style="flex:1;min-width:120px">' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--mu);margin-bottom:6px">' + a.l + '</div>' +
      '<div style="font-family:\'JetBrains Mono\',monospace;font-size:20px;font-weight:800;color:' + a.c + '">' +
        (v !== null ? v.toFixed(1)+'%' : '—') +
      '</div>' +
    '</div>';
  });
  html += '</div>';

  // ── Grid: Rentabilidades + Riesgo ─────────────────────────
  html += '<div class="gdb" style="margin-bottom:20px">';

  // Rentabilidades
  html += '<div class="panel"><div class="ph"><span class="ph-t">Rentabilidad acumulada</span><span style="font-size:11px;color:var(--mu)">vs Mercado Monetario EUR</span></div><div class="pb">';
  var rents = xr.rentabilidades || {};
  var rentItems = [
    {k:'3m',label:'3 meses'},{k:'6m',label:'6 meses'},{k:'ytd',label:'YTD'},
    {k:'1y',label:'1 año'},{k:'3y',label:'3 años (anual.)'},{k:'5y',label:'5 años (anual.)'}
  ];
  html += '<table style="width:100%;border-collapse:collapse">' +
    '<thead><tr><th style="text-align:left;font-size:10px;color:var(--mu);padding-bottom:8px">Período</th>' +
    '<th style="text-align:right;font-size:10px;color:var(--mu)">Cartera</th>' +
    '<th style="text-align:right;font-size:10px;color:var(--mu)">Ref.</th></tr></thead><tbody>';
  rentItems.forEach(function(ri) {
    var v = rents[ri.k];
    if (!v) return;
    var col = v.port >= 0 ? 'var(--ac)' : 'var(--red)';
    html += '<tr style="border-top:1px solid var(--bd)">' +
      '<td style="padding:6px 0;font-size:12px;color:var(--mu2)">' + ri.label + '</td>' +
      '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:700;color:' + col + '">' +
        (v.port >= 0 ? '+' : '') + v.port.toFixed(2) + '%</td>' +
      '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;color:var(--mu)">' +
        (v.ref !== null ? v.ref.toFixed(2)+'%' : '—') + '</td>' +
    '</tr>';
  });
  html += '</tbody></table></div></div>';

  // Riesgo
  html += '<div class="panel"><div class="ph"><span class="ph-t">Estadísticas de riesgo</span></div><div class="pb">';
  var rsk = xr.riesgo || {};
  var riskItems = [
    {k:'volatilidad',l:'Volatilidad'},
    {k:'sharpe',l:'Ratio Sharpe'},
    {k:'alfa',l:'Alfa'},
    {k:'beta',l:'Beta'},
    {k:'tracking_error',l:'Tracking Error'},
    {k:'info_ratio',l:'Ratio de Información'},
  ];
  html += '<table style="width:100%;border-collapse:collapse">' +
    '<thead><tr><th style="text-align:left;font-size:10px;color:var(--mu);padding-bottom:8px">Métrica</th>' +
    '<th style="text-align:right;font-size:10px;color:var(--mu)">3 años</th>' +
    '<th style="text-align:right;font-size:10px;color:var(--mu)">5 años</th></tr></thead><tbody>';
  riskItems.forEach(function(ri) {
    var v = rsk[ri.k];
    if (!v) return;
    html += '<tr style="border-top:1px solid var(--bd)">' +
      '<td style="padding:6px 0;font-size:12px;color:var(--mu2)">' + ri.l + '</td>' +
      '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:700;color:var(--text)">' +
        (v['3y'] !== null ? v['3y'] : '—') + '</td>' +
      '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;color:var(--mu)">' +
        (v['5y'] !== null ? v['5y'] : '—') + '</td>' +
    '</tr>';
  });
  html += '</tbody></table></div></div></div>';

  // ── Grid: Regiones + Sectores ────────────────────────────
  html += '<div class="gdb" style="margin-bottom:20px">';

  // Regiones con subregiones (opción B)
  html += '<div class="panel"><div class="ph"><span class="ph-t">Exposición geográfica</span></div><div class="pb">';
  var regs = xr.regiones || [];
  var regColors = { europa: '#60a5fa', america: '#00e5b0', asia: '#f97316' };
  var bigRegKeys = ['europa','america','asia'];
  if (regs.length > 0) {
    bigRegKeys.forEach(function(rkey) {
      var big = regs.filter(function(r){ return r.key === rkey; })[0];
      if (!big || !big.pct) return;
      var col = regColors[rkey] || 'var(--fondos)';
      var w = Math.min(100, big.pct);
      html += '<div style="margin-top:14px;margin-bottom:4px">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div style="width:120px;font-size:12px;font-weight:700;color:' + col + '">' + big.nombre + '</div>' +
          '<div style="flex:1;height:8px;background:var(--bd);border-radius:4px">' +
            '<div style="height:8px;border-radius:4px;background:' + col + ';width:' + w + '%"></div>' +
          '</div>' +
          '<div style="width:45px;text-align:right;font-family:\'JetBrains Mono\',monospace;font-size:12px;font-weight:700;color:' + col + '">' + big.pct.toFixed(1) + '%</div>' +
        '</div>' +
      '</div>';
      regs.filter(function(r){ return r.parent === rkey && r.pct > 0; }).forEach(function(sub) {
        var ws = Math.min(100, big.pct > 0 ? (sub.pct / big.pct) * 100 : 0);
        html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:3px;padding-left:12px">' +
          '<div style="width:108px;font-size:11px;color:var(--mu2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + sub.nombre + '</div>' +
          '<div style="flex:1;height:5px;background:var(--bd);border-radius:3px">' +
            '<div style="height:5px;border-radius:3px;background:' + col + ';opacity:0.45;width:' + ws.toFixed(1) + '%"></div>' +
          '</div>' +
          '<div style="width:45px;text-align:right;font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--mu)">' + sub.pct.toFixed(1) + '%</div>' +
        '</div>';
      });
    });
  } else {
    // Fallback: top 10 países
    (xr.exposicion_pais||[]).slice(0,10).forEach(function(p) {
      var w = Math.min(100, p.pct || 0);
      html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
        '<div style="width:120px;font-size:12px;color:var(--mu2)">' + p.pais + '</div>' +
        '<div style="flex:1;height:8px;background:var(--bd);border-radius:4px">' +
          '<div style="height:8px;border-radius:4px;background:var(--fondos);width:' + w + '%"></div>' +
        '</div>' +
        '<div style="width:45px;text-align:right;font-family:\'JetBrains Mono\',monospace;font-size:12px;font-weight:700;color:var(--text)">' + p.pct.toFixed(1) + '%</div>' +
      '</div>';
    });
  }
  html += '</div></div>';

  // Sectores
  html += '<div class="panel"><div class="ph"><span class="ph-t">Sectores de renta variable</span></div><div class="pb">';
  var sects = xr.sectores || {};
  var sectOrder = ['tecnologia','financieros','industria','salud','consumo_ciclico',
                   'materiales','comunicacion','consumo_defensivo','energia','inmobiliario','servicios_publicos'];
  var sectColors = {'tecnologia':'#60a5fa','financieros':'#34d399','industria':'#f97316',
                    'salud':'#f43f5e','consumo_ciclico':'#a78bfa','materiales':'#f5c842',
                    'comunicacion':'#00e5b0','consumo_defensivo':'#fb923c',
                    'energia':'#94a3b8','inmobiliario':'#e879f9','servicios_publicos':'#6ee7b7'};
  var sectSorted = sectOrder.filter(function(k){ return sects[k] && sects[k].pct; });
  sectSorted.sort(function(a,b){ return (sects[b].pct||0) - (sects[a].pct||0); });
  sectSorted.forEach(function(k) {
    var s = sects[k];
    var col = sectColors[k] || 'var(--mu2)';
    html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
      '<div style="width:130px;font-size:11px;color:var(--mu2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + s.nombre + '</div>' +
      '<div style="flex:1;height:8px;background:var(--bd);border-radius:4px">' +
        '<div style="height:8px;border-radius:4px;background:'+col+';width:' + Math.min(100,s.pct) + '%"></div>' +
      '</div>' +
      '<div style="width:45px;text-align:right;font-family:\'JetBrains Mono\',monospace;font-size:12px;font-weight:700;color:var(--text)">' + s.pct.toFixed(1) + '%</div>' +
    '</div>';
  });
  html += '</div></div></div>';

  // ── Posiciones con rentabilidad Morningstar ───────────────
  if (xr.posiciones && xr.posiciones.length) {
    html += '<div class="panel" style="margin-bottom:20px"><div class="ph"><span class="ph-t">Fondos — Rentabilidad Morningstar</span></div><div class="pb"><div class="tw">' +
      '<table style="width:100%;border-collapse:collapse"><thead><tr>' +
      '<th style="text-align:left">Fondo</th>' +
      '<th style="text-align:right">Peso</th>' +
      '<th style="text-align:right">1 año</th>' +
      '<th style="text-align:right">3 años</th>' +
      '<th style="text-align:right">5 años</th>' +
      '<th style="text-align:right">Gastos</th>' +
      '</tr></thead><tbody>';
    xr.posiciones.forEach(function(p) {
      function rentCell(v) {
        if (v === null || v === undefined) return '<td class="mono" style="text-align:right;color:var(--mu)">—</td>';
        var col = v >= 0 ? 'var(--ac)' : 'var(--red)';
        return '<td class="mono" style="text-align:right;color:'+col+';font-weight:700">'+(v>=0?'+':'')+v.toFixed(2)+'%</td>';
      }
      html += '<tr>' +
        '<td style="font-size:12px;font-weight:600;color:var(--text)">' + p.nombre + '</td>' +
        '<td class="mono" style="text-align:right;font-weight:700">' + (p.peso||0).toFixed(2) + '%</td>' +
        rentCell(p.rentab_1y) + rentCell(p.rentab_3y) + rentCell(p.rentab_5y) +
        '<td class="mono" style="text-align:right;color:var(--mu)">' + (p.gastos !== null ? p.gastos+'%' : '—') + '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div></div></div>';
  }

  // ── Top 10 posiciones subyacentes ───────────────────────────
  if (xr.top10 && xr.top10.length) {
    html += '<div class="panel" style="margin-bottom:20px"><div class="ph"><span class="ph-t">Top 10 posiciones subyacentes</span><span style="font-size:11px;color:var(--mu)">exposición real a través de los fondos</span></div><div class="pb"><div class="tw"><table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left">Posición</th><th style="text-align:left">Tipo</th><th style="text-align:right">% Cartera</th></tr></thead><tbody>';
    xr.top10.forEach(function(t, i) {
      var tipoCol = t.tipo === 'Acción' ? 'var(--acciones)' : t.tipo === 'Bono' ? 'var(--fondos)' : 'var(--mu2)';
      var barW = Math.min(100, (t.pct / xr.top10[0].pct) * 100);
      html += '<tr style="border-top:1px solid var(--bd)">' +
        '<td style="padding:7px 0;font-size:12px">' +
          '<span style="display:inline-block;width:20px;font-size:10px;color:var(--mu);font-family:monospace">' + (i+1) + '.</span>' +
          '<span style="font-weight:600;color:var(--text)">' + t.nombre + '</span>' +
          '<div style="margin-top:3px;padding-left:20px;height:3px;background:var(--bd);border-radius:2px;width:200px">' +
            '<div style="height:3px;border-radius:2px;background:' + tipoCol + ';width:' + barW.toFixed(1) + '%"></div>' +
          '</div>' +
        '</td>' +
        '<td style="font-size:11px;color:' + tipoCol + ';padding:7px 8px">' + t.tipo + '</td>' +
        '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:700;font-size:12px;color:var(--text)">' + t.pct.toFixed(2) + '%</td>' +
      '</tr>';
    });
    html += '</tbody></table></div></div></div>';
  }

  // ── Estilo de inversión + TER ────────────────────────────────
  html += '<div class="gdb" style="margin-bottom:20px">';

  // Matriz estilo 3×3
  if (xr.estilo_matriz) {
    var em = xr.estilo_matriz;
    var maxVal = 0;
    em.valores.forEach(function(row){ row.forEach(function(v){ if(v>maxVal) maxVal=v; }); });
    html += '<div class="panel"><div class="ph"><span class="ph-t">Estilo de inversión</span></div><div class="pb">';
    html += '<div style="display:grid;grid-template-columns:auto repeat(3,1fr);gap:4px;max-width:320px">';
    // Header cols
    html += '<div></div>';
    em.labels_col.forEach(function(l){
      html += '<div style="text-align:center;font-size:10px;color:var(--mu);font-weight:700;padding-bottom:4px">' + l + '</div>';
    });
    // Rows
    em.labels_fila.forEach(function(fila, ri) {
      html += '<div style="font-size:10px;color:var(--mu);display:flex;align-items:center;padding-right:6px">' + fila + '</div>';
      em.valores[ri].forEach(function(v, ci) {
        var intensity = maxVal > 0 ? v / maxVal : 0;
        var bg = 'rgba(0,229,176,' + (0.08 + intensity * 0.6).toFixed(2) + ')';
        var border = ci === 1 && ri === 0 ? '2px solid var(--ac)' : '1px solid var(--bd)'; // highlight dominant
        html += '<div style="border:' + border + ';border-radius:6px;padding:10px 4px;text-align:center;background:' + bg + '">' +
          '<div style="font-family:\'JetBrains Mono\',monospace;font-size:14px;font-weight:800;color:var(--text)">' + v + '</div>' +
          '<div style="font-size:9px;color:var(--mu)">%</div>' +
        '</div>';
      });
    });
    html += '</div>';
    // Style summary
    var dominated = '';
    var maxV = 0, maxR = 0, maxC = 0;
    em.valores.forEach(function(row,ri){ row.forEach(function(v,ci){ if(v>maxV){maxV=v;maxR=ri;maxC=ci;} }); });
    dominated = em.labels_fila[maxR] + ' ' + em.labels_col[maxC];
    html += '<div style="margin-top:12px;font-size:12px;color:var(--mu2)">Celda dominante: <strong style="color:var(--ac)">' + dominated + ' (' + maxV + '%)</strong></div>';
    // Sesgo value/growth
    var colTotals = [0,0,0];
    em.valores.forEach(function(row){ row.forEach(function(v,ci){ colTotals[ci]+=v; }); });
    var sesgo = colTotals[0] > colTotals[2] ? 'Valor' : colTotals[2] > colTotals[0] ? 'Crecimiento' : 'Mixto';
    html += '<div style="font-size:11px;color:var(--mu);margin-top:4px">Sesgo: <span style="color:var(--text)">' + sesgo + '</span> · Valor <span style="font-family:monospace">' + colTotals[0] + '%</span> · Mixto <span style="font-family:monospace">' + colTotals[1] + '%</span> · Crecimiento <span style="font-family:monospace">' + colTotals[2] + '%</span></div>';
    html += '</div></div>';
  }

  // TER ponderado
  var ter = 0, pesoCheck = 0;
  (xr.posiciones||[]).forEach(function(p) {
    if (p.gastos !== null && p.peso !== null) {
      ter += p.gastos * p.peso / 100;
      pesoCheck += p.peso;
    }
  });
  if (ter > 0) {
    var terCol = ter < 0.3 ? 'var(--ac)' : ter < 0.7 ? 'var(--yel)' : 'var(--red)';
    var terLabel = ter < 0.3 ? 'Coste muy bajo ✓' : ter < 0.7 ? 'Coste moderado' : 'Coste elevado';
    html += '<div class="panel"><div class="ph"><span class="ph-t">Coste total ponderado (TER)</span></div><div class="pb">' +
      '<div style="font-family:\'JetBrains Mono\',monospace;font-size:36px;font-weight:800;color:' + terCol + '">' + ter.toFixed(3) + '%</div>' +
      '<div style="font-size:12px;color:var(--mu2);margin-top:6px">anual · sobre valor de la cartera</div>' +
      '<div style="margin-top:8px;font-size:12px;color:' + terCol + ';font-weight:700">' + terLabel + '</div>' +
      '<div style="margin-top:16px">';
    (xr.posiciones||[]).forEach(function(p) {
      if (p.gastos === null) return;
      var contrib = p.gastos * (p.peso||0) / 100;
      var barW = ter > 0 ? Math.min(100, contrib / ter * 100) : 0;
      var gCol = p.gastos < 0.2 ? 'var(--ac)' : p.gastos < 0.5 ? 'var(--yel)' : 'var(--red)';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
        '<div style="flex:1;font-size:11px;color:var(--mu2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + p.nombre.split(' ').slice(0,3).join(' ') + '</div>' +
        '<div style="width:80px;height:5px;background:var(--bd);border-radius:3px">' +
          '<div style="height:5px;border-radius:3px;background:' + gCol + ';width:' + barW.toFixed(1) + '%"></div>' +
        '</div>' +
        '<div style="width:38px;text-align:right;font-family:\'JetBrains Mono\',monospace;font-size:11px;color:' + gCol + '">' + p.gastos.toFixed(2) + '%</div>' +
      '</div>';
    });
    html += '</div></div></div>';
  }

  html += '</div>'; // close gdb

  el.innerHTML = html;
}

function xrayOnEnter() {
  // Load from cached data.json xray field
  var xr = window._xrayData;
  renderXRay(xr);
}
// ── Secciones del menú principal ─────────────────────────────────
var currentSection = 'cartera';

// Destino por defecto de cada sección
var _sectionDefaults = {
  'cartera':       function(){ ST('resumen','dashboard', document.getElementById('nb-resumen-dashboard')); },
  'analisis':      function(){ ST('fondos','analisis',   document.getElementById('nb-fondos-analisis'));   },
  'planificacion': function(){ ST('fondos','fire',        document.getElementById('nb-fondos-fire'));       },
  'gestion':       function(){ ST('fondos','ops',         document.getElementById('nb-fondos-ops'));        }
};

function switchSection(section, btn) {
  currentSection = section;
  // Actualizar botones top
  document.querySelectorAll('.bk-btn').forEach(function(b){ b.classList.remove('on'); });
  if (btn) btn.classList.add('on');
  // Mostrar/ocultar sub-botones y separadores por sección
  document.querySelectorAll('.nb[data-section], .nb-sep[data-section]').forEach(function(b){
    b.style.display = b.dataset.section === section ? '' : 'none';
  });
  // Navegar al destino por defecto de la sección
  if (_sectionDefaults[section]) _sectionDefaults[section]();
}

// Compatibilidad retroactiva — interno, no usado en HTML ya
function switchBroker(broker, btn) {
  var sectionMap = {
    'fondos':       'cartera',
    'acciones':     'cartera',
    'resumen':      'cartera',
    'desinversion': 'planificacion'
  };
  var section = sectionMap[broker] || 'cartera';
  var sBtn = document.querySelector('.bk-btn[data-section="'+section+'"]');
  switchSection(section, sBtn);
}
function ST(broker, name, btn) {
  currentBroker = broker;  // mantener compatibilidad interna
  document.querySelectorAll('.view').forEach(function(v){v.classList.remove('on');});
  document.querySelectorAll('.nb').forEach(function(b){b.classList.remove('on');});
  var el=document.getElementById('view-'+broker+'-'+name);
  if (el) el.classList.add('on');
  if (btn) btn.classList.add('on');
  // Mantener el botón de sección top activo
  var activeSection = btn ? btn.dataset.section : currentSection;
  if (activeSection) {
    var topBtn = document.querySelector('.bk-btn[data-section="'+activeSection+'"]');
    if (topBtn) {
      document.querySelectorAll('.bk-btn').forEach(function(b){ b.classList.remove('on'); });
      topBtn.classList.add('on');
      currentSection = activeSection;
    }
  }
  setTimeout(function() {
    if (broker==='resumen'&&name==='dashboard') { renderResumen(); }
    if (broker==='fondos'&&name==='dashboard') {
      drawBench('c-bench');
      drawFundPerf('c-fund-perf');
    // Update legend with active funds
    var legEl = document.getElementById('bench-legend');
    if (legEl) {
      var fColors = ['#a78bfa','#f97316','#60a5fa','#f43f5e','#f5c842','#34d399'];
      var fundLegend = FPOS_RAW.filter(function(p){ return p.titulos > 0; })
        .map(function(p, i) {
          var name = NOMBRE_CORTO_F[p.isin] || p.isin.substring(0,8);
          var col  = fColors[i % fColors.length];
          return '<span title="'+p.nombre+'"><span class="ld" style="background:'+col+';border-style:dashed"></span>'+name+'</span>';
        }).join('');
      legEl.innerHTML =
        '<span><span class="ld" style="background:var(--fondos)"></span>Mi Cartera</span>'+
        '<span><span class="ld" style="background:var(--yel)"></span>S&P 500 ref.</span>'+
        fundLegend;
    }
      drawPie('c-pie-f',FPOS.map(function(p){return p.ticker;}),FPOS.map(function(p){return p.currentValue;}),COLORS,FPOS.map(function(p){return {nombre:p.nombre,val:p.currentValue,gl:p.gainLoss,glp:p.gainLossPct};}));
    }
    if (broker==='fondos'&&name==='analisis') {
      drawBars('c-gl-f',FPOS.map(function(p){return p.ticker;}),FPOS.map(function(p){return p.gainLoss;}),COLORS,FPOS.map(function(p){return p.nombre;}));
    }
    if (broker==='fondos'&&name==='benchmark') {
      renderBenchmarkPanel();
    }
    if (broker==='fondos'&&name==='xray') {
      xrayOnEnter();
    }
    if (broker==='acciones'&&name==='dashboard') {
      drawBarsW('c-gl-a-dash', APOS.map(function(p){return p.ticker;}), APOS.map(function(p){return p.gainLoss;}), ACOLORS, 0.62, APOS.map(function(p){return p.nombre||p.ticker;}));
      drawPie('c-pie-a',APOS.map(function(p){return p.ticker;}),APOS.map(function(p){return p.currentValue;}),ACOLORS,APOS.map(function(p){return {nombre:p.nombre||p.ticker,val:p.currentValue,gl:p.gainLoss,glp:p.gainLossPct};}));
    }
    if (broker==='acciones'&&name==='analisis') {
      drawBars('c-gl-a',APOS.map(function(p){return p.ticker;}),APOS.map(function(p){return p.gainLoss;}),ACOLORS,APOS.map(function(p){return p.nombre||p.ticker;}));
      drawDividBars();
    }
    if (broker==='fondos'&&name==='rebalanceo') rebOnEnter();
  }, 50);
  if (broker==='fondos'&&name==='fire') setTimeout(fireOnEnter, 80);
  if (broker==='desinversion'&&name==='optimizador')  setTimeout(renderOptimizador, 80);
  if (broker==='desinversion'&&name==='metas')        setTimeout(renderMetas, 80);
  if (broker==='desinversion'&&name==='jubilacion')   setTimeout(renderJubilacion, 80);
}

// ════════════════════════════════════════════════════════════════
//  CHARTS
// ════════════════════════════════════════════════════════════════
function drawBars(id, labels, values, colors, fullNames) { drawBarsW(id, labels, values, colors, 0.48, fullNames); }
function drawBarsW(id, labels, values, colors, fraction, fullNames) {
  var cv=document.getElementById(id); if (!cv) return;
  if (!labels || !labels.length || !values || !values.length) return;
  var ctx=cv.getContext('2d');
  var W = _canvasW(fraction || 0.48);
  if (W < 80) W = 300;
  cv.width=W; cv.height=parseInt(cv.getAttribute('height')||200);
  var H=cv.height, p={t:10,r:14,b:28,l:60}, iW=W-p.l-p.r, iH=H-p.t-p.b;
  ctx.clearRect(0,0,W,H);
  var mn=Math.min.apply(null,[0].concat(values)), mx=Math.max.apply(null,[0].concat(values)), rng=mx-mn||1;
  function ty(v){return p.t+iH-((v-mn)/rng)*iH;} var z=ty(0);
  ctx.strokeStyle='#1a2a3d'; ctx.lineWidth=1;
  [0,.25,.5,.75,1].forEach(function(f){
    var v=mn+rng*f, y=ty(v);
    ctx.beginPath(); ctx.moveTo(p.l,y); ctx.lineTo(p.l+iW,y); ctx.stroke();
    ctx.fillStyle='#4a6785'; ctx.font='10px monospace'; ctx.textAlign='right';
    ctx.fillText(N(v,0)+'€', p.l-3, y+3);
  });
  var bw=(iW/values.length)*.65;
  var barRects = [];
  values.forEach(function(v,i) {
    var x=p.l+(iW/values.length)*i+(iW/values.length-bw)/2;
    var yT=v>=0?ty(v):z, bh=Math.abs(ty(v)-z)||2;
    // Expandir notación corta (#rgb → #rrggbb) antes de añadir alpha 'cc'
    var baseColor = colors ? colors[i%colors.length] : (v>=0?'#00e5b0':'#ff3d5a');
    if (/^#[0-9a-fA-F]{3}$/.test(baseColor)) {
      baseColor = '#' + baseColor[1]+baseColor[1] + baseColor[2]+baseColor[2] + baseColor[3]+baseColor[3];
    }
    ctx.fillStyle = baseColor + 'cc';
    ctx.fillRect(x, yT, bw, bh);
    ctx.fillStyle='#7a98b8'; ctx.font='10px sans-serif'; ctx.textAlign='center';
    var lbl=labels[i].length>10?labels[i].substring(0,9)+'…':labels[i];
    ctx.fillText(lbl, x+bw/2, H-4);
    barRects.push({x:x, yT:yT, bw:bw, bh:bh, label:labels[i], name:(fullNames&&fullNames[i])||labels[i], value:v});
  });
  // Tooltip overlay en hover
  var _tip = document.getElementById('_bar-tip');
  if (!_tip) {
    _tip = document.createElement('div');
    _tip.id = '_bar-tip';
    _tip.style.cssText = 'position:fixed;pointer-events:none;display:none;background:#0d1420;border:1px solid #1e3a5a;border-radius:6px;padding:5px 10px;font-size:12px;color:#dde6f0;z-index:9999;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.5)';
    document.body.appendChild(_tip);
  }
  cv.onmousemove = function(e) {
    var rect = cv.getBoundingClientRect();
    var scaleX = cv.width / rect.width;
    var mx = (e.clientX - rect.left) * scaleX;
    var my = (e.clientY - rect.top) * (cv.height / rect.height);
    var hit = null;
    for (var i=0; i<barRects.length; i++) {
      var b = barRects[i];
      if (mx >= b.x && mx <= b.x+b.bw && my >= b.yT && my <= b.yT+b.bh) { hit=b; break; }
    }
    if (hit) {
      var sign = hit.value >= 0 ? '+' : '';
      _tip.innerHTML = '<strong style="color:#00e5b0">' + hit.name + '</strong><br>' +
        '<span style="color:#7a98b8;font-size:10px">' + hit.label + '</span>' +
        '<span style="float:right;margin-left:16px;font-family:monospace;color:'+(hit.value>=0?'#00e5b0':'#ff4d6d')+'">' + sign + N(hit.value,2) + '€</span>';
      _tip.style.display = 'block';
      _tip.style.left = (e.clientX + 14) + 'px';
      _tip.style.top  = (e.clientY - 32) + 'px';
    } else {
      _tip.style.display = 'none';
    }
  };
  cv.onmouseleave = function() { if (_tip) _tip.style.display = 'none'; };
}
function drawPie(id, labels, values, colors, tooltipData) {
  var cv=document.getElementById(id); if (!cv) return;
  var ctx=cv.getContext('2d'); cv.width=200; cv.height=155;
  var cx=100, cy=72, r=62, ri=33;
  var total=values.reduce(function(a,b){return a+b;},0);
  var slices=[]; var angle=-Math.PI/2;
  values.forEach(function(v,i){
    var sl=(v/total)*Math.PI*2;
    slices.push({start:angle, end:angle+sl, color:colors[i%colors.length], label:labels[i], value:v, pct:v/total*100});
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,angle,angle+sl);
    ctx.closePath(); ctx.fillStyle=colors[i%colors.length]; ctx.fill(); angle+=sl;
  });
  ctx.beginPath(); ctx.arc(cx,cy,ri,0,Math.PI*2); ctx.fillStyle='#0d1420'; ctx.fill();
  ctx.fillStyle='#dde6f0'; ctx.font='bold 10px sans-serif'; ctx.textAlign='center';
  ctx.fillText(values.length+' pos.', cx, cy+4);

  // Tooltip
  var tip = document.getElementById('_pie-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = '_pie-tip';
    tip.style.cssText = 'position:fixed;pointer-events:none;display:none;background:#0d1420;border:1px solid #1e3a5a;border-radius:8px;padding:8px 12px;font-size:12px;color:#dde6f0;z-index:9999;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.6);min-width:160px';
    document.body.appendChild(tip);
  }
  cv.onmousemove = function(e) {
    var rect = cv.getBoundingClientRect();
    var scaleX = cv.width / rect.width, scaleY = cv.height / rect.height;
    var mx = (e.clientX - rect.left) * scaleX - cx;
    var my = (e.clientY - rect.top) * scaleY - cy;
    var dist = Math.sqrt(mx*mx + my*my);
    if (dist < ri || dist > r) { tip.style.display='none'; return; }
    var a = Math.atan2(my, mx);
    if (a < -Math.PI/2) a += Math.PI*2; // normalise to start at top
    // Find which slice
    var found = null;
    for (var i=0; i<slices.length; i++) {
      var s = slices[i];
      var sa = s.start, ea = s.end;
      if (a >= sa && a < ea) { found=s; break; }
    }
    if (!found) { tip.style.display='none'; return; }
    var td = tooltipData ? tooltipData[slices.indexOf(found)] : null;
    var html = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">' +
      '<span style="width:10px;height:10px;border-radius:2px;background:'+found.color+';display:inline-block;flex-shrink:0"></span>' +
      '<strong style="font-size:12px">' + (td ? td.nombre : found.label) + '</strong></div>';
    html += '<div style="display:flex;justify-content:space-between;gap:16px;color:#7a98b8;font-size:11px">' +
      '<span>Peso</span><span style="color:#dde6f0;font-weight:700;font-family:monospace">' + found.pct.toFixed(1) + '%</span></div>';
    if (td) {
      html += '<div style="display:flex;justify-content:space-between;gap:16px;color:#7a98b8;font-size:11px">' +
        '<span>Valor</span><span style="color:#dde6f0;font-weight:700;font-family:monospace">' + E(td.val) + '</span></div>';
      if (td.gl !== undefined) {
        var glColor = td.gl >= 0 ? 'var(--ac)' : 'var(--red)';
        html += '<div style="display:flex;justify-content:space-between;gap:16px;color:#7a98b8;font-size:11px">' +
          '<span>G/P</span><span style="color:'+glColor+';font-weight:700;font-family:monospace">' +
          (td.gl>=0?'+':'') + E(Math.round(td.gl*100)/100) + ' · ' + (td.glp>=0?'+':'') + td.glp.toFixed(1) + '%</span></div>';
      }
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top  = (e.clientY - 10) + 'px';
  };
  cv.onmouseleave = function() { tip.style.display='none'; };
}
function drawDividBars() {
  var d={}, nm={};
  AOPS.filter(function(o){return o.type==='dividendo';}).forEach(function(o){
    var imp = o.importe||(o.qty*o.price);
    d[o.ticker]=(d[o.ticker]||0)+toEUR(imp, o.divisa, o.date);
    if (!nm[o.ticker]) nm[o.ticker] = o.name || o.ticker;
  });
  var lbl=Object.keys(d);
  drawBars('c-divid', lbl, lbl.map(function(k){return d[k];}), ACOLORS, lbl.map(function(k){return nm[k]||k;}));
}

// ════════════════════════════════════════════════════════════════
//  FORMS
// ════════════════════════════════════════════════════════════════

// ── KNOWN POSITIONS (for autofill) ──
// KNOWN_FONDOS y KNOWN_ACCIONES se pueblan en initMaps() — ver arriba

// Obtiene el nombre de un fondo por ISIN. Primero mira posiciones activas (KNOWN_FONDOS),
// luego busca en el historial de operaciones como fallback para fondos ya cerrados.
function getNombreFromOps(isin) {
  if (KNOWN_FONDOS[isin] && KNOWN_FONDOS[isin].nombre) return KNOWN_FONDOS[isin].nombre;
  for (var _i = 0; _i < FOPS_RAW.length; _i++) {
    var _o = FOPS_RAW[_i];
    if (_o.isin === isin && _o.nombre && _o.nombre !== isin) return _o.nombre;
  }
  return isin;
}

function autoFillFondo(isinId, nombreId, yahooId) {
  var isin = (document.getElementById(isinId).value||'').trim().toUpperCase();
  var f = KNOWN_FONDOS[isin];
  document.getElementById(nombreId).value = f ? f.nombre : '';
  if (yahooId) {
    var yEl = document.getElementById(yahooId);
    if (yEl) yEl.value = (f && f.yahoo_ticker) ? f.yahoo_ticker : '';
  }
}

function autoFillAccion(tickerId, nameId, isinId, assetId, divisaId) {
  var ticker = (document.getElementById(tickerId).value||'').trim().toUpperCase();
  var a = KNOWN_ACCIONES[ticker];
  if (a) {
    document.getElementById(nameId).value   = a.nombre;
    document.getElementById(isinId).value   = a.isin;
    document.getElementById(assetId).value  = a.tipo;
    document.getElementById(divisaId).value = a.divisa;
  }
}

function onFondoTipoChange() {
  var tipo = document.getElementById('ff-type').value;
  document.getElementById('ff-single').style.display   = tipo==='traspaso' ? 'none' : '';
  document.getElementById('ff-traspaso').style.display = tipo==='traspaso' ? ''     : 'none';
}


// ════════════════════════════════════════════════════════════════
//  PARSER EMAILS INVERSIS
// ════════════════════════════════════════════════════════════════

function toggleEmailParser() {
  var area = document.getElementById('ff-email-area');
  var btn  = document.getElementById('ff-email-btn');
  if (!area) return;
  var visible = area.style.display !== 'none';
  area.style.display = visible ? 'none' : 'block';
  btn.textContent = visible ? '\u{1F4CB} Desde email' : '\u2715 Cerrar parser';
  // Si abrimos el parser, abrir también el formulario
  if (!visible && !formOpenF) toggleForm('f');
}

function parseInversisEmail() {
  var text = document.getElementById('ff-email-text').value || '';
  if (!text.trim()) { showParserMsg('Pega el texto del email primero.', 'err'); return; }

  // ── Helpers ──────────────────────────────────────────────────
  function parseFecha(str) {
    var m = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? m[3]+'-'+m[2]+'-'+m[1] : null;
  }
  function parseNum(str) {
    if (!str) return NaN;
    var s = str.trim();
    // Formato europeo: punto como miles, coma como decimal → '1.234,56'
    if (/^[\d.]+,[\d]+$/.test(s)) return parseFloat(s.replace(/\./g,'').replace(',','.'));
    // Formato anglosajón: coma como miles, punto como decimal → '1,234.56'
    return parseFloat(s.replace(/,/g,''));
  }

  // Extrae Fecha Valor (segunda fecha cuando aparecen Fecha Operación + Fecha Valor juntas)
  function getFechaValor(txt) {
    var m = txt.match(/Fecha\s+Operaci[o\u00f3]n\s+Fecha\s+Valor[\s\S]{0,250}?(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})/i);
    if (m) return parseFecha(m[2]);
    m = txt.match(/Fecha\s+Valor[\s\S]{0,100}?(\d{2}\/\d{2}\/\d{4})/i);
    return m ? parseFecha(m[1]) : null;
  }

  // Extrae todos los ISINs en orden de aparición
  function getISINs(txt) {
    var isins = []; var re = /C[o\u00f3]digo\s+ISIN\s*:\s*([A-Z]{2}[A-Z0-9]{10})/gi; var m;
    while ((m = re.exec(txt)) !== null) isins.push(m[1].toUpperCase());
    return isins;
  }

  // Extrae qty y precio juntos desde la línea de datos tras "Número de Participaciones"
  // Patrón de la línea: "185.68  10.7041 EUR  1,987.53 EUR"
  // qty = primer número sin EUR, precio = segundo número seguido de EUR
  // Extrae qty y precio — números pueden ser europeos (1.234,56) o anglosajones (1,234.56)
  var NUM_PAT = '[\\d]{1,3}(?:[.,][\\d]{3})*(?:[.,][\\d]+)?|[\\d]+[.,]?[\\d]*';
  function getQtyPrice(txt) {
    // Buscar la sección de Participaciones y extraer los dos primeros números antes de EUR
    var re = new RegExp(
      'N[u\u00fa]mero\\s+de\\s+(?:t[\u00ed]tulos\\/)?Participaciones[\\s\\S]{0,400}?('
      + NUM_PAT + ')\\s+(' + NUM_PAT + ')\\s*EUR', 'i');
    var m = txt.match(re);
    if (!m) return {qty: null, price: null};
    return {qty: parseNum(m[1]), price: parseNum(m[2])};
  }

  // ── Detección de tipo ────────────────────────────────────────
  // Patrones primarios y alternativos de Inversis
  var isTraspSalida  = /REEMB\.?\s*POR\s+TRASPASO|REEMBOLSO\s+POR\s+TRASPASO/i.test(text);
  var isTraspEntrada = /SUSCR\.?\s*POR\s+TRASPASO|SUSCRIPCI[OÓ]N\s+POR\s+TRASPASO/i.test(text);
  var isSuscripcion  = /SUSCRIPCI[OÓ]N\s+(?:DE\s+Participaciones|I\.I\.C\.)/i.test(text);
  var isReembolso    = /REEMBOLSO\s+(?:DE\s+Participaciones|I\.I\.C\.)/i.test(text);

  // ── Traspaso (uno o dos emails pegados juntos) ───────────────
  if (isTraspSalida || isTraspEntrada) {
    // Separar por bloques "Referencia Traspaso" si el usuario pegó los dos emails
    var parts = text.split(/(?=Referencia\s+Traspaso)/i).filter(function(p){ return p.trim(); });
    var salida = null; var entrada = null;

    parts.forEach(function(p) {
      var isins = getISINs(p);
      var qp    = getQtyPrice(p);
      if (/REEMB\.POR\s+TRASPASO/i.test(p)) {
        salida = {
          isin:        isins[0] || '',
          isinDestino: isins[1] || '',
          fecha:       getFechaValor(p),
          qty:         qp.qty,
          price:       qp.price
        };
      } else if (/SUSCR\.POR\s+TRASPASO/i.test(p)) {
        entrada = {
          isinOrigen: isins[0] || '',
          isin:       isins[1] || isins[0] || '',
          fecha:      getFechaValor(p),
          qty:        qp.qty,
          price:      qp.price
        };
      }
    });

    if (salida && entrada) {
      fillFormFromParsed({
        tipo:    'traspaso',
        fecha:   salida.fecha || entrada.fecha,
        isin_o:  salida.isin,  qty_o:  salida.qty,  price_o: salida.price,
        isin_d:  entrada.isin || salida.isinDestino,
        qty_d:   entrada.qty,  price_d: entrada.price
      });
      showParserMsg('\u2705 Traspaso completo detectado. Revisa los campos y guarda.', 'ok');
    } else if (salida) {
      fillFormFromParsed({
        tipo:    'traspaso',
        fecha:   salida.fecha,
        isin_o:  salida.isin,  qty_o:  salida.qty,  price_o: salida.price,
        isin_d:  salida.isinDestino, qty_d: null, price_d: null
      });
      showParserMsg('\u26a0 Pata de salida registrada. Cuando llegue el email de suscripci\u00f3n, p\u00e9galo aqu\u00ed junto al anterior y vuelve a parsear.', 'warn');
    } else if (entrada) {
      fillFormFromParsed({
        tipo:    'traspaso',
        fecha:   entrada.fecha,
        isin_o:  entrada.isinOrigen, qty_o:  null, price_o: null,
        isin_d:  entrada.isin, qty_d: entrada.qty, price_d: entrada.price
      });
      showParserMsg('\u26a0 Pata de entrada registrada. Completa los datos del fondo origen.', 'warn');
    } else {
      showParserMsg('\u26a0 No se pudieron extraer los datos del traspaso.', 'err');
    }
    return;
  }

  // ── Suscripción / Reembolso directos ────────────────────────
  var isins = getISINs(text);
  var qp    = getQtyPrice(text);
  var fecha = getFechaValor(text);

  if (isSuscripcion) {
    fillFormFromParsed({tipo:'suscripcion', isin:isins[0]||'', fecha:fecha, qty:qp.qty, price:qp.price});
    showParserMsg('\u2705 Suscripci\u00f3n detectada.' + (!fecha ? ' \u26a0 Fecha no detectada — intróducela manualmente.' : ' Revisa los campos y guarda.'), fecha ? 'ok' : 'warn');
    return;
  }
  if (isReembolso) {
    fillFormFromParsed({tipo:'reembolso', isin:isins[0]||'', fecha:fecha, qty:qp.qty, price:qp.price});
    showParserMsg('\u2705 Reembolso detectado.' + (!fecha ? ' \u26a0 Fecha no detectada — intróducela manualmente.' : ' Revisa los campos y guarda.'), fecha ? 'ok' : 'warn');
    return;
  }

  showParserMsg('\u26a0 Formato no reconocido. Verifica que has pegado un email de Inversis.', 'err');
}

function showParserMsg(msg, type) {
  var out = document.getElementById('ff-email-out');
  var colors = {ok: 'var(--ac)', warn: 'var(--yel)', err: 'var(--red)'};
  var c = colors[type] || colors.err;
  out.style.display    = 'block';
  out.style.color      = c;
  out.style.background = c.replace(')', ')').replace('var(', '').replace(')', '') + '18'; // tint
  out.style.background = 'color-mix(in srgb, '+c+' 12%, transparent)';
  out.style.border     = '1px solid color-mix(in srgb, '+c+' 40%, transparent)';
  out.style.borderRadius = '6px';
  out.style.padding    = '8px 12px';
  out.style.fontSize   = '12px';
  out.textContent      = msg;
}

function fillFormFromParsed(r) {
  // Seleccionar tipo y mostrar sección correcta del form
  document.getElementById('ff-type').value = r.tipo === 'traspaso' ? 'traspaso' : r.tipo;
  onFondoTipoChange();

  // Fecha valor
  if (r.fecha) document.getElementById('ff-date').value = r.fecha;

  if (r.tipo === 'traspaso') {
    if (r.isin_o)  { document.getElementById('ff-isin-o').value  = r.isin_o;  autoFillFondo('ff-isin-o','ff-nombre-o','ff-yahoo-o'); }
    if (r.qty_o  !== null && r.qty_o  !== undefined) document.getElementById('ff-qty-o').value   = r.qty_o;
    if (r.price_o !== null && r.price_o !== undefined) document.getElementById('ff-price-o').value = r.price_o;
    if (r.isin_d)  { document.getElementById('ff-isin-d').value  = r.isin_d;  autoFillFondo('ff-isin-d','ff-nombre-d','ff-yahoo-d'); }
    if (r.qty_d  !== null && r.qty_d  !== undefined) document.getElementById('ff-qty-d').value   = r.qty_d;
    if (r.price_d !== null && r.price_d !== undefined) document.getElementById('ff-price-d').value = r.price_d;
  } else {
    if (r.isin)  { document.getElementById('ff-isin').value  = r.isin;  autoFillFondo('ff-isin','ff-nombre','ff-yahoo'); }
    if (r.qty   !== null && r.qty   !== undefined) document.getElementById('ff-qty').value   = r.qty;
    if (r.price !== null && r.price !== undefined) document.getElementById('ff-price').value = r.price;
  }

  document.getElementById('f-op-form').scrollIntoView({behavior:'smooth', block:'start'});
}

function toggleForm(b, forceClose) {
  if (b==='f') {
    if (forceClose) formOpenF = true; // will be toggled to false below
    formOpenF=!formOpenF;
    document.getElementById('f-op-form').style.display=formOpenF?'block':'none';
    document.getElementById('f-btn-form').textContent=formOpenF?'✕ Cancelar':'+ Nueva operación';
    if (formOpenF) {
      // Opening: set today's date, clear fields, reset tipo
      document.getElementById('ff-type').value  = 'suscripcion';
      document.getElementById('ff-date').value  = new Date().toISOString().substring(0,10);
      document.getElementById('ff-isin').value  = '';
      document.getElementById('ff-nombre').value= '';
      document.getElementById('ff-yahoo').value = '';
      document.getElementById('ff-qty').value   = '';
      document.getElementById('ff-price').value = '';
      document.getElementById('ff-err').style.display = 'none';
      document.getElementById('f-op-form').dataset.editRef = '';
      // Limpiar también campos de traspaso
      ['ff-isin-o','ff-nombre-o','ff-yahoo-o','ff-qty-o','ff-price-o',
       'ff-isin-d','ff-nombre-d','ff-yahoo-d','ff-qty-d','ff-price-d'].forEach(function(id){
        var el = document.getElementById(id); if (el) el.value = '';
      });
      onFondoTipoChange();
    }
  } else {
    if (forceClose) formOpenA = true;
    formOpenA=!formOpenA;
    document.getElementById('a-op-form').style.display=formOpenA?'block':'none';
    document.getElementById('a-btn-form').textContent=formOpenA?'✕ Cancelar':'+ Nueva operación';
    if (!formOpenA) { delete document.getElementById('a-op-form').dataset.editRef; }
    if (formOpenA) {
      // Limpiar todos los campos al abrir formulario nueva operación
      ['af-ticker','af-isin','af-name','af-qty','af-price','af-comm','af-importe-eur','af-fx-rate'].forEach(function(id){
        var el=document.getElementById(id); if(el) el.value='';
      });
      document.getElementById('af-date').value   = new Date().toISOString().substring(0,10);
      document.getElementById('af-type').value   = 'compra';
      document.getElementById('af-divisa').value = 'EUR';
      document.getElementById('af-asset').value  = 'Acci\u00f3n';
      document.getElementById('af-err').style.display = 'none';
      document.getElementById('a-op-form').dataset.editRef = '';
      document.getElementById('af-type').onchange = afToggleComm;
      afToggleComm();
    }
  }
}

function saveOp(b) {
  if (b==='f') { saveFondoOp(); } else { saveAccionOp(); }
}

function saveFondoOp() {
  var tipo  = document.getElementById('ff-type').value;
  var fecha = document.getElementById('ff-date').value;
  var err   = document.getElementById('ff-err');
  err.style.display = 'none';

  if (!fecha) { err.style.display='block'; err.textContent='La fecha es obligatoria.'; return; }

  if (tipo === 'traspaso') {
    var isinO  = (document.getElementById('ff-isin-o').value||'').trim().toUpperCase();
    var isinD  = (document.getElementById('ff-isin-d').value||'').trim().toUpperCase();
    var qtyO   = parseFloat(document.getElementById('ff-qty-o').value);
    var priceO = parseFloat(document.getElementById('ff-price-o').value);
    var qtyD   = parseFloat(document.getElementById('ff-qty-d').value);
    var priceD = parseFloat(document.getElementById('ff-price-d').value);
    if (!isinO||!isinD||isNaN(qtyO)||isNaN(priceO)||isNaN(qtyD)||isNaN(priceD)) {
      err.style.display='block'; err.textContent='Completa todos los campos del traspaso.'; return;
    }
    if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(isinO) || !/^[A-Z]{2}[A-Z0-9]{10}$/.test(isinD)) {
      err.style.display='block'; err.textContent='ISIN inválido — debe tener 12 caracteres (ej. IE000ZYRH0Q7).'; return;
    }
    var yahooO = (document.getElementById('ff-yahoo-o').value||'').trim() || (KNOWN_FONDOS[isinO]&&KNOWN_FONDOS[isinO].yahoo_ticker) || null;
    var yahooD = (document.getElementById('ff-yahoo-d').value||'').trim() || (KNOWN_FONDOS[isinD]&&KNOWN_FONDOS[isinD].yahoo_ticker) || null;
    var op = {
      isin_origen:          isinO, nombre_origen:  getNombreFromOps(isinO),
      yahoo_ticker_origen:  yahooO,
      isin_destino:         isinD, nombre_destino: getNombreFromOps(isinD),
      yahoo_ticker_destino: yahooD,
      fecha: fecha,
      titulos_origen:  qtyO,  precio_origen:  priceO,
      titulos_destino: qtyD,  precio_destino: priceD,
    };
    var formElT = document.getElementById('f-op-form');
    var editRefT = formElT.dataset.editRef;
    if (editRefT) {
      // Editing a traspaso: delete original both legs first, then add new
      delete formElT.dataset.editRef;
      document.getElementById('f-btn-form').textContent = '+ Nueva operación';
      fetch('guardar.php', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ token: AUTH_HASH_CLIENT, action: 'delete_op', broker: 'fondos', ref: editRefT })
      })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res.ok) { persistOp('add_traspaso', null, op); }
        else {
          var e2 = document.getElementById('ff-err');
          e2.style.display = 'block';
          e2.textContent = '⚠ Error al actualizar: ' + (res.msg || 'desconocido');
        }
      })
      .catch(function(e){ alert('Error: ' + e.message); });
    } else {
      persistOp('add_traspaso', null, op);
    }
  } else {
    var isin  = (document.getElementById('ff-isin').value||'').trim().toUpperCase();
    var qty   = parseFloat(document.getElementById('ff-qty').value);
    var price = parseFloat(document.getElementById('ff-price').value);
    if (!isin||isNaN(qty)||isNaN(price)) {
      err.style.display='block'; err.textContent='Completa los campos obligatorios.'; return;
    }
    if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin)) {
      err.style.display='block'; err.textContent='ISIN inválido — debe tener 12 caracteres (ej. FR0000447823).'; return;
    }
    var yahoo = (document.getElementById('ff-yahoo').value||'').trim() || (KNOWN_FONDOS[isin]&&KNOWN_FONDOS[isin].yahoo_ticker) || null;
    var op = {
      tipo:         tipo,
      isin:         isin,
      nombre:       document.getElementById('ff-nombre').value || isin,
      yahoo_ticker: yahoo,
      fecha:        fecha,
      titulos:      qty,
      precio:       price,
      importe:      qty * price,
    };
    var formEl2 = document.getElementById('f-op-form');
    var editRef2 = formEl2.dataset.editRef;
    if (editRef2) {
      delete formEl2.dataset.editRef;
      document.getElementById('f-btn-form').textContent = '+ Nueva operaci\u00f3n';
      fetch('guardar.php', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ token: AUTH_HASH_CLIENT, action: 'delete_op', broker: 'fondos', ref: editRef2 })
      })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res.ok) { persistOp('add_op', 'fondos', op); }
        else alert('Error al actualizar: ' + res.msg);
      })
      .catch(function(e){ alert('Error: ' + e.message); });
    } else {
      persistOp('add_op', 'fondos', op);
    }
  }
}

function saveAccionOp() {
  var ticker = (document.getElementById('af-ticker').value||'').trim().toUpperCase();
  var fecha  = document.getElementById('af-date').value;
  var qty    = parseFloat(document.getElementById('af-qty').value);
  var price  = parseFloat(document.getElementById('af-price').value);
  var err    = document.getElementById('af-err');
  err.style.display = 'none';
  if (!ticker||!fecha||isNaN(qty)||isNaN(price)) {
    err.style.display='block'; err.textContent='Completa los campos obligatorios.'; return;
  }
  var divisa = document.getElementById('af-divisa').value;

  // Importe EUR: usar valor exacto del broker si se ha introducido
  var importeEurEl  = document.getElementById('af-importe-eur');
  var importeEurExacto = importeEurEl ? parseFloat(importeEurEl.value) : NaN;
  var importeEurFinal;
  var fxAplicado = null;
  var fxPendiente = false;

  if (divisa !== 'EUR') {
    if (!isNaN(importeEurExacto) && importeEurExacto > 0) {
      // Dato exacto del broker — calcular también el FX implícito
      importeEurFinal = importeEurExacto;
      fxAplicado      = Math.round((qty * price / importeEurExacto) * 10000000) / 10000000;
      // Actualizar campo readonly de FX para que el usuario lo vea
      var fxRateEl = document.getElementById('af-fx-rate');
      if (fxRateEl) fxRateEl.value = fxAplicado;
    } else {
      // Sin dato exacto — preguntar al usuario qué hacer
      var fxEst = toEUR(qty * price, divisa, fecha);
      var msg = '⚠ No has introducido el importe EUR exacto del broker.\n\n'
        + 'El importe estimado con FX del BCE es: ' + fxEst.toFixed(2) + ' €\n'
        + '(puede diferir ±5-15€ del real)\n\n'
        + 'Pulsa Aceptar para guardar con este estimado (seguirá marcado como pendiente).\n'
        + 'Pulsa Cancelar para volver y introducir el dato exacto.';
      if (!confirm(msg)) return;  // el usuario quiere volver — no guardar
      importeEurFinal = fxEst;
      fxPendiente     = true;
    }
  } else {
    importeEurFinal = qty * price;
  }

  var op = {
    tipo:          document.getElementById('af-type').value,
    ticker:        ticker,
    isin:          document.getElementById('af-isin').value || ticker,
    nombre:        document.getElementById('af-name').value || ticker,
    tipo_activo:   document.getElementById('af-asset').value,
    fecha:         fecha,
    titulos:       qty,
    precio:        price,
    importe:       Math.round(importeEurFinal * 100) / 100,
    divisa:        divisa,
    comision:      parseFloat(document.getElementById('af-comm').value)||0,
  };
  if (fxAplicado   !== null) op.fx_aplicado  = fxAplicado;
  if (fxPendiente)            op.fx_pendiente = true;

  var formEl = document.getElementById('a-op-form');
  var editRef = formEl.dataset.editRef;
  if (editRef) {
    delete formEl.dataset.editRef;
    document.getElementById('a-btn-form').textContent = '+ Nueva operaci\u00f3n';
    fetch('guardar.php', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ token: AUTH_HASH_CLIENT, action: 'delete_op', broker: 'acciones', ref: editRef })
    })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.ok) { persistOp('add_op', 'acciones', op); }
      else alert('Error al actualizar: ' + res.msg);
    })
    .catch(function(e){ alert('Error: ' + e.message); });
  } else {
    persistOp('add_op', 'acciones', op);
  }
}


function persistOp(action, broker, op) {
  var savingId = broker==='acciones' ? 'af-saving' : 'ff-saving';
  var errId    = broker==='acciones' ? 'af-err'    : 'ff-err';
  document.getElementById(savingId).style.display = 'inline';

  fetch('guardar.php', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      token:  AUTH_HASH_CLIENT,
      action: action,
      broker: broker,
      op:     op
    })
  })
  .then(function(r){ return r.json(); })
  .then(function(res) {
    document.getElementById(savingId).style.display = 'none';
    if (res.ok) {
      // Update local data and re-render
      if (action === 'add_op') {
        op.ref = res.ref;
        if (broker === 'fondos') {
          // Reload from server: guardar.php recalcula titulos+coste_adq en FPOS_RAW
          reloadData();
          toggleForm('f', true);
        } else {
          // Reload from server: guardar.php recalcula titulos+coste_adq en APOS_RAW
          reloadData();
          toggleForm('a', true);
        }
      } else if (action === 'add_traspaso') {
        reloadData();
        toggleForm('f', true);
      }
    } else {
      var err = document.getElementById(errId);
      err.style.display = 'block';
      err.textContent = '⚠ ' + (res.msg || 'Error al guardar');
    }
  })
  .catch(function(e) {
    document.getElementById(savingId).style.display = 'none';
    var err = document.getElementById(errId);
    err.style.display = 'block';
    err.textContent = '⚠ Error de conexión: ' + e.message;
  });
}


function editAccionOp(ref) {
  var op = AOPS_RAW.find(function(o){ return o.ref === ref; });
  if (!op) return;
  var form = document.getElementById('a-op-form');
  if (form.style.display === 'none') toggleForm('a');
  document.getElementById('af-type').value   = op.tipo || op.type || 'compra';
  afToggleComm();
  document.getElementById('af-ticker').value = op.ticker || '';
  document.getElementById('af-isin').value   = op.isin || '';
  document.getElementById('af-name').value   = op.nombre || op.name || '';
  document.getElementById('af-asset').value  = op.tipo_activo || op.asset || 'Acci\u00f3n';
  document.getElementById('af-date').value   = op.fecha || op.date || '';
  document.getElementById('af-qty').value    = op.titulos || op.qty || '';
  document.getElementById('af-price').value  = op.precio || op.price || '';
  document.getElementById('af-divisa').value = op.divisa || 'EUR';
  document.getElementById('af-comm').value   = op.comision || op.commission || '';

  // FX fields — populate if non-EUR operation
  var importeEurEl = document.getElementById('af-importe-eur');
  var fxRateEl     = document.getElementById('af-fx-rate');
  var fxWrap       = document.getElementById('af-fx-wrap');
  var divisa       = op.divisa || 'EUR';
  if (importeEurEl) importeEurEl.value = '';
  if (fxRateEl)     fxRateEl.value     = '';

  if (divisa !== 'EUR' && fxWrap) {
    fxWrap.style.display = '';
    // Precargar importe EUR conocido
    if (importeEurEl && op.importe) {
      importeEurEl.value = op.importe;
    }
    // Mostrar FX aplicado si está guardado
    if (fxRateEl && op.fx_aplicado) {
      fxRateEl.value = op.fx_aplicado;
    }
    // Si estaba pendiente de FX, resaltar el campo
    if (op.fx_pendiente && importeEurEl) {
      importeEurEl.style.borderColor = 'var(--yel)';
      importeEurEl.title = 'FX pendiente de verificar — introduce el importe exacto del broker';
    }
  } else if (fxWrap) {
    fxWrap.style.display = 'none';
  }

  form.dataset.editRef = ref;
  document.getElementById('a-btn-form').textContent = '\u2715 Cancelar edici\u00f3n';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function afToggleFxField() {
  var divisa  = document.getElementById('af-divisa').value;
  var fxWrap  = document.getElementById('af-fx-wrap');
  var fxRate  = document.getElementById('af-fx-rate');
  if (!fxWrap) return;
  var nonEur = divisa && divisa !== 'EUR';
  fxWrap.style.display = nonEur ? '' : 'none';
  if (!nonEur && fxRate) { fxRate.value = ''; }
}

// ── CORREGIR FX — accede al formulario directamente con datos del importador ──
// A diferencia de editAccionOp(), no depende de AOPS_RAW (que puede no estar
// cargado aún cuando el panel post-importación está visible).
function _corregirFxOp(opJson) {
  var op = (typeof opJson === 'string') ? JSON.parse(opJson) : opJson;
  // Navegar a sección Gestión → Operaciones Acciones
  var btnGestion = document.querySelector('.bk-btn[data-section="gestion"]');
  switchSection('gestion', btnGestion);
  var nbOps = document.getElementById('nb-acciones-ops');
  if (nbOps) ST('acciones','ops', nbOps);
  setTimeout(function() {
    var form = document.getElementById('a-op-form');
    if (!form) return;
    if (form.style.display === 'none' || !form.style.display) toggleForm('a');
    document.getElementById('af-type').value   = op.tipo || 'compra';
    document.getElementById('af-ticker').value = op.ticker || '';
    document.getElementById('af-isin').value   = op.isin   || '';
    document.getElementById('af-name').value   = op.nombre || '';
    document.getElementById('af-asset').value  = op.tipo_activo || 'Acción';
    document.getElementById('af-date').value   = op.fecha  || '';
    document.getElementById('af-qty').value    = op.titulos || '';
    document.getElementById('af-price').value  = op.precio  || '';
    document.getElementById('af-divisa').value = op.divisa  || 'USD';
    document.getElementById('af-comm').value   = op.comision || '';
    afToggleFxField();
    // Pre-rellenar importe EUR estimado (placeholder para que el usuario lo corrija)
    var impEl = document.getElementById('af-importe-eur');
    if (impEl) {
      impEl.value = op.importe || '';
      impEl.style.borderColor = 'var(--yel)';
      impEl.focus();
      impEl.select();
      // Añadir nota contextual bajo el campo si no existe ya
      var noteId = 'fx-field-note';
      if (!document.getElementById(noteId)) {
        var note = document.createElement('div');
        note.id = noteId;
        note.style.cssText = 'font-size:11px;color:var(--mu2);margin-top:5px;line-height:1.5';
        note.innerHTML = 'ℹ️ Si lo dejas vacío y guardas, se te pedirá confirmación '
          + 'y la operación se guardará con el FX estimado del BCE '
          + '(seguirá marcada como <strong style="color:var(--yel)">pendiente</strong> hasta que introduzcas el dato exacto).';
        impEl.parentNode.appendChild(note);
      }
    }
    // Guardar ref para sobreescribir al guardar
    form.dataset.editRef = op.ref || '';
    document.getElementById('a-btn-form').textContent = '\u2715 Cancelar edición';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
}

function afToggleComm() {
  var tipo = document.getElementById('af-type').value;
  var commWrap = document.getElementById('af-comm').closest('.fg');
  if (commWrap) commWrap.style.display = tipo === 'dividendo' ? 'none' : '';
  afToggleFxField();
}

function savePriceSnapshots() {
  var today = new Date().toISOString().substring(0,10);
  var prices = [];
  // Fondos
  FPOS_RAW.filter(function(p){ return p.precio && p._priceDate; })
    .forEach(function(p){
      var fEntry = { isin: p.isin, price: p.precio, date: p._priceDate || today };
      if (p._prevClose) fEntry.prev_close = p._prevClose;
      prices.push(fEntry);
    });
  // Acciones
  APOS_RAW.filter(function(p){ return p.precio && p._priceDate; })
    .forEach(function(p){
      var entry = { isin: p.isin, price: p.precio, date: p._priceDate || today };
      if (p._prevClose) entry.prev_close = p._prevClose;
      if (p.divisa && p.divisa !== 'EUR') {
        var fxKeys = Object.keys(FX_TABLE).sort();
        entry.fx = fxKeys.length ? FX_TABLE[fxKeys[fxKeys.length-1]] : null;
      }
      prices.push(entry);
    });
  // S&P 500 snapshot (si se obtuvo en este refresh)
  if (window._sp500Snapshot) {
    prices.push(window._sp500Snapshot);
    window._sp500Snapshot = null;
  }
  // Snapshots de otros índices de benchmark
  if (window._benchSnapshots && window._benchSnapshots.length) {
    prices = prices.concat(window._benchSnapshots);
    window._benchSnapshots = [];
  }
  if (!prices.length) return;
  var fxKeys = Object.keys(FX_TABLE).sort();
  var fxVal  = fxKeys.length ? FX_TABLE[fxKeys[fxKeys.length-1]] : null;
  fetch('guardar.php', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ token: AUTH_HASH_CLIENT, action: 'save_prices', prices: prices, fx: fxVal })
  }).catch(function(){});
}

function editFondoOp(ref) {
  var op = FOPS_RAW.find(function(o){ return o.ref === ref; });
  if (!op) return;
  var form = document.getElementById('f-op-form');
  if (form.style.display === 'none') toggleForm('f');
  var esTraspaso = op.tipo === 'traspaso_entrada' || op.tipo === 'traspaso_salida';
  document.getElementById('ff-type').value = esTraspaso ? 'traspaso' : op.tipo;
  onFondoTipoChange();
  document.getElementById('ff-date').value = op.fecha || new Date().toISOString().substring(0,10);
  if (!esTraspaso) {
    document.getElementById('ff-isin').value    = op.isin || '';
    document.getElementById('ff-nombre').value  = op.nombre || '';
    document.getElementById('ff-yahoo').value   = op.yahoo_ticker || '';
    document.getElementById('ff-qty').value     = op.titulos || '';
    document.getElementById('ff-price').value   = op.precio || '';
  } else {
    // Encontrar las dos patas del traspaso por traspaso_ref
    var traspRef = op.traspaso_ref;
    var legs = traspRef ? FOPS_RAW.filter(function(o){ return o.traspaso_ref === traspRef; }) : [op];
    var salida  = legs.find(function(o){ return o.tipo === 'traspaso_salida'; })  || op;
    var entrada = legs.find(function(o){ return o.tipo === 'traspaso_entrada'; }) || {};
    document.getElementById('ff-isin-o').value   = salida.isin    || '';
    document.getElementById('ff-nombre-o').value = salida.nombre  || '';
    document.getElementById('ff-yahoo-o').value  = salida.yahoo_ticker || '';
    document.getElementById('ff-qty-o').value    = salida.titulos || '';
    document.getElementById('ff-price-o').value  = salida.precio  || '';
    document.getElementById('ff-isin-d').value   = entrada.isin    || '';
    document.getElementById('ff-nombre-d').value = entrada.nombre  || '';
    document.getElementById('ff-yahoo-d').value  = entrada.yahoo_ticker || '';
    document.getElementById('ff-qty-d').value    = entrada.titulos || '';
    document.getElementById('ff-price-d').value  = entrada.precio  || '';
    // Store the salida ref — delete_op with traspaso_ref removes both legs
    ref = salida.ref;
  }
  form.dataset.editRef = ref;
  document.getElementById('f-btn-form').textContent = '\u2715 Cancelar edici\u00f3n';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function deleteOp(broker, ref) {
  if (!confirm('¿Eliminar esta operación? Esta acción recalculará la posición en cascada.')) return;
  fetch('guardar.php', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ token: AUTH_HASH_CLIENT, action: 'delete_op', broker: broker, ref: ref })
  })
  .then(function(r){ return r.json(); })
  .then(function(res) {
    if (res.ok) { reloadData(); }
    else alert('Error: ' + res.msg);
  })
  .catch(function(e){ alert('Error: ' + e.message); });
}

function reloadData() {
  // Cancelar cualquier refresh en curso incrementando la secuencia
  _refreshSeq++;
  var _btn = document.getElementById('btn-refresh');
  if (_btn) { _btn.disabled = false; _btn.innerHTML = '⟳ Actualizar'; _btn.style.color = 'var(--mu2)'; }

  fetch('data.json?t=' + Date.now())
    .then(function(r){ return r.json(); })
    .then(function(data){
      // Hacer un init() completo — igual que al arrancar la app
      // Esto garantiza que todos los gráficos, leyendas, títulos y KPIs
      // reflejan el nuevo estado de los datos
      var _wasLoaded = window._PRICES_LOADED;
      init(data);
      // Restaurar _PRICES_LOADED si había precios frescos antes:
      // los NAVs siguen siendo válidos, solo cambiaron operaciones/posiciones
      if (_wasLoaded) {
        window._PRICES_LOADED = true;
        // Re-renderizar KPIs numéricos con los datos actualizados
        processFondos();   renderFondos();
        processAcciones(); renderAcciones();
        updateHeaderVal(null);
        var _activeView = document.querySelector('.view.on');
        if (_activeView && _activeView.id.indexOf('resumen') !== -1) renderResumen();
        // Redibujar gráfica activa si procede
        var _on = document.querySelector('.view.on');
        if (_on) {
          if (_on.id === 'view-fondos-dashboard')  { drawBench('c-bench'); drawFundPerf('c-fund-perf'); }
          if (_on.id === 'view-acciones-dashboard') { drawPie('c-pie-a',APOS.map(function(p){return p.ticker;}),APOS.map(function(p){return p.currentValue;}),ACOLORS,APOS.map(function(p){return {nombre:p.nombre||p.ticker,val:p.currentValue,gl:p.gainLoss,glp:p.gainLossPct};})); }
        }
      }
    })
    .catch(function(e){ console.error('reloadData error:', e); });
}


// ════════════════════════════════════════════════════════════════
//  IMPORTADOR XLS INVERSIS — UNIFICADO (Fondos + Acciones/ETF)
// ════════════════════════════════════════════════════════════════

var _INVERSIS_FONDOS_TIPOS = {
  'SUSCRIPCION':          'suscripcion',
  'SUSCR.POR TRASPASO I': 'traspaso_entrada',
  'RECEP INTERNA IIC':    'traspaso_entrada',
  'REEMBOLSO':            'reembolso',
  'REEMB.POR TRASPASO I': 'traspaso_salida',
};
var _INVERSIS_ACC_TIPOS = {
  'COMPRA':     'compra',
  'VENTA':      'venta',
  'DIVIDENDO':  'dividendo',
};

function importXLSInversisUnificado(input) {
  var file = input.files[0]; if (!file) return;

  var statusEl = document.getElementById('xls-import-status');
  var resultEl = document.getElementById('xls-import-result');
  var detailEl = document.getElementById('xls-import-detail');
  if (statusEl) statusEl.textContent = '⏳ Procesando fichero…';
  if (resultEl) resultEl.style.display = 'none';

  var reader = new FileReader();
  reader.onload = function(e) {
    var html = e.target.result;
    var tmp  = document.createElement('div');
    tmp.innerHTML = html;
    var rows = tmp.querySelectorAll('tr');

    // Detectar cabecera
    var dataStart = 0;
    if (rows.length > 1) {
      var firstText = rows[0].textContent.toLowerCase();
      if (firstText.includes('fecha') || firstText.includes('operaci')) dataStart = 2;
    }

    var fondosOps = [], accionesOps = [];
    var skipped = 0, warnings = [];
    var refsSeen = {};

    // Construir refs existentes
    var existFRefs = {};
    FOPS_RAW.forEach(function(o){ if (o.ref) existFRefs[o.ref] = true; });
    var existARefs = {};
    AOPS_RAW.forEach(function(o){ if (o.ref) existARefs[o.ref] = true; });

    for (var ri = dataStart; ri < rows.length; ri++) {
      var cells = rows[ri].querySelectorAll('td,th');
      if (cells.length < 10) continue;

      // parseNum: maneja tanto formato europeo (1.234,56) como anglosajón (1,234.56)
      function parseNumXLS(s) {
        s = (s||'').trim();
        // Formato europeo: punto=miles, coma=decimal → '2.616,7898'
        if (/^[\d.]+,[\d]+$/.test(s)) return parseFloat(s.replace(/\./g,'').replace(',','.'));
        // Formato anglosajón: coma=miles, punto=decimal → '1,234.56'
        return parseFloat(s.replace(/,/g,''));
      }
      // fmtFechaXLS: convierte DD/MM/YYYY → YYYY-MM-DD
      function fmtFechaXLS(s) {
        var m = (s||'').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        return m ? m[3]+'-'+m[2]+'-'+m[1] : s.trim();
      }
      var fechaOp = fmtFechaXLS(cells[0].textContent);
      var ref     = cells[2].textContent.trim();
      var mercado = cells[3].textContent.trim().toUpperCase();
      var tipoRaw = cells[4].textContent.trim().toUpperCase();
      var isin    = cells[5].textContent.trim();
      var nombre  = cells[6].textContent.trim();
      var titulos = parseNumXLS(cells[7].textContent);
      var divisa  = cells[8].textContent.trim() || 'EUR';
      var precio  = parseNumXLS(cells[9].textContent);

      if (!isin || !fechaOp || isNaN(titulos) || isNaN(precio)) { skipped++; continue; }
      if (titulos <= 0 || precio <= 0) { skipped++; continue; }
      if (ref && refsSeen[ref]) { skipped++; continue; }
      if (ref) refsSeen[ref] = true;

      var esFondo = mercado === 'FONDOS EXTRANJEROS' || mercado.includes('FONDO');

      if (esFondo) {
        var tipo = _INVERSIS_FONDOS_TIPOS[tipoRaw];
        if (!tipo) { warnings.push('Tipo fondo desconocido "'+tipoRaw+'" ref '+ref); skipped++; continue; }
        if (existFRefs[ref]) { skipped++; continue; }
        fondosOps.push({
          tipo: tipo, isin: isin, nombre: nombre, fecha: fechaOp,
          titulos: titulos, precio: precio,
          importe: Math.round(titulos * precio * 100) / 100,
          ref: ref || ('xls-f-' + Date.now() + '-' + ri)
        });
      } else {
        // Acción / ETF
        var tipoA = _INVERSIS_ACC_TIPOS[tipoRaw];
        if (!tipoA) { warnings.push('Tipo acción desconocido "'+tipoRaw+'" ref '+ref); skipped++; continue; }
        if (existARefs[ref]) { skipped++; continue; }
        var ticker = isin; // ISIN completo evita colisiones
        var opAcc = {
          tipo: tipoA, ticker: ticker, isin: isin, nombre: nombre,
          tipo_activo: 'Acción', fecha: fechaOp,
          titulos: titulos, precio: precio, divisa: divisa,
          importe: Math.round(titulos * precio * 100) / 100,
          ref: ref || ('xls-a-' + Date.now() + '-' + ri)
        };
        // Fix: marcar fx_pendiente para operaciones en divisa extranjera
        if (divisa !== 'EUR') opAcc.fx_pendiente = true;
        accionesOps.push(opAcc);
      }
    }

    input.value = '';

    var totalNuevos = fondosOps.length + accionesOps.length;
    if (totalNuevos === 0) {
      if (statusEl) statusEl.textContent = skipped ? '⏭ ' + skipped + ' filas ya existentes u omitidas.' : 'No se encontraron operaciones nuevas.';
      return;
    }

    if (statusEl) statusEl.textContent = '📡 Guardando ' + totalNuevos + ' operaciones…';

    // Enviar al servidor
    fetch('guardar.php', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        token:        AUTH_HASH_CLIENT,
        action:       'bulk_add_ops_all',
        fondos_ops:   fondosOps,
        acciones_ops: accionesOps
      })
    })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.ok) {
        // Mostrar resultado
        var lines = [];
        if (d.fondos_added)   lines.push('✅ <strong>' + d.fondos_added + '</strong> operaciones de fondos importadas');
        if (d.acciones_added) lines.push('✅ <strong>' + d.acciones_added + '</strong> operaciones de acciones importadas');
        if (d.fondos_skipped + d.acciones_skipped > 0)
          lines.push('⏭ ' + (d.fondos_skipped + d.acciones_skipped) + ' ya existían en el servidor');
        if (warnings.length)  lines.push('⚠ ' + warnings.slice(0,3).join(' · '));

        // Aviso operaciones no-EUR con FX pendiente de verificar
        var nonEurOps = accionesOps.filter(function(o){ return o.fx_pendiente; });
        if (nonEurOps.length) {
          var fxItems = nonEurOps.map(function(o) {
            return '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(245,200,66,.15)">'
              + '<div style="flex:1;min-width:0">'
              + '<span style="font-weight:700;color:var(--text)">' + o.nombre + '</span>'
              + ' <span class="mono" style="color:var(--mu2);font-size:10px">' + o.fecha + '</span>'
              + '<br><span class="mono" style="font-size:11px;color:var(--mu2)">' + N(o.titulos,4) + ' t\u00edt \u00d7 ' + N(o.precio,4) + ' ' + o.divisa + '</span>'
              + ' <span style="color:var(--yel);font-size:11px">\u2248' + E(o.importe) + ' (FX est. 1,10)</span>'
              + '</div>'
              + '<button data-op="' + encodeURIComponent(JSON.stringify(o)) + '" '
              + 'onclick="_corregirFxOp(JSON.parse(decodeURIComponent(this.dataset.op)))" '
              + 'style="flex-shrink:0;background:rgba(245,200,66,.15);border:1px solid rgba(245,200,66,.4);'
              + 'color:var(--yel);border-radius:7px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap" '
              + 'title="Introduce el importe EUR exacto del broker">\u270e Corregir EUR</button>'
              + '</div>';
          }).join('');
          lines.push(
            '<div style="margin-top:8px;padding:14px 16px;background:rgba(245,200,66,.07);'
            + 'border:1px solid rgba(245,200,66,.4);border-radius:10px">'
            + '<div style="font-size:12px;font-weight:700;color:var(--yel);margin-bottom:6px">'
            + '⚠️ ' + nonEurOps.length + ' operación' + (nonEurOps.length > 1 ? 'es' : '') + ' en divisa extranjera — importe EUR pendiente</div>'
            + '<div style="font-size:11px;color:var(--mu2);line-height:1.6;margin-bottom:10px">'
            + 'El XLS de Inversis no contiene el tipo de cambio aplicado. El importe EUR mostrado '
            + 'es una <em>estimación</em> con FX≈01,10 — puede diferir del real hasta ±15€ en algunas operaciones.<br>'
            + 'Para cada operación, entra en el detalle de Inversis, busca el campo '
            + '<strong style="color:var(--text)">"Neto EUR"</strong> o '
            + '<strong style="color:var(--text)">"Tipo cambio div. cliente"</strong>, '
            + 'y haz clic en <strong style="color:var(--yel)">✎ Corregir EUR</strong> para introducirlo.</div>'
            + fxItems
            + '</div>'
          );
        }

        if (resultEl) { resultEl.style.display = 'block'; }
        if (detailEl) { detailEl.innerHTML = lines.join('<br>'); }
        if (statusEl) statusEl.textContent = nonEurOps.length
          ? '✅ Importado — ⚠ ' + nonEurOps.length + ' op. en divisa extranjera pendientes de verificar'
          : '✅ Importación completada';
        reloadData();
      } else {
        if (statusEl) statusEl.textContent = '❌ Error: ' + (d.msg || 'desconocido');
      }
    })
    .catch(function(e) {
      if (statusEl) statusEl.textContent = '❌ Error de conexión: ' + e.message;
    });
  };
  // Inversis XLS usa codificación ISO-8859-1 (Latin-1), no UTF-8
  reader.readAsText(file, 'ISO-8859-1');
}

// ════════════════════════════════════════════════════════════════
//  IMPORTADOR XLS INVERSIS
// ════════════════════════════════════════════════════════════════

// Mapeo de tipos Inversis → tipos internos de la app
var _INVERSIS_TIPO_MAP = {
  'SUSCRIPCION':         'suscripcion',
  'SUSCR.POR TRASPASO I':'traspaso_entrada',
  'RECEP INTERNA IIC':   'traspaso_entrada',
  'REEMBOLSO':           'reembolso',
  'REEMB.POR TRASPASO I':'traspaso_salida',
};

function importXLSInversis(input) {
  var file = input.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var html = e.target.result;
    // Parsear el HTML del XLS usando un DOM temporal
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var rows = tmp.querySelectorAll('tr');

    // Detectar si hay cabecera (primera fila con "Fechas" u "Operaci")
    var dataStart = 0;
    if (rows.length > 1) {
      var firstText = rows[0].textContent.toLowerCase();
      if (firstText.includes('fecha') || firstText.includes('operaci')) dataStart = 2;
    }

    var added = 0, skipped = 0, warnings = [], ops = [];
    var refsSeen = {};

    for (var ri = dataStart; ri < rows.length; ri++) {
      var cells = rows[ri].querySelectorAll('td,th');
      if (cells.length < 10) continue;

      // Columnas del XLS Inversis:
      // [0] Fecha Operación  [1] Fecha Liquidación  [2] Referencia
      // [3] Mercado          [4] Tipo operación      [5] ISIN
      // [6] Nombre           [7] Títulos             [8] Divisa
      // [9] Precio Neto      [10] Importe Neto
      var fechaOp  = cells[0].textContent.trim();
      var ref      = cells[2].textContent.trim();
      var tipoRaw  = cells[4].textContent.trim().toUpperCase();
      var isin     = cells[5].textContent.trim();
      var nombre   = cells[6].textContent.trim();
      var titulos  = parseFloat(cells[7].textContent.trim().replace(',','.'));
      var divisa   = cells[8].textContent.trim() || 'EUR';
      var precio   = parseFloat(cells[9].textContent.trim().replace(',','.'));

      // Validaciones básicas
      if (!isin || !fechaOp || isNaN(titulos) || isNaN(precio)) { skipped++; continue; }
      if (titulos <= 0 || precio <= 0) { skipped++; continue; }

      // Mapeo de tipo
      var tipo = _INVERSIS_TIPO_MAP[tipoRaw];
      if (!tipo) {
        warnings.push('Tipo desconocido "'+tipoRaw+'" en ref '+ref+' — omitida');
        skipped++; continue;
      }

      // Evitar duplicados por referencia
      if (ref && refsSeen[ref]) { skipped++; continue; }
      if (ref) refsSeen[ref] = true;

      // Comprobar si ya existe esta referencia en FOPS_RAW
      var yaExiste = FOPS_RAW.some(function(o){ return o.ref === ref; });
      if (yaExiste) { skipped++; continue; }

      var op = {
        tipo:    tipo,
        isin:    isin,
        nombre:  nombre,
        fecha:   fechaOp,   // YYYY-MM-DD directo del XLS
        titulos: titulos,
        precio:  precio,
        importe: Math.round(titulos * precio * 100) / 100,
        ref:     ref || ('xls-' + Date.now() + '-' + ri),
      };
      FOPS_RAW.push(op);
      ops.push(op);
      added++;
    }

    input.value = '';

    if (added === 0) {
      var msg0 = skipped ? '⏭ ' + skipped + ' filas omitidas (ya existen o son inválidas).' : 'No se encontraron operaciones válidas.';
      if (warnings.length) msg0 += '\n⚠ ' + warnings.slice(0,5).join('\n');
      alert(msg0);
      return;
    }

    // Recoger las operaciones nuevas (las que se añadieron al array)
    var opsParaGuardar = ops;

    // Enviar al servidor de una sola vez
    fetch('guardar.php', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        token:  AUTH_HASH_CLIENT,
        action: 'bulk_add_ops',
        ops:    opsParaGuardar
      })
    })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.ok) {
        var msg = '✅ ' + d.added + ' operaciones guardadas correctamente.';
        if (d.skipped) msg += '\n⏭ ' + d.skipped + ' omitidas en el servidor (ya existían).';
        if (warnings.length) msg += '\n⚠ ' + warnings.slice(0,5).join('\n');
        alert(msg);
        // Recargar data.json desde servidor para reflejar las posiciones recalculadas
        reloadData();
      } else {
        // Revertir: quitar las ops que habíamos añadido en memoria
        FOPS_RAW.splice(FOPS_RAW.length - added, added);
        alert('❌ Error al guardar: ' + (d.msg || 'desconocido'));
      }
    })
    .catch(function(e) {
      FOPS_RAW.splice(FOPS_RAW.length - added, added);
      alert('❌ Error de conexión: ' + e.message);
    });
  };
  reader.readAsText(file, 'UTF-8');
}

// Mantener importCSV por compatibilidad (acciones)
function importCSV(input, b) {
  var file=input.files[0]; if (!file) return;
  var reader=new FileReader();
  reader.onload=function(e){
    var lines=e.target.result.split(/\r?\n/).filter(function(l){return l.trim();}),
        start=lines[0].toLowerCase().includes('tipo')?1:0, added=0;
    lines.slice(start).forEach(function(line){
      var p=line.split(',');
      if (p.length<5) return;
      var qty=parseFloat(b==='f'?p[4]:p[5]), price=parseFloat(b==='f'?p[5]:p[6]);
      if (!p[1]||isNaN(qty)||isNaN(price)) return;
      if (b==='f') FOPS_RAW.push({tipo:(p[0]||'suscripcion').trim(),isin:p[1].trim(),nombre:(p[2]||p[1]).trim(),fecha:(p[3]||'').trim(),titulos:qty,precio:price,importe:qty*price,ref:'csv'});
      else { var dv=p[8]||'EUR'; AOPS_RAW.push({tipo:(p[0]||'compra').trim(),ticker:p[1].trim().toUpperCase(),isin:p[1].trim(),nombre:(p[2]||p[1]).trim(),tipo_activo:(p[3]||'Acción').trim(),fecha:(p[4]||'').trim(),titulos:qty,precio:price,divisa:dv,importe:toEUR(qty*price,dv,p[4]||''),ref:'csv'}); }
      added++;
    });
    input.value='';
    if (b==='f'){processFondos();renderFondos();}else{processAcciones();renderAcciones();}
    alert('✅ '+added+' operaciones importadas.');
  };
  reader.readAsText(file);
}
function filterOpsA(type) {
  opsFilterA=type;
  ['all','compra','venta','dividendo'].forEach(function(t){
    var el=document.getElementById('aof-'+(t==='dividendo'?'div':t));
    if (el){el.style.borderColor=t===type?'var(--pur)':'';el.style.color=t===type?'var(--pur)':'';}
  });
  renderAccionesOps();
}

// ── GUARDAR YAHOO TICKER ────────────────────────────────────────

// ── BUSCAR YAHOO TICKER POR ISIN ────────────────────────────────
function searchYahooTicker(isin) {
  var inp  = document.getElementById('yt-' + isin);
  var srch = document.getElementById('yt-srch-' + isin);
  if (!inp) return;

  var origHtml = srch ? srch.innerHTML : '';
  if (srch) { srch.innerHTML = '\u23f3'; srch.style.pointerEvents = 'none'; }
  inp.style.opacity = '.5';

  fetch('precio.php?action=search&isin=' + encodeURIComponent(isin))
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (srch) { srch.innerHTML = origHtml; srch.style.pointerEvents = ''; }
      inp.style.opacity = '1';
      if (d.error || !d.symbol) {
        inp.style.borderColor = 'var(--red)';
        setTimeout(function(){ inp.style.borderColor = 'rgba(255,77,109,.4)'; }, 2500);
        return;
      }
      if (d.all && d.all.length > 1) {
        _showTickerPicker(isin, d.all);
      } else {
        inp.value = d.symbol;
        inp.style.borderColor = 'var(--ac)';
        inp.title = (d.name || '') + ' (' + (d.type || '') + ')';
        setTimeout(function(){ saveYahooTicker(isin); }, 200);
      }
    })
    .catch(function() {
      if (srch) { srch.innerHTML = origHtml; srch.style.pointerEvents = ''; }
      inp.style.opacity = '1';
    });
}

function _showTickerPicker(isin, options) {
  var oldP = document.getElementById('yt-picker');
  if (oldP) oldP.remove();
  var inp = document.getElementById('yt-' + isin);
  var rect = inp ? inp.getBoundingClientRect() : {left:100, bottom:100};

  var items = options.map(function(q) {
    return '<div onclick="_pickTicker(' + "'" + isin + "','" + q.symbol + "')" +
      ' style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--bd);display:flex;justify-content:space-between;gap:10px"' +
      ' onmouseover="this.style.background=\'var(--s2)\'" onmouseout="this.style.background=\'\'">' +
      '<span style="font-family:monospace;font-weight:700;color:var(--fondos);white-space:nowrap">' + q.symbol + '</span>' +
      '<span style="font-size:11px;color:var(--mu2);flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">' + (q.name||'') + '</span>' +
      '<span style="font-size:10px;color:var(--mu);white-space:nowrap">' + (q.type||'') + '\u00b7' + (q.exchange||'') + '</span>' +
      '</div>';
  }).join('');

  var picker = document.createElement('div');
  picker.id = 'yt-picker';
  picker.innerHTML =
    '<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mu2);padding:8px 12px;border-bottom:1px solid var(--bd)">' +
      'Selecciona el ticker correcto para ' + isin + '</div>' +
    items +
    '<div style="padding:6px 12px;text-align:right">' +
      '<button onclick="document.getElementById(\'yt-picker\').remove()" ' +
        'style="background:none;border:none;color:var(--mu);cursor:pointer;font-size:11px">Cancelar</button></div>';
  picker.style.cssText =
    'position:fixed;z-index:9999;background:var(--s);border:1px solid var(--bd);' +
    'border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);min-width:380px;max-width:500px;' +
    'left:' + Math.min(rect.left, window.innerWidth - 510) + 'px;' +
    'top:' + (rect.bottom + 6) + 'px';
  document.body.appendChild(picker);

  setTimeout(function(){
    document.addEventListener('click', function _close(e){
      var p2 = document.getElementById('yt-picker');
      if (p2 && !p2.contains(e.target)) { p2.remove(); document.removeEventListener('click', _close); }
    });
  }, 100);
}

function _pickTicker(isin, symbol) {
  var p = document.getElementById('yt-picker'); if (p) p.remove();
  var inp = document.getElementById('yt-' + isin);
  if (inp) { inp.value = symbol; inp.style.borderColor = 'var(--ac)'; }
  saveYahooTicker(isin);
}

function saveYahooTicker(isin) {
  var inp = document.getElementById('yt-' + isin);
  if (!inp) return;
  var ticker = inp.value.trim();

  fetch('guardar.php', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      token:        AUTH_HASH_CLIENT,
      action:       'save_yahoo_ticker',
      isin:         isin,
      yahoo_ticker: ticker
    })
  })
  .then(function(r){ return r.json(); })
  .then(function(d) {
    if (d.ok) {
      // Actualizar en memoria
      YAHOO_GLOBAL[isin] = ticker;
      if (KNOWN_FONDOS[isin]) KNOWN_FONDOS[isin].yahoo_ticker = ticker;
      var rawPos = FPOS_RAW.find(function(p){ return p.isin === isin; });
      if (rawPos) rawPos.yahoo_ticker = ticker;
      // Feedback visual: borde verde y lanzar refresh automático
      inp.style.borderColor = ticker ? 'var(--ac)' : 'rgba(255,77,109,.4)';
      setTimeout(function(){
        inp.style.borderColor = ticker ? 'var(--bd)' : 'rgba(255,77,109,.4)';
        // Si hay ticker, lanzar refresh para obtener el precio inmediatamente
        if (ticker) {
          // Comprobar si todos los fondos ya tienen ticker antes de lanzar
          var allHaveTicker = FPOS_RAW.every(function(p){ return !!YAHOO_GLOBAL[p.isin]; });
          // Lanzar refresh si hay al menos un ticker disponible
          if (Object.keys(YAHOO_GLOBAL).length > 0) { refreshPrices(); }
        }
      }, 600);
    } else {
      alert('Error: ' + (d.msg || 'desconocido'));
    }
  })
  .catch(function(e){ alert('Error de conexión: ' + e.message); });
}

function filterOpsF(type) {
  opsFilterF=type;
  ['all','compra','venta','trasp'].forEach(function(t){
    var id='fof-'+t;
    var active=(t==='all'&&type==='all')||(t==='compra'&&type==='suscripcion')||(t==='venta'&&type==='reembolso')||(t==='trasp'&&(type==='traspaso_entrada'||type==='traspaso_salida'));
    var el=document.getElementById(id);
    if(el){el.style.borderColor=active?'var(--ac)':'';el.style.color=active?'var(--ac)':'';}});
  renderFondos();
}


// ════════════════════════════════════════════════════════════════
//  TICKER CONFIG PANEL (colapsable, fuera de la tabla de cartera)
// ════════════════════════════════════════════════════════════════
var _tickerPanelOpen = { f: false, a: false };

function toggleTickerPanel(type) {
  _tickerPanelOpen[type] = !_tickerPanelOpen[type];
  var body = document.getElementById(type + '-ticker-body');
  var chev = document.getElementById(type + '-ticker-chev');
  if (body) body.style.display = _tickerPanelOpen[type] ? 'block' : 'none';
  if (chev) chev.textContent   = _tickerPanelOpen[type] ? '▲' : '▼';
}

function renderTickerConfig() {
  // ── Fondos ──────────────────────────────────────────────────
  var elF = document.getElementById('f-ticker-config');
  if (elF) {
    var rowsF = FPOS_RAW.map(function(p) {
      var rawYT = (KNOWN_FONDOS[p.isin] && KNOWN_FONDOS[p.isin].yahoo_ticker) ? KNOWN_FONDOS[p.isin].yahoo_ticker : '';
      var border = rawYT ? 'var(--bd)' : 'rgba(255,77,109,.4)';
      var statusIcon = rawYT ? '✓' : '⚠';
      var statusColor = rawYT ? 'var(--ac)' : 'var(--red)';
      return '<div style="display:grid;grid-template-columns:110px 1fr 180px auto;gap:8px;align-items:center;padding:7px 0;border-top:1px solid var(--bd)">' +
        '<span class="mono" style="color:var(--fondos);font-weight:700;font-size:11px" title="'+p.nombre+'">'+p.isin.substring(0,8)+'</span>' +
        '<span style="font-size:11px;color:var(--mu2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+p.nombre+'</span>' +
        '<div style="display:flex;align-items:center;gap:4px">' +
          '<input id="yt-'+p.isin+'" type="text" value="'+rawYT+'" placeholder="ej: 0P0001XF40.F"' +
            ' style="background:var(--s2);border:1px solid '+border+';border-radius:6px;color:var(--text);padding:3px 8px;font-size:11px;font-family:monospace;width:100%;outline:none"' +
            ' title="Símbolo Yahoo Finance — necesario para obtener el precio NAV"' +
            ' onkeydown="if(event.key===\'Enter\')saveYahooTicker(\''+p.isin+'\')">' +
        '</div>' +
        '<div style="display:flex;gap:2px;align-items:center">' +
          '<span style="color:'+statusColor+';font-size:12px;width:14px;text-align:center">'+statusIcon+'</span>' +
          '<button onclick="searchYahooTicker(\''+p.isin+'\')" id="yt-srch-'+p.isin+'" style="background:none;border:none;color:var(--ac2);cursor:pointer;font-size:14px;padding:2px 4px" title="Buscar en Yahoo Finance">🔍</button>' +
          '<button onclick="saveYahooTicker(\''+p.isin+'\')" style="background:none;border:none;color:var(--mu2);cursor:pointer;font-size:13px;padding:2px 4px" title="Guardar">💾</button>' +
        '</div>' +
      '</div>';
    }).join('');
    var missingF = FPOS_RAW.filter(function(p){ return !(KNOWN_FONDOS[p.isin] && KNOWN_FONDOS[p.isin].yahoo_ticker); }).length;
    var badgeF = missingF > 0
      ? '<span style="color:var(--red);font-size:11px;margin-left:8px">⚠ '+missingF+' sin ticker</span>'
      : '<span style="color:var(--ac);font-size:11px;margin-left:8px">✓ todos configurados</span>';
    elF.innerHTML =
      '<div class="panel" style="padding:0">' +
        '<div class="ph" style="cursor:pointer;user-select:none" onclick="toggleTickerPanel(\'f\')">' +
          '<span class="ph-t" style="color:var(--mu2);font-size:11px">⚙ Yahoo Tickers — fondos'+badgeF+'</span>' +
          '<span id="f-ticker-chev" style="color:var(--mu2);font-size:11px">'+(_tickerPanelOpen.f?'▲':'▼')+'</span>' +
        '</div>' +
        '<div id="f-ticker-body" style="display:'+(_tickerPanelOpen.f?'block':'none')+';padding:8px 16px 14px">' +
          rowsF +
        '</div>' +
      '</div>';
  }

  // ── Acciones ────────────────────────────────────────────────
  var elA = document.getElementById('a-ticker-config');
  if (elA) {
    var rowsA = APOS_RAW.map(function(p) {
      var rawYTA = (p.isin && YAHOO_GLOBAL[p.isin]) ? YAHOO_GLOBAL[p.isin] : (YAHOO_GLOBAL[p.ticker] || '');
      var _lkA   = p.isin || p.ticker;
      var border = rawYTA ? 'var(--bd)' : 'rgba(255,77,109,.4)';
      var statusIcon = rawYTA ? '✓' : '⚠';
      var statusColor = rawYTA ? 'var(--ac)' : 'var(--red)';
      return '<div style="display:grid;grid-template-columns:80px 1fr 160px auto;gap:8px;align-items:center;padding:7px 0;border-top:1px solid var(--bd)">' +
        '<span class="mono" style="color:var(--acciones);font-weight:700;font-size:11px">'+p.ticker+'</span>' +
        '<span style="font-size:11px;color:var(--mu2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+p.nombre+'</span>' +
        '<div style="display:flex;align-items:center;gap:4px">' +
          '<input id="yt-a-'+p.ticker+'" type="text" value="'+rawYTA+'" placeholder="ej: BNP.PA"' +
            ' style="background:var(--s2);border:1px solid '+border+';border-radius:6px;color:var(--text);padding:3px 8px;font-size:11px;font-family:monospace;width:100%;outline:none"' +
            ' onkeydown="if(event.key===\'Enter\')saveYahooTickerA(\''+p.ticker+'\',\''+_lkA+'\')">' +
        '</div>' +
        '<div style="display:flex;gap:2px;align-items:center">' +
          '<span style="color:'+statusColor+';font-size:12px;width:14px;text-align:center">'+statusIcon+'</span>' +
          '<button onclick="searchYahooTickerA(\''+p.ticker+'\',\''+_lkA+'\')" id="yt-srch-a-'+p.ticker+'" style="background:none;border:none;color:var(--ac2);cursor:pointer;font-size:14px;padding:2px 4px" title="Buscar en Yahoo Finance">🔍</button>' +
          '<button onclick="saveYahooTickerA(\''+p.ticker+'\',\''+_lkA+'\')" style="background:none;border:none;color:var(--mu2);cursor:pointer;font-size:13px;padding:2px 4px" title="Guardar">💾</button>' +
        '</div>' +
      '</div>';
    }).join('');
    var missingA = APOS_RAW.filter(function(p){ var t=YAHOO_GLOBAL[p.isin]||YAHOO_GLOBAL[p.ticker]; return !t; }).length;
    var badgeA = missingA > 0
      ? '<span style="color:var(--red);font-size:11px;margin-left:8px">⚠ '+missingA+' sin ticker</span>'
      : '<span style="color:var(--ac);font-size:11px;margin-left:8px">✓ todos configurados</span>';
    elA.innerHTML =
      '<div class="panel" style="padding:0">' +
        '<div class="ph" style="cursor:pointer;user-select:none" onclick="toggleTickerPanel(\'a\')">' +
          '<span class="ph-t" style="color:var(--mu2);font-size:11px">⚙ Yahoo Tickers — acciones'+badgeA+'</span>' +
          '<span id="a-ticker-chev" style="color:var(--mu2);font-size:11px">'+(_tickerPanelOpen.a?'▲':'▼')+'</span>' +
        '</div>' +
        '<div id="a-ticker-body" style="display:'+(_tickerPanelOpen.a?'block':'none')+';padding:8px 16px 14px">' +
          rowsA +
        '</div>' +
      '</div>';
  }
}

// ════════════════════════════════════════════════════════════════
//  RENDER FONDOS
// ════════════════════════════════════════════════════════════════
function renderFondos() {
  // Sin precios frescos: blanquear KPIs numéricos y dejar las tablas estructurales
  if (!window._PRICES_LOADED) {
    var _dash = '<span style="color:var(--mu)">—</span>';
    ['f-kd','f-ka','f-kfis','f-years','f-fpos','f-ranking','f-tb-ventas','f-tb-traspasos'].forEach(function(id){
      var el = document.getElementById(id); if (el) el.innerHTML = '';
    });
    var bEl = document.getElementById('f-b-pos'); if (bEl) bEl.innerHTML = '';
    var rEl = document.getElementById('f-reembolsos-badge'); if (rEl) rEl.textContent = '—';
    var phEl = document.getElementById('f-coste-fiscal-ph'); if (phEl) phEl.textContent = 'Coste fiscal · broker —';
    var ttEl = document.getElementById('f-traspasos-title'); if (ttEl) ttEl.textContent = 'Traspasos';
  }
  var fifo=calcRealizedFondos();
  var FVENTAS=fifo.reembolsos, FTRASPASOS=fifo.traspasos;
  var tv=FPOS.reduce(function(s,p){return s+p.currentValue;},0);
  var tc=FPOS.reduce(function(s,p){return s+p.cost;},0);
  var tiReal=(window._FONDOS_IR_TOTAL)||FPOS.reduce(function(s,p){return s+p.invertidoReal;},0);
  var gl=tv-tc, glp=tc>0?(gl/tc)*100:0;
  var glp_real=tiReal>0?((tv-tiReal)/tiReal)*100:0;
  var totalReal=FVENTAS.reduce(function(s,v){return s+v.gain;},0);
  var glTotal=gl+totalReal;
  updateHeaderVal(fifo);

  if (!window._PRICES_LOADED) {
    // Solo renderizar tablas estructurales (sin KPIs numéricos)
    // Las secciones de KPI ya se vaciaron arriba
  } else {
  var suscr=FOPS_RAW.filter(function(o){return o.tipo==='suscripcion';});
  document.getElementById('f-kd').innerHTML = kpi([
    {l:'💼 Valor cartera fondos', v:E(tv), s:(function(){ var d=FPOS_RAW.map(function(p){return p._priceDate;}).filter(Boolean).sort().pop(); return d?'NAV '+fmtD(d):'sin fecha'; })(), c:'var(--fondos)'},
    {l:'📈 G/P latente', v:(gl>=0?'+':'')+E(gl), s:(glp>=0?'+':'')+glp.toFixed(1)+'% s/inv. actual · '+(glp_real>=0?'+':'')+glp_real.toFixed(1)+'% s/inv. real', c:C(gl)},
    {l:'💰 G/P realizada (reembolsos)', v:(totalReal>=0?'+':'')+E(Math.round(totalReal*100)/100), s:FVENTAS.length+' reembolsos tributables', c:C(totalReal)},
    {l:'🔄 Movimientos totales', v:FOPS_RAW.length, s:suscr.length+' suscripciones · '+FVENTAS.length+' reembolsos · '+FTRASPASOS.length+' traspasos', c:'var(--yel)'},
  ]);

  var tiReal = FPOS.reduce(function(s,p){return s+p.invertidoReal;},0);
  var glpRealTotal = tiReal>0?((tv-tiReal)/tiReal)*100:0;
  } // end if _PRICES_LOADED (KPIs numéricos)

  document.getElementById('f-b-pos').innerHTML = bdg(FPOS.length+' fondos activos','var(--fondos)');
  document.getElementById('f-tb-cartera').innerHTML = FPOS.map(function(p) {
    return '<tr><td class="mono" style="font-weight:700">'+(FT_URL[p.isin]?'<a href="'+FT_URL[p.isin]+'" target="_blank" style="color:var(--fondos);text-decoration:none" title="Ver en FT">'+p.ticker+'</a>':'<span style="color:var(--fondos)">'+p.ticker+'</span>')+'</td>'+
      '<td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+p.nombre+'">'+p.nombre+'</td><td class="mono">'+N(p.qty,5)+'</td>'+
      '<td class="mono mu">'+E(p.avgPrice)+'</td>'+
      '<td class="mono" style="font-weight:700">'+E(p.currentPrice)+'</td>'+
      '<td class="mono mu" style="font-size:10px;color:var(--mu2)">'+( p._priceDate ? fmtD(p._priceDate) : '—' )+'</td>'+
      '<td class="mono" style="font-weight:700">'+E(p.currentValue)+'</td>'+
      '<td class="mono" style="color:'+C(p.gainLoss)+';font-weight:700" title="vs coste adq. · Real: '+(p.gainLossReal>=0?'+':'')+E(Math.round(p.gainLossReal*100)/100)+' vs cash aportado">'+(p.gainLoss>=0?'+':'')+E(p.gainLoss)+'</td>'+
      '<td class="mono" style="color:'+C(p.gainLossPct)+';font-weight:800" title="% vs coste adq. · Real: '+(p.gainLossPctReal>=0?'+':'')+p.gainLossPctReal.toFixed(1)+'% vs cash">'+P(p.gainLossPct)+'</td>'+
      (function(){
        var snaps = PRICE_HISTORY[p.isin] || [];
        var hist  = p._hist || null;  // {1w, 1m, 3m, 1y} precios absolutos desde Yahoo
        if ((!snaps.length && !hist) || !p.currentPrice) return '<td class="mono mu" style="font-size:10px">—</td><td class="mono mu" style="font-size:10px">—</td><td class="mono mu" style="font-size:10px">—</td><td class="mono mu" style="font-size:10px">—</td>';
        // snapPct: busca en historial acumulado; si no hay snap suficiente, usa _hist de Yahoo
        function snapPct(daysAgo, histKey){
          // 1. Intentar con snapshots locales acumulados
          if (snaps.length) {
            var target = new Date(); target.setDate(target.getDate()-daysAgo);
            var tStr = target.toISOString().substring(0,10);
            var best=null, bestDiff=Infinity;
            snaps.forEach(function(s){
              if (s.date > tStr) return;
              var diff = Math.abs(new Date(s.date)-new Date(tStr));
              if (diff < bestDiff){ bestDiff=diff; best=s.price; }
            });
            // Solo usar snapshot local si está dentro del doble del período buscado
            if (best && bestDiff < daysAgo * 2 * 86400000) {
              var pct=((p.currentPrice-best)/best)*100;
              return '<td class="mono" style="font-size:11px;font-weight:700;color:'+C(pct)+';text-align:right">'+(pct>=0?'+':'')+pct.toFixed(1)+'%</td>';
            }
          }
          // 2. Fallback: precio histórico devuelto por Yahoo en este refresh
          if (hist && hist[histKey] && hist[histKey] > 0) {
            var pct=((p.currentPrice - hist[histKey]) / hist[histKey])*100;
            return '<td class="mono" style="font-size:11px;font-weight:700;color:'+C(pct)+';text-align:right;opacity:.85" title="Dato Yahoo Finance">'+(pct>=0?'+':'')+pct.toFixed(1)+'%</td>';
          }
          return '<td class="mono mu" style="font-size:10px">—</td>';
        }
        return snapPct(7,'1w')+snapPct(30,'1m')+snapPct(91,'3m')+snapPct(365,'1y');
      })()+
      '</tr>';
  }).concat((function(){
    if (!FPOS.length) return [];
    var tv=FPOS.reduce(function(s,p){return s+p.currentValue;},0);
    var tc=FPOS.reduce(function(s,p){return s+p.cost;},0);
    var gl=tv-tc, glp=tc>0?(gl/tc)*100:0;
    return ['<tr style="background:var(--s2);font-weight:700;border-top:2px solid var(--bd)">'+
      '<td colspan="2" style="color:var(--mu2)">TOTAL</td>'+
      '<td></td>'+
      '<td></td>'+
      '<td></td>'+
      '<td></td>'+
      '<td class="mono" style="font-weight:800;color:var(--fondos)">'+E(Math.round(tv*100)/100)+'</td>'+
      '<td class="mono" style="color:'+C(gl)+';font-weight:800">'+(gl>=0?'+':'')+E(Math.round(gl*100)/100)+'</td>'+
      '<td class="mono" style="color:'+C(glp)+';font-weight:800">'+(glp>=0?'+':'')+glp.toFixed(1)+'%</td>'+
      '<td colspan="4"></td>'+
    '</tr>'];
  })()).join('');

  document.getElementById('f-b-ops').innerHTML = bdg(FOPS_RAW.length+' movimientos','var(--yel)');
  var fopsFiltered = opsFilterF==='all' ? FOPS_RAW : FOPS_RAW.filter(function(o){
    if (opsFilterF==='traspaso_entrada') return o.tipo==='traspaso_entrada'||o.tipo==='traspaso_salida';
    return o.tipo===opsFilterF;
  });
  document.getElementById('f-b-ops').innerHTML = '<span style="font-size:11px;color:var(--mu2);margin-left:8px">'+fopsFiltered.length+'/'+FOPS_RAW.length+' movimientos</span>';
  var _fsc=_fOpsSort.col, _fsd=_fOpsSort.dir;
  var _fSorted = fopsFiltered.slice().sort(function(a,b){
    if (_fsc==='fecha')  return _fsd*(a.fecha<b.fecha?-1:a.fecha>b.fecha?1:0);
    if (_fsc==='nombre') return _fsd*(a.nombre<b.nombre?-1:a.nombre>b.nombre?1:0);
    if (_fsc==='tipo')   return _fsd*(a.tipo<b.tipo?-1:a.tipo>b.tipo?1:0);
    if (_fsc==='total')  return _fsd*(a.importe-b.importe);
    return 0;
  });
  document.getElementById('f-tb-ops').innerHTML = _fSorted.map(function(op) {
    var tc2=op.tipo==='suscripcion'?'var(--fondos)':op.tipo==='reembolso'?'var(--red)':op.tipo==='traspaso_entrada'?'var(--ac2)':'var(--yel)';
    var tl=op.tipo==='suscripcion'?'Suscripci\u00f3n':op.tipo==='reembolso'?'Reembolso':op.tipo==='traspaso_entrada'?'Trasp. entrada':'Trasp. salida';
    return '<tr><td>'+bdg(tl,tc2)+'</td>'+
      '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        '<span style="font-weight:700;color:var(--text);font-size:11px">'+op.nombre+'</span>' +
        '<span class="mono" style="font-size:9px;color:var(--fondos);margin-left:4px">'+op.isin.substring(0,8)+'</span></td>'+
      '<td class="mu" style="white-space:nowrap">'+fmtDMY(op.fecha)+'</td>'+
      '<td class="mono">'+N(op.titulos,5)+'</td><td class="mono">'+E(op.precio)+'</td>'+
      '<td class="mono mu">—</td>'+
      '<td class="mono" style="color:'+(op.tipo==='suscripcion'?'var(--red)':'var(--fondos)')+';font-weight:700">'+(op.tipo==='suscripcion'?'- ':'+ ')+E(op.importe)+'</td>'+
      '<td style="white-space:nowrap">'+(op.ref?
        '<button onclick="editFondoOp(\''+op.ref+'\')" style="background:none;border:none;color:var(--mu2);cursor:pointer;font-size:14px;padding:2px 5px" title="Editar">\u270e</button>'+
        '<button onclick="deleteOp(\'fondos\',\''+op.ref+'\')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:13px;padding:2px 5px" title="Eliminar">\u2715</button>'
      :'')+'</td></tr>';
  }).join('');
  // Actualizar flechas de sort en cabecera f-tb-ops
  (function(){
    var tbl = document.querySelector('#f-tb-ops');
    if (!tbl) return;
    var thead = tbl.closest('table').querySelector('thead');
    if (!thead) return;
    var colMapF = {'0':'tipo','1':'nombre','2':'fecha','5':'total'};
    thead.querySelectorAll('th').forEach(function(th){
      th.classList.remove('sort-asc','sort-desc');
      if (colMapF[th.dataset.col] === _fsc)
        th.classList.add(_fsd === -1 ? 'sort-desc' : 'sort-asc');
    });
  })();

  if (window._PRICES_LOADED && FPOS.length > 0) {
  var best=FPOS.reduce(function(a,b){return a.gainLossPct>b.gainLossPct?a:b;});
  var worst=FPOS.reduce(function(a,b){return a.gainLossPct<b.gainLossPct?a:b;});
  document.getElementById('f-ka').innerHTML = kpi([
    {l:'📈 G/P latente (abiertas)', v:(gl>=0?'+':'')+E(gl), s:P(glp), c:C(gl)},
    {l:'💰 G/P realizada (reembolsos)', v:(totalReal>=0?'+':'')+E(Math.round(totalReal*100)/100), s:FVENTAS.length+' reembolsos', c:C(totalReal)},
    {l:'🏁 TOTAL histórico fondos', v:(glTotal>=0?'+':'')+E(Math.round(glTotal*100)/100), s:'latente '+E(gl)+' + realizado '+E(Math.round(totalReal*100)/100), c:C(glTotal)},
    {l:'🏆 Mejor / Peor', v:best.nombre.split(' ').slice(0,2).join(' ')+' / '+worst.nombre.split(' ').slice(0,2).join(' '), s:P(best.gainLossPct)+' / '+P(worst.gainLossPct), c:'var(--fondos)'},
  ]);

  // Panel desglose
  var rzByIsin={};
  FVENTAS.forEach(function(v){rzByIsin[v.isin]=(rzByIsin[v.isin]||0)+v.gain;});
  function buildDesglosePanel(rzByIsin, FPOS_local, gl, glTotal, totalReal) {
    var sc = _desgloseSort.col, sd = _desgloseSort.dir;
    function arrow(col) {
      if (sc !== col) return '<span style="color:var(--mu);opacity:.35;font-size:9px"> ⇅</span>';
      return '<span style="font-size:9px">' + (sd === -1 ? ' ↓' : ' ↑') + '</span>';
    }
    function hdr(col, label) {
      return '<span style="text-align:right;cursor:pointer;user-select:none" onclick="_desgloseSetSort(\''+col+'\')">'
        + label + arrow(col) + '</span>';
    }
    var rows = FPOS_local.map(function(p){
      return {p:p, rz:rzByIsin[p.isin]||0, lat:p.gainLoss, tot:(rzByIsin[p.isin]||0)+p.gainLoss};
    });
    rows.sort(function(a,b){ return (b[sc]-a[sc])*sd; });

    var h='<div style="margin-bottom:12px;padding:12px;background:rgba(0,229,176,.04);border:1px solid rgba(0,229,176,.18);border-radius:10px">';
    h+='<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mu);margin-bottom:10px">Desglose rendimiento fondos</div>';
    h+='<div style="display:grid;grid-template-columns:1fr 100px 130px 70px 130px;gap:4px;padding:0 4px;font-size:10px;font-weight:700;color:var(--mu);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">'
      +'<span>Fondo</span>'
      +hdr('rz','G/P realiz.')+hdr('lat','G/P latente')+'<span style="text-align:right">%</span>'+hdr('tot','Total')
      +'</div>';
    rows.forEach(function(r){
      var rz=r.rz, lat=r.lat, tot=r.tot;
      var latp=r.p.gainLossPct;
      h+='<div style="display:grid;grid-template-columns:1fr 100px 130px 70px 130px;gap:4px;padding:6px 4px;border-top:1px solid var(--bd);align-items:center">';
      h+='<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
        +'<span style="font-size:12px;font-weight:700;color:var(--text)">'+r.p.nombre+'</span>'
        +' <span class="mono" style="font-size:10px;color:var(--fondos)">'+r.p.ticker+'</span>'
        +'</span>';
      h+='<span class="mono" style="text-align:right;font-size:11px;color:'+C(rz)+'">'+(Math.abs(rz)>0.001?(rz>=0?'+':'')+E(rz):'—')+'</span>';
      h+='<span class="mono" style="text-align:right;font-size:11px;color:'+C(lat)+'">'+(lat>=0?'+':'')+E(lat)+'</span>';
      h+='<span class="mono" style="text-align:right;font-size:11px;color:'+C(latp)+';font-weight:700">'+P(latp)+'</span>';
      h+='<span class="mono" style="text-align:right;font-size:12px;font-weight:700;color:'+C(tot)+'">'+(tot>=0?'+':'')+E(Math.round(tot*100)/100)+'</span>';
      h+='</div>';
    });
    h+='<div style="display:grid;grid-template-columns:1fr 100px 130px 70px 130px;gap:4px;padding:8px 4px;border-top:2px solid var(--bd);margin-top:4px">';
    h+='<span class="mono" style="font-weight:800;font-size:12px">TOTAL</span>';
    h+='<span class="mono" style="text-align:right;font-size:11px;color:'+C(totalReal)+';font-weight:700">'+(totalReal>=0?'+':'')+E(Math.round(totalReal*100)/100)+'</span>';
    h+='<span class="mono" style="text-align:right;font-size:11px;color:'+C(gl)+';font-weight:700">'+(gl>=0?'+':'')+E(gl)+'</span>';
    h+='<span></span>';
    h+='<span class="mono" style="text-align:right;font-size:13px;font-weight:800;color:'+C(glTotal)+'">'+(glTotal>=0?'+':'')+E(Math.round(glTotal*100)/100)+'</span>';
    h+='</div></div>';
    return h;
  }
  window._desgloseSetSort = function(col) {
    if (_desgloseSort.col === col) _desgloseSort.dir *= -1;
    else { _desgloseSort.col = col; _desgloseSort.dir = -1; }
    renderFondos();
  };

  var h = buildDesglosePanel(rzByIsin, FPOS, gl, glTotal, totalReal);
  var old=document.getElementById('f-hist-panel'); if (old) old.remove();
  document.getElementById('f-ranking').insertAdjacentHTML('beforebegin','<div id="f-hist-panel">'+h+'</div>');

  document.getElementById('f-ranking').innerHTML = FPOS.slice().sort(function(a,b){return b.gainLossPct-a.gainLossPct;}).map(function(p,i){
    return '<div class="rrow"><div style="display:flex;align-items:center;gap:8px">'+
      '<span class="mu mono" style="font-size:11px;width:14px">'+(i+1)+'.</span>'+
      '<span style="font-weight:700;color:var(--text)">'+p.nombre+'</span>'+
      '<span class="mono" style="font-size:10px;color:var(--fondos)">'+p.ticker+'</span></div>'+
      '<div style="display:flex;gap:12px;align-items:center">'+
      '<span class="mono mu" style="font-size:11px">'+E(p.gainLoss)+'</span>'+
      '<span class="mono" style="color:'+C(p.gainLossPct)+';font-weight:800;font-size:12px">'+P(p.gainLossPct)+'</span></div></div>';
  }).join('');

  setTimeout(function(){
    var tv2=FPOS.reduce(function(s,p){return s+p.currentValue;},0);
    document.getElementById('pie-lbl-f').innerHTML=FPOS.map(function(p,i){
      var pct = N(p.currentValue/tv2*100,1);
      var glp = p.gainLossPct;
      return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid var(--bd)" title="'+p.nombre+'">' +
        '<span style="width:8px;height:8px;border-radius:2px;flex-shrink:0;background:'+COLORS[i%COLORS.length]+'"></span>' +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;color:var(--text)">'+p.nombre+'</span>' +
        '<span class="mono" style="font-size:11px;color:var(--mu2);flex-shrink:0">'+pct+'%</span>' +
        '<span class="mono" style="font-size:11px;font-weight:700;flex-shrink:0;color:'+C(glp)+'">'+P(glp)+'</span>' +
        '<span class="mono" style="font-size:11px;font-weight:700;color:var(--text);flex-shrink:0;min-width:64px;text-align:right">'+E(p.currentValue)+'</span>' +
      '</div>';
    }).join('');
  },60);

  var yrF = new Date().getFullYear().toString();
  var yrF1 = (parseInt(yrF)+1).toString();
  // Bug fix: REEMBOLSOS_BROKER usa campo 'fecha' (YYYY-MM-DD), no 'year'
  var g25=FVENTAS.filter(function(v){return (v.fecha||'').substring(0,4)===yrF;}).reduce(function(s,v){return s+v.gain;},0);
  var g26=FVENTAS.filter(function(v){return (v.fecha||'').substring(0,4)===yrF1;}).reduce(function(s,v){return s+v.gain;},0);
  var i25=irpf(g25);
  document.getElementById('f-kfis').innerHTML = kpi([
    {l:'💶 G/P total realizada fondos', v:(totalReal>=0?'+':'')+E(Math.round(totalReal*100)/100), s:FVENTAS.length+' reembolsos tributables', c:C(totalReal)},
    {l:'🧾 Base imponible '+yrF, v:E(Math.round(g25*100)/100), s:'IRPF est. '+E(i25), c:'var(--yel)'},
    {l:'📆 G/P realizada '+yrF1, v:(g26>=0?'+':'')+E(Math.round(g26*100)/100), s:g26<0?'Compensable 4 años':'A declarar', c:C(g26)},
    {l:'🔄 Traspasos no tributables', v:FTRASPASOS.length, s:'coste fiscal heredado', c:'var(--pur)'},
  ]);
  // Mostrar todos los años con reembolsos (no solo yrF/yrF1)
  var _allYrs={};
  FVENTAS.forEach(function(r){ var y=(r.fecha||'').substring(0,4); if(y) _allYrs[y]=(_allYrs[y]||0)+r.gain; });
  var _sortedYrs=Object.keys(_allYrs).sort().reverse(); // más reciente primero
  if (!_allYrs[yrF]) { _allYrs[yrF]=0; if(_sortedYrs.indexOf(yrF)<0) _sortedYrs.unshift(yrF); }
  if (!_allYrs[yrF1]) { _allYrs[yrF1]=0; if(_sortedYrs.indexOf(yrF1)<0) _sortedYrs.unshift(yrF1); _sortedYrs.sort().reverse(); }
  document.getElementById('f-years').innerHTML=_sortedYrs.map(function(y){
    var g=_allYrs[y], i=irpf(Math.max(0,g));
    var isCurrent = y===yrF, isFuture = parseInt(y)>parseInt(yrF);
    var label = isCurrent?'<span style="font-size:10px;color:var(--yel);margin-left:6px">año en curso</span>':
                isFuture?'<span style="font-size:10px;color:var(--mu2);margin-left:6px">próximo</span>':'';
    return '<div class="rrow" style="flex-direction:column;align-items:flex-start;gap:5px;margin-bottom:7px">'+
      '<div style="display:flex;justify-content:space-between;width:100%">'+
        '<span style="font-weight:800;font-size:14px">'+y+label+'</span>'+
        '<span class="mono" style="color:'+C(g)+';font-weight:800">'+(g>=0?'+':'')+E(Math.round(g*100)/100)+'</span></div>'+
      '<div style="display:flex;gap:12px;font-size:11px;color:var(--mu2)">'+
        '<span>IRPF est. anual: <strong style="color:var(--yel)">'+E(i)+'</strong></span>'+
        (g<0?'<span style="color:var(--ac)">Compensable hasta '+(parseInt(y)+4)+'</span>':'')+
      '</div></div>';
  }).join('');
  document.getElementById('f-fpos').innerHTML=FPOS.map(function(p){
    return '<div class="rrow"><div style="display:flex;align-items:center;gap:8px">'+
      '<span style="font-weight:700;color:var(--text)">'+p.nombre+'</span>'+
      '<span class="mono" style="font-size:10px;color:var(--fondos)">'+p.ticker+'</span>'+
      '<span class="mu" style="font-size:11px">&nbsp;·&nbsp;'+N(p.qty,5)+' títulos</span></div>'+
      '<div style="display:flex;gap:10px"><span class="mono mu" style="font-size:11px">'+E(p.cost)+'</span>'+
      '<span class="mono mu" style="font-size:11px">'+E(p.avgPrice)+'/u</span></div></div>';
  }).join('');
  // Fix: calcular IRPF anual correcto (progresivo sobre base total del año, no por operación)
  var _gainByYr={};
  FVENTAS.forEach(function(r){ var y=(r.fecha||'').substring(0,4); _gainByYr[y]=(_gainByYr[y]||0)+r.gain; });
  var _irpfByYr={};
  Object.keys(_gainByYr).forEach(function(y){ _irpfByYr[y]=irpf(Math.max(0,_gainByYr[y])); });
  document.getElementById('f-tb-ventas').innerHTML=FVENTAS.map(function(r){
    // IRPF marginal estimado: proporcional a la ganancia de este reembolso sobre el total del año
    var y=(r.fecha||'').substring(0,4);
    var yrTotal=_gainByYr[y]||0, yrIrpf=_irpfByYr[y]||0;
    var ir = (r.gain>0 && yrTotal>0) ? Math.round((r.gain/yrTotal)*yrIrpf*100)/100 : 0;
    var net=r.gain-ir;
    var fecha = r.fecha ? fmtD(r.fecha) : '—';
    var lots=(r.lots||[]).map(function(l){return '<div class="lot-row"><span class="mu">'+l.d+'</span><span class="mono">'+N(l.q,5)+' u × '+E(l.cu)+'</span></div>';}).join('');
    var lotsCount=(r.lots||[]).length;
    var lotsLabel=lotsCount>0
      ?'<details><summary>'+lotsCount+' lote'+(lotsCount>1?'s':'')+'</summary><div style="margin-top:4px">'+lots+'</div></details>'
      :'<span style="color:var(--mu);font-size:10px">broker FIFO</span>';
    return '<tr><td class="mu" style="white-space:nowrap">'+fecha+'</td>'+
      '<td><span style="font-weight:700;color:var(--text)">'+r.nombre+'</span>'
        +' <span class="mono" style="font-size:10px;color:var(--fondos)" title="'+(r.p&&r.p.isin||'')+'">'+((r.p&&r.p.yahoo_ticker) || ((r.p&&r.p.isin)||'').substring(0,8))+'</span></td>'+
      '<td class="mono">'+N(r.titulos,5)+'</td><td class="mono">'+E(r.importe)+'</td>'+
      '<td class="mono mu">'+E(r.coste)+'</td>'+
      '<td class="mono" style="color:'+C(r.gain)+';font-weight:700">'+(r.gain>=0?'+':'')+E(r.gain)+'</td>'+
      '<td class="mono" style="color:var(--yel)">'+(r.gain>0?E(ir):bdg('pérdida','var(--pur)'))+'</td>'+
      '<td class="mono" style="color:'+C(net)+';font-weight:700">'+(net>=0?'+':'')+E(net)+'</td>'+
      '<td>'+lotsLabel+'</td></tr>';
  }).join('');
  document.getElementById('f-tb-traspasos').innerHTML=FTRASPASOS.map(function(t){
    return '<tr><td class="mu" style="white-space:nowrap">'+fmtDMY(t.date)+'</td>'+
      '<td class="mono" style="color:var(--fondos);font-size:11px" title="'+(t.fromFull||t.from)+'">'+t.from+'</td>'+
      '<td class="mono" style="color:var(--yel);font-size:11px" title="'+(t.toFull||t.to)+'">'+t.to+'</td>'+
      '<td class="mono">'+E(t.imp)+'</td>'+
      '<td><span class="no-trib">No tributa</span></td></tr>';
  }).join('');


  // ── Contadores panel fiscal (dinámicos) ──────────────────────────────────────
  (function() {
    var latestIso = null;
    FPOS_RAW.forEach(function(p) {
      var iso = p._priceDate ? p._priceDate.split(' ')[0] : null;
      if (!iso && p.fecha_precio) {
        var pts = p.fecha_precio.split('/');
        if (pts.length === 3) iso = pts[2]+'-'+pts[1]+'-'+pts[0];
      }
      if (iso && (!latestIso || iso > latestIso)) latestIso = iso;
    });
    var phCoste = document.getElementById('f-coste-fiscal-ph');
    if (phCoste) phCoste.textContent = 'Coste fiscal \u00b7 broker ' + (latestIso ? fmtD(latestIso) : '\u2014');
    var badgeR = document.getElementById('f-reembolsos-badge');
    if (badgeR) {
      if (FVENTAS.length > 0) {
        var totalGainR = FVENTAS.reduce(function(s,v){ return s+v.gain; }, 0);
        var byTk = {};
        FVENTAS.forEach(function(v){ byTk[v.isin]=(byTk[v.isin]||0)+1; });
        var topNames = Object.keys(byTk).sort(function(a,b){ return byTk[b]-byTk[a]; })
          .slice(0,2).map(function(isin){
            var f = KNOWN_FONDOS[isin]; return f ? f.nombre.split(' ').slice(0,3).join(' ') : isin.substring(0,8);
          });
        badgeR.textContent = FVENTAS.length+' reembolso'+(FVENTAS.length>1?'s':'')+
          ' · '+topNames.join(' · ')+' · G/P total '+(totalGainR>=0?'+':'')+E(Math.round(totalGainR*100)/100);
      } else { badgeR.textContent = 'Sin reembolsos'; }
    }
    var titleT = document.getElementById('f-traspasos-title');
    if (titleT) titleT.textContent = 'Traspasos ('+FTRASPASOS.length+' \u00b7 no tributables)';
  })();
  } // end if _PRICES_LOADED (f-ka, f-kfis, análisis, fiscal)
  renderTickerConfig();
}

// ════════════════════════════════════════════════════════════════
//  RENDER ACCIONES
// ════════════════════════════════════════════════════════════════
function renderAcciones() {
  if (!window._PRICES_LOADED) {
    ['a-kd','a-ka','a-kfis','a-years','a-divid-badge','a-divid-list','a-divid-years'].forEach(function(id){
      var el = document.getElementById(id); if (el) el.innerHTML = '';
    });
    var elR = document.getElementById('a-ranking'); if (elR) elR.innerHTML = '';
    var elH = document.getElementById('a-hist-panel'); if (elH) elH.remove();
  }
  var tv=APOS.reduce(function(s,p){return s+p.currentValue;},0);
  var tc=APOS.reduce(function(s,p){return s+p.cost;},0);
  var gl=tv-tc, glp=tc>0?(gl/tc)*100:0;
  var divids=AOPS.filter(function(o){return o.type==='dividendo';});
  var ventas=AOPS.filter(function(o){return o.type==='venta';});
  var totalDivid=divids.reduce(function(s,o){var _ti=o.importe||(o.qty*o.price);return s+toEUR(_ti,o.divisa,o.date);},0);
  var fifo=calcRealizedAcc(), totalReal=fifo.totalEur;
  var glTotal=gl+totalReal+totalDivid;
  updateHeaderVal(null);

  if (window._PRICES_LOADED) {
  document.getElementById('a-kd').innerHTML = kpi([
    {l:'📊 Valor posiciones abiertas', v:E(tv), s:(function(){
      var d=APOS_RAW.map(function(p){return p._priceDate;}).filter(Boolean).sort().pop();
      return d?'actualizado '+fmtD(d):'posiciones abiertas';
    })(), c:'var(--acciones)'},
    {l:'📈 G/P latente (abiertas)', v:(gl>=0?'+':'')+E(gl), s:P(glp)+' s/coste', c:C(gl)},
    {l:'💰 G/P realizada (FIFO·FX)', v:(totalReal>=0?'+':'')+E(Math.round(totalReal*100)/100), s:ventas.length+' ventas · tipo cambio real', c:C(totalReal)},
    {l:'💵 Dividendos cobrados', v:E(Math.round(totalDivid*100)/100), s:divids.length+' cobros · FX real', c:'var(--yel)'},
  ]);

  } // end if _PRICES_LOADED (a-kd)

  // Bug 4 fix: actualizar fecha del panel resumen dinámicamente
  (function(){
    var dEl = document.getElementById('a-summary-date');
    if (dEl) {
      var d = APOS_RAW.map(function(p){ return p._priceDate; }).filter(Boolean).sort().pop();
      dEl.textContent = d ? '· datos ' + fmtD(d) : '';
    }
  })();
  document.getElementById('a-tb-summary').innerHTML = APOS.map(function(p) {
    var ac=p.asset==='ETF'?'#0af':'var(--acciones)';
    var priceStr=p.divisa!=='EUR'?N(p.currentPrice,2)+' '+p.divisa:E(p.currentPrice);
    // Mostrar ticker real si existe (no-ISIN), si no solo el nombre
    var _tk = (!p.ticker || /^[A-Z]{2}[A-Z0-9]{10}$/.test(p.ticker)) ? '' : p.ticker;
    return '<tr>'+
      '<td><span style="display:flex;align-items:center;gap:7px">'+
        (_tk ? '<span class="mono" style="font-size:11px;color:var(--acciones);font-weight:700">'+_tk+'</span>' : '')+
        '<span style="font-weight:600">'+p.nombre+'</span>'+
      '</span></td><td>'+bdg(p.asset,ac)+'</td>'+
      '<td class="mono mu" style="font-size:10px">'+p.isin+'</td><td class="mono">'+p.qty+'</td>'+
      '<td class="mono">'+E(p.cost)+'</td>'+
      '<td class="mono" style="font-weight:700">'+E(p.currentValue)+'<span class="mu" style="font-size:10px;margin-left:4px">'+priceStr+'</span></td>'+
      '<td class="mono" style="color:'+C(p.gainLoss)+';font-weight:700">'+(p.gainLoss>=0?'+':'')+E(p.gainLoss)+'</td>'+
      '<td class="mono" style="color:'+C(p.gainLossPct)+';font-weight:800">'+P(p.gainLossPct)+'</td></tr>';
  }).concat(['<tr style="background:var(--s2)"><td colspan="3"><strong>TOTAL</strong></td><td></td>'+
    '<td class="mono"><strong>'+E(tc)+'</strong></td>'+
    '<td class="mono" style="color:var(--acciones);font-weight:800">'+E(tv)+'</td>'+
    '<td class="mono" style="color:'+C(gl)+';font-weight:800">'+(gl>=0?'+':'')+E(gl)+'</td>'+
    '<td class="mono" style="color:'+C(glp)+';font-weight:800">'+P(glp)+'</td></tr>']).join('');

  var dividByTicker={};
  divids.forEach(function(o){
    if (!dividByTicker[o.ticker]) dividByTicker[o.ticker]={name:o.name,total:0,totalEUR:0,count:0,divisa:o.divisa};
    var _divImp=o.importe||(o.qty*o.price);
    dividByTicker[o.ticker].total+=_divImp;
    dividByTicker[o.ticker].totalEUR+=toEUR(_divImp,o.divisa,o.date);
    dividByTicker[o.ticker].count++;
  });
  if (window._PRICES_LOADED) {
  document.getElementById('a-divid-badge').innerHTML = bdg(divids.length+' cobros · '+E(Math.round(totalDivid*100)/100),'var(--yel)');
  document.getElementById('a-divid-list').innerHTML = Object.keys(dividByTicker).map(function(tk){
    var d=dividByTicker[tk];
    var _dtk = (!tk || /^[A-Z]{2}[A-Z0-9]{10}$/.test(tk)) ? '' : tk;
    return '<div class="divid-row"><div style="display:flex;align-items:center;gap:8px">'+
      (_dtk ? '<span class="mono" style="color:var(--pur);font-weight:700;font-size:11px">'+_dtk+'</span>' : '')+
      '<span style="font-weight:600;font-size:12px">'+d.name+'</span></div>'+
      '<div style="display:flex;gap:14px;align-items:center">'+
      '<span class="mu" style="font-size:11px">'+d.count+' cobro'+(d.count>1?'s':'')+'</span>'+
      '<span class="mono mu" style="font-size:11px">'+N(d.total,4)+' '+d.divisa+'</span>'+
      '<span class="mono" style="color:var(--yel);font-weight:700">'+E(Math.round(d.totalEUR*100)/100)+'</span></div></div>';
  }).join('');
  } // end _PRICES_LOADED (a-divid)

  document.getElementById('a-b-pos').innerHTML=bdg(APOS.length+' posiciones abiertas','var(--acciones)');
  document.getElementById('a-tb-cartera').innerHTML=APOS.map(function(p){
    var ac=p.asset==='ETF'?'#0af':'var(--acciones)';
    var priceStr=p.divisa!=='EUR'?N(p.currentPrice,2)+' '+p.divisa:E(p.currentPrice);
    var avgStr=p.divisa!=='EUR'?N(p.avgPrice,4)+' '+p.divisa:E(p.avgPrice);
    var _tk2 = (!p.ticker || /^[A-Z]{2}[A-Z0-9]{10}$/.test(p.ticker)) ? '' : p.ticker;
    return '<tr>'+
      '<td><span style="display:flex;align-items:center;gap:7px">'+
        (_tk2?'<span class="mono" style="font-size:11px;color:var(--acciones);font-weight:700;flex-shrink:0">'+_tk2+'</span>':'')+
        '<span style="font-weight:600">'+p.nombre+'</span></span></td>'
      +'<td>'+bdg(p.asset,ac)+'</td>'+
      '<td class="mono">'+p.qty+'</td>'+
      '<td class="mono mu">'+avgStr+'</td><td class="mono" style="font-weight:700">'+priceStr+'</td>'+
      '<td class="mono mu" style="font-size:10px;color:var(--mu2)">'+( p._priceDateUI ? fmtDT(p._priceDateUI) : '—' )+'</td>'+
      '<td class="mono" style="font-weight:700">'+E(p.currentValue)+'</td>'+
      '<td class="mono" style="color:'+C(p.gainLoss)+';font-weight:700">'+(p.gainLoss>=0?'+':'')+E(p.gainLoss)+'</td>'+
      '<td class="mono" style="color:'+C(p.gainLossPct)+';font-weight:800">'+P(p.gainLossPct)+'</td></tr>';
  }).concat((function(){
    // Fila TOTAL — solo si hay posiciones y precios cargados
    if (!window._PRICES_LOADED || !APOS.length) return [];
    return ['<tr style="background:var(--s2);font-weight:700;border-top:2px solid var(--bd)">'+
      '<td colspan="3" style="color:var(--mu2)">TOTAL</td>'+
      '<td></td>'+
      '<td></td>'+
      '<td></td>'+
      '<td></td>'+
      '<td class="mono" style="font-weight:800;color:var(--acciones)">'+E(tv)+'</td>'+
      '<td class="mono" style="color:'+C(gl)+';font-weight:800">'+(gl>=0?'+':'')+E(Math.round(gl*100)/100)+'</td>'+
      '<td class="mono" style="color:'+C(glp)+';font-weight:800">'+P(glp)+'</td>'+
    '</tr>'];
  })()).join('');

  var closedMap={};
  AOPS.filter(function(o){return o.type==='compra'||o.type==='venta';}).forEach(function(o){
    if (!closedMap[o.ticker]) closedMap[o.ticker]={name:o.name,asset:o.asset,bought:0,sold:0,buyValEUR:0,sellValEUR:0};
    // Fix: usar importe con fx_aplicado si existe, si no convertir con FX histórico
    var _impEur = o.fx_aplicado ? o.importe : toEUR(o.importe||(o.qty*o.price), o.divisa, o.date);
    if (o.type==='compra'){closedMap[o.ticker].bought+=o.qty;closedMap[o.ticker].buyValEUR+=_impEur;}
    else{closedMap[o.ticker].sold+=o.qty;closedMap[o.ticker].sellValEUR+=_impEur;}
  });
  // Fix: solo mostrar como 'cerrada' si todos los títulos comprados han sido vendidos
  // (posición parcialmente vendida sigue abierta — ya aparece en APOS)
  var closedRows=Object.keys(closedMap).filter(function(tk){
    var d=closedMap[tk];
    var isOpen = APOS.some(function(p){ return p.ticker===tk; });
    return d.sold > 0 && !isOpen;  // cerrada = vendida Y no está en posiciones abiertas
  });
  function renderClosedTable(closedRows, closedMap) {
    var sc=_closedSort.col, sd=_closedSort.dir;
    var rows=closedRows.map(function(tk){ var d=closedMap[tk]; return {tk:tk,d:d,res:d.sellValEUR-d.buyValEUR}; });
    rows.sort(function(a,b){ return (b[sc]-a[sc])*sd; });
    document.getElementById('a-tb-closed').innerHTML=rows.map(function(r){
      var d=r.d, res=r.res;
      var _ctk = (!r.tk || /^[A-Z]{2}[A-Z0-9]{10}$/.test(r.tk)) ? '' : r.tk;
      return '<tr>'+
        '<td><span style="display:flex;align-items:center;gap:7px">'+
          (_ctk?'<span class="mono" style="font-size:11px;color:var(--mu2);font-weight:700;flex-shrink:0">'+_ctk+'</span>':'')+
          '<span style="font-weight:600">'+d.name+'</span></span></td>'
        +'<td>'+bdg(d.asset||'Acción','var(--mu)')+'</td>'+
        '<td class="mono mu">'+N(d.bought,2)+' u · '+E(d.buyValEUR)+'</td>'+
        '<td class="mono mu">'+N(d.sold,2)+' u · '+E(d.sellValEUR)+'</td>'+
        '<td class="mono" style="cursor:pointer" onclick="_closedSetSort(\'res\')" title="Ordenar por resultado">'+
        '<span style="color:'+C(res)+';font-weight:700">'+(res>=0?'+':'')+E(res)+'</span>'+
        (sc==='res'?'<span style="font-size:9px;margin-left:3px">'+(sd===-1?' ↓':' ↑')+'</span>':'<span style="font-size:9px;opacity:.35;margin-left:3px"> ⇅</span>')+
        '</td></tr>';
    }).join('');
  }
  window._closedSetSort = function(col) {
    if (_closedSort.col===col) _closedSort.dir*=-1;
    else { _closedSort.col=col; _closedSort.dir=-1; }
    renderClosedTable(closedRows, closedMap);
  };
  renderClosedTable(closedRows, closedMap);
  renderAccionesOps();

  if (window._PRICES_LOADED) {
  var best=APOS.length?APOS.reduce(function(a,b){return a.gainLossPct>b.gainLossPct?a:b;}):null;
  var worst=APOS.length?APOS.reduce(function(a,b){return a.gainLossPct<b.gainLossPct?a:b;}):null;
  document.getElementById('a-ka').innerHTML=kpi([
    {l:'📈 G/P latente (abiertas)', v:(gl>=0?'+':'')+E(gl), s:P(glp), c:C(gl)},
    {l:'💰 G/P realizada (FIFO·FX)', v:(totalReal>=0?'+':'')+E(Math.round(totalReal*100)/100), s:ventas.length+' ventas', c:C(totalReal)},
    {l:'💵 Dividendos cobrados (FX)', v:E(Math.round(totalDivid*100)/100), s:divids.length+' cobros', c:'var(--yel)'},
    {l:'🏁 TOTAL histórico acumulado', v:(glTotal>=0?'+':'')+E(Math.round(glTotal*100)/100), s:'latente+realizado+dividendos', c:C(glTotal)},
  ]);

  // Desglose histórico por ticker
  var allTickers=Object.keys(closedMap).concat(APOS.map(function(p){return p.ticker;}));
  allTickers=allTickers.filter(function(v,i,a){return a.indexOf(v)===i;});
  var ah='<div style="margin-bottom:12px;padding:12px;background:rgba(167,139,250,.05);border:1px solid rgba(167,139,250,.2);border-radius:10px">';
  ah+='<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mu);margin-bottom:10px">Desglose rendimiento total · FX real por fecha</div>';
  function buildAccDesglosePanel(allTickers, fifo, divids, APOS, AOPS) {
    var sc=_accionesSort.col, sd=_accionesSort.dir;
    function arrow(col){ return sc===col?'<span style="font-size:9px">'+(sd===-1?' ↓':' ↑')+'</span>':'<span style="color:var(--mu);opacity:.35;font-size:9px"> ⇅</span>'; }
    function hdr(col,label){ return '<span style="text-align:right;cursor:pointer;user-select:none" onclick="_accionesSetSort(\''+col+'\')">'+ label+arrow(col)+'</span>'; }
    var rows=[];
    allTickers.forEach(function(tk){
      var rz=fifo.byTicker[tk]?fifo.byTicker[tk].gainEur:0;
      var dv=divids.filter(function(o){return o.ticker===tk;}).reduce(function(s,o){var _di=o.importe||(o.qty*o.price);return s+toEUR(_di,o.divisa,o.date);},0);
      var posAb=APOS.find(function(p){return p.ticker===tk;}), lat=posAb?posAb.gainLoss:0;
      var tot=rz+dv+lat;
      if (Math.abs(rz)+Math.abs(dv)+Math.abs(lat)<0.001) return;
      var nm=AOPS.find(function(o){return o.ticker===tk;}); nm=nm?nm.name:tk;
      rows.push({tk:tk,nm:nm,rz:rz,dv:dv,lat:lat,tot:tot,posAb:posAb});
    });
    rows.sort(function(a,b){ return (b[sc]-a[sc])*sd; });
    var ah='';
    ah+='<div style="display:grid;grid-template-columns:1fr 110px 110px 110px 110px;gap:4px;padding:0 4px;font-size:10px;font-weight:700;color:var(--mu);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">'
       +'<span>Activo</span>'+hdr('rz','G/P realiz.')+hdr('dv','Dividendos')+hdr('lat','G/P latente')+hdr('tot','Total')
       +'</div>';
    rows.forEach(function(r){
      ah+='<div style="display:grid;grid-template-columns:1fr 110px 110px 110px 110px;gap:4px;padding:6px 4px;border-top:1px solid var(--bd);align-items:center">';
      ah+='<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+r.nm+'">';
      ah+='<span style="font-size:12px;font-weight:700;color:var(--text)">'+r.nm+'</span>'
        +'<span class="mono" style="font-size:10px;color:var(--acciones);margin-left:5px">'+r.tk+'</span>';
      ah+='</span>';
      ah+='<span class="mono" style="text-align:right;font-size:11px;color:'+C(r.rz)+'">'+(Math.abs(r.rz)>0.01?(r.rz>=0?'+':'')+E(r.rz):'—')+'</span>';
      ah+='<span class="mono" style="text-align:right;font-size:11px;color:var(--yel)">'+(r.dv>0.001?'+'+E(r.dv):'—')+'</span>';
      ah+='<span class="mono" style="text-align:right;font-size:11px;color:'+C(r.lat)+'">'+(r.posAb?(r.lat>=0?'+':'')+E(r.lat):'—')+'</span>';
      ah+='<span class="mono" style="text-align:right;font-size:12px;font-weight:700;color:'+C(r.tot)+'">'+(r.tot>=0?'+':'')+E(Math.round(r.tot*100)/100)+'</span>';
      ah+='</div>';
    });
    return ah;
  }
  window._accionesSetSort = function(col) {
    if (_accionesSort.col===col) _accionesSort.dir*=-1;
    else { _accionesSort.col=col; _accionesSort.dir=-1; }
    renderAcciones();
  };
  ah += buildAccDesglosePanel(allTickers, fifo, divids, APOS, AOPS);
  // I1 fix: envolver la fila TOTAL en el mismo grid que las filas de datos
  ah+='<div style="display:grid;grid-template-columns:1fr 110px 110px 110px 110px;gap:4px;padding:8px 4px;border-top:2px solid var(--bd);margin-top:4px">';
  ah+='<span class="mono" style="font-weight:800;font-size:12px">TOTAL</span>';
  ah+='<span class="mono" style="text-align:right;font-size:11px;color:'+C(totalReal)+';font-weight:700">'+(totalReal>=0?'+':'')+E(Math.round(totalReal*100)/100)+'</span>';
  ah+='<span class="mono" style="text-align:right;font-size:11px;color:var(--yel);font-weight:700">+'+E(Math.round(totalDivid*100)/100)+'</span>';
  ah+='<span class="mono" style="text-align:right;font-size:11px;color:'+C(gl)+';font-weight:700">'+(gl>=0?'+':'')+E(gl)+'</span>';
  ah+='<span class="mono" style="text-align:right;font-size:13px;font-weight:800;color:'+C(glTotal)+'">'+(glTotal>=0?'+':'')+E(Math.round(glTotal*100)/100)+'</span>';
  ah+='</div></div>';
  var oldA=document.getElementById('a-hist-panel'); if (oldA) oldA.remove();
  document.getElementById('a-ranking').insertAdjacentHTML('beforebegin','<div id="a-hist-panel">'+ah+'</div>');

  document.getElementById('a-ranking').innerHTML=APOS.slice().sort(function(a,b){return b.gainLossPct-a.gainLossPct;}).map(function(p,i){
    return '<div class="rrow"><div style="display:flex;align-items:center;gap:8px">'+
      '<span class="mu mono" style="font-size:11px;width:14px">'+(i+1)+'.</span>'+
      '<span style="font-weight:700;color:var(--text)">'+p.nombre+'</span>'+
      '<span class="mono" style="font-size:10px;color:var(--acciones);margin-left:4px">'+p.ticker+'</span></div>'+
      '<div style="display:flex;gap:12px;align-items:center">'+
      '<span class="mono mu" style="font-size:11px">'+E(p.gainLoss)+'</span>'+
      '<span class="mono" style="color:'+C(p.gainLossPct)+';font-weight:800;font-size:12px">'+P(p.gainLossPct)+'</span></div></div>';
  }).join('');

  document.getElementById('a-closed-analysis').innerHTML=closedRows.map(function(tk){
    var d=closedMap[tk], res=d.sellValEUR-d.buyValEUR;
    return '<div class="rrow"><div style="display:flex;align-items:center;gap:8px">'+
      '<span style="font-weight:700;color:var(--text)">'+d.name+'</span>'+
      '<span class="mono" style="font-size:10px;color:var(--mu2);margin-left:4px">'+tk+'</span></div>'+
      '<span class="mono" style="color:'+C(res)+';font-weight:800">'+(res>=0?'+':'')+E(res)+'</span></div>';
  }).join('');

  setTimeout(function(){
    document.getElementById('pie-lbl-a').innerHTML=APOS.map(function(p,i){
      var pct = N(p.currentValue/tv*100,1);
      var glp = p.gainLossPct;
      return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid var(--bd)" title="'+p.nombre+'">' +
        '<span style="width:8px;height:8px;border-radius:2px;flex-shrink:0;background:'+ACOLORS[i%ACOLORS.length]+'"></span>' +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;color:var(--text)">'+p.nombre+'</span>' +
        '<span class="mono" style="font-size:11px;color:var(--mu2);flex-shrink:0">'+pct+'%</span>' +
        '<span class="mono" style="font-size:11px;font-weight:700;flex-shrink:0;color:'+C(glp)+'">'+P(glp)+'</span>' +
        '<span class="mono" style="font-size:11px;font-weight:700;color:var(--text);flex-shrink:0;min-width:64px;text-align:right">'+E(p.currentValue)+'</span>' +
      '</div>';
    }).join('');
  },60);
  } // end _PRICES_LOADED (a-ka, análisis)

  var yrA = new Date().getFullYear().toString();
  var yrA1 = (parseInt(yrA)+1).toString();
  var divids25=divids.filter(function(o){return o.date.startsWith(yrA);});
  var divids26=divids.filter(function(o){return o.date.startsWith(yrA1);});
  var td25=divids25.reduce(function(s,o){var _i=o.importe||(o.qty*o.price);return s+toEUR(_i,o.divisa,o.date);},0);
  var td26=divids26.reduce(function(s,o){var _i=o.importe||(o.qty*o.price);return s+toEUR(_i,o.divisa,o.date);},0);
  var ventas25=ventas.filter(function(o){return o.date.startsWith(yrA);});
  var ventas26=ventas.filter(function(o){return o.date.startsWith(yrA1);});
  // Calcular G/P FIFO por año desde salesDetail (antes del bloque _PRICES_LOADED)
  var gainByYear={};
  (fifo.salesDetail||[]).forEach(function(s){ gainByYear[s.yr]=(gainByYear[s.yr]||0)+s.gain; });
  var gv25=gainByYear[yrA]||0, gv26=gainByYear[yrA1]||0;

  if (window._PRICES_LOADED) {
  document.getElementById('a-kfis').innerHTML=kpi([
    {l:'📊 Posiciones abiertas', v:E(tv), s:'G/P latente '+E(gl), c:'var(--acciones)'},
    {l:'💰 G/P ventas '+yrA+' (FIFO)', v:(gv25>=0?'+':'')+E(Math.round(gv25*100)/100),
      s:ventas25.length+' ventas · base: '+E(Math.round((Math.max(0,gv25)+Math.max(0,td25))*100)/100)+' · IRPF est. '+E(irpf(Math.max(0,gv25)+Math.max(0,td25))), c:C(gv25)},
    {l:'💵 Dividendos '+yrA+' (FX real)', v:E(Math.round(td25*100)/100), s:divids25.length+' cobros', c:'var(--yel)'},
    {l:'🔄 Ventas realizadas (total)', v:(totalReal>=0?'+':'')+E(Math.round(totalReal*100)/100), s:ventas.length+' ventas · FIFO·FX real', c:C(totalReal)},
  ]);
  document.getElementById('a-years').innerHTML=[{y:yrA,v:ventas25,d:td25,gv:gv25},{y:yrA1,v:ventas26,d:td26,gv:gv26}].map(function(row){
    var base=Math.max(0,row.gv)+Math.max(0,row.d); // base imponible real: ventas + dividendos
    var irpfEst=irpf(base);
    var gvColor=C(row.gv);
    return '<div class="rrow" style="flex-direction:column;align-items:flex-start;gap:4px;margin-bottom:7px">'+
      '<div style="display:flex;justify-content:space-between;width:100%"><span style="font-weight:800;font-size:14px">'+row.y+'</span>'+
      '<span class="mu" style="font-size:11px">'+row.v.length+' ventas</span></div>'+
      '<div style="display:flex;flex-direction:column;gap:2px;font-size:11px">'+
        '<div style="display:flex;justify-content:space-between">'+
          '<span style="color:var(--mu2)">G/P ventas (FIFO·FX)</span>'+
          '<strong style="color:'+gvColor+'">'+(row.gv>=0?'+':'')+E(Math.round(row.gv*100)/100)+'</strong></div>'+
        '<div style="display:flex;justify-content:space-between">'+
          '<span style="color:var(--mu2)">Dividendos cobrados</span>'+
          '<strong style="color:var(--yel)">'+E(Math.round(row.d*100)/100)+'</strong></div>'+
        '<div style="display:flex;justify-content:space-between;padding-top:3px;border-top:1px solid var(--bd);margin-top:2px">'+
          '<span style="color:var(--mu2)">Base imponible</span>'+
          '<strong style="color:var(--text)">'+E(Math.round(base*100)/100)+'</strong></div>'+
        '<div style="display:flex;justify-content:space-between">'+
          '<span style="color:var(--red)">IRPF est. (ventas+divid.)</span>'+
          '<strong style="color:var(--red)">-'+E(irpfEst)+'</strong></div>'+
        (row.gv<0?'<div style="font-size:10px;color:var(--ac)">Minusvalía compensable hasta '+(parseInt(row.y)+4)+'</div>':'')+
      '</div></div>';
  }).join('');
  document.getElementById('a-divid-years').innerHTML=Object.keys(dividByTicker).map(function(tk){
    var d=dividByTicker[tk];
    return '<div class="rrow"><div style="display:flex;align-items:center;gap:8px">'+
      '<span style="font-weight:700;color:var(--text)">'+d.name+'</span>'+
      '<span class="mono" style="font-size:10px;color:var(--pur);margin-left:4px">'+tk+'</span>'+
      '<span class="mu" style="font-size:11px;margin-left:4px">'+d.count+' cobro'+(d.count>1?'s':'')+'</span></div>'+
      '<span class="mono" style="color:var(--yel);font-weight:700">'+E(Math.round(d.totalEUR*100)/100)+'</span></div>';
  }).join('');
  } // end _PRICES_LOADED (a-kfis, fiscal)
  // Construir mapa de G/P FIFO por referencia de venta desde salesDetail
  var saleGainMap={};
  (fifo.salesDetail||[]).forEach(function(s){
    // Mapear por ticker+fecha+qty (ref única aproximada)
    var key=s.ticker+'|'+s.date+'|'+s.qty;
    saleGainMap[key]={gain:s.gain,costBasis:s.costBasis,proceeds:s.proceeds};
  });
  document.getElementById('a-tb-ventas').innerHTML=ventas.slice().reverse().map(function(o){
    var _imp = o.importe||(o.qty*o.price);
    var _impEur = o.fx_aplicado ? o.importe : toEUR(_imp, o.divisa, o.date);
    var _eurCell = o.divisa!=='EUR'
      ? '<td class="mono" style="font-size:10px;color:var(--mu2)" title="Equiv. EUR al cambio de la fecha">≈'+E(Math.round(_impEur*100)/100)+'</td>'
      : '<td></td>';
    var _key=o.ticker+'|'+o.date+'|'+o.qty;
    var _sg=saleGainMap[_key];
    var _gpCell = _sg
      ? '<td class="mono" style="color:'+C(_sg.gain)+';font-weight:700">'+((_sg.gain>=0?'+':'')+E(Math.round(_sg.gain*100)/100))+'</td>'
        +'<td class="mono" style="font-size:10px;color:var(--mu2)" title="Coste base FIFO">╥ '+E(Math.round(_sg.costBasis*100)/100)+'</td>'
      : '<td></td><td></td>';
    return '<tr><td class="mu" style="white-space:nowrap">'+fmtDMY(o.date)+'</td>'+
      '<td><span style="font-weight:700;color:var(--text)">'+o.name+'</span>'+
        '<span class="mono" style="font-size:10px;color:var(--acciones);margin-left:5px">'+o.ticker+'</span></td>'+
      '<td class="mono">'+N(o.qty,2)+'</td><td class="mono">'+N(o.price,4)+'</td>'+
      '<td class="mu">'+o.divisa+'</td>'+
      '<td class="mono" style="color:var(--ac);font-weight:700">'+N(o.qty*o.price,2)+' '+o.divisa+'</td>'+
      _eurCell+_gpCell+'</tr>';
  }).join('');
  document.getElementById('a-tb-divid').innerHTML=divids.slice().reverse().map(function(o){
    var yr=o.date?o.date.substring(0,4):'—';
    var _divImp = o.importe||(o.qty*o.price);
    var _divEur = o.fx_aplicado ? o.importe : toEUR(_divImp, o.divisa, o.date);
    var _eurTd = o.divisa!=='EUR'
      ? '<td class="mono" style="color:var(--yel);font-size:10px" title="Equiv. EUR">≈'+E(Math.round(_divEur*100)/100)+'</td>'
      : '<td></td>';
    return '<tr><td class="mu" style="white-space:nowrap">'+fmtDMY(o.date)+'</td>'+
      '<td class="mono" style="font-weight:700;color:var(--mu2)">'+yr+'</td>'+
      '<td><span style="font-weight:700;color:var(--text)">'+o.name+'</span>'+
        '<span class="mono" style="font-size:10px;color:var(--pur);margin-left:5px">'+o.ticker+'</span></td>'+
      '<td class="mono">'+N(o.qty,0)+'</td><td class="mono">'+N(o.price,7)+'</td>'+
      '<td class="mu">'+o.divisa+'</td>'+
      '<td class="mono" style="color:var(--yel);font-weight:700">'+N(_divImp,4)+' '+o.divisa+'</td>'+
      _eurTd+'</tr>';
  }).join('');
  renderTickerConfig();
}

var _fOpsSort = {col: 'fecha', dir: -1}; // fecha | nombre | tipo | total
var _aOpsSort = {col: 'date', dir: -1}; // date | ticker | type | total
function renderAccionesOps() {
  var filtered=opsFilterA==='all'?AOPS:AOPS.filter(function(o){return o.type===opsFilterA;});
  var sc=_aOpsSort.col, sd=_aOpsSort.dir;
  filtered=filtered.slice().sort(function(a,b){
    if(sc==='date')   return sd*(a.date<b.date?-1:a.date>b.date?1:0);
    if(sc==='ticker') return sd*(a.ticker<b.ticker?-1:a.ticker>b.ticker?1:0);
    if(sc==='type')   return sd*(a.type<b.type?-1:a.type>b.type?1:0);
    if(sc==='total')  return sd*((a.importe||(a.qty*a.price))-(b.importe||(b.qty*b.price)));  // sort by EUR amount
    return 0;
  });
  document.getElementById('a-b-ops').innerHTML=bdg(filtered.length+'/'+AOPS.length+' movimientos','var(--yel)');
  document.getElementById('a-tb-ops').innerHTML=filtered.map(function(op){
    var tc2=op.type==='compra'?'var(--acciones)':op.type==='dividendo'?'var(--yel)':'var(--red)';
    var fCol=op.type==='compra'?'var(--red)':op.type==='dividendo'?'var(--yel)':'var(--acciones)';
    var fSign=op.type==='compra'?'- ':op.type==='dividendo'?'+ div ':' + ';
    // Badge FX pendiente — importe EUR sin verificar con broker
    var fxBadge = op.fx_pendiente
      ? '<span title="Importe EUR estimado — verifica con el broker e introduce el exacto" '
        + 'onclick="_corregirFxOp(AOPS_RAW.find(function(o){return o.ref===\'' + op.ref + '\';})||{ref:\'' + op.ref + '\',ticker:\'' + op.ticker + '\',isin:\'' + op.isin + '\',divisa:\'' + op.divisa + '\',fecha:\'' + op.date + '\',titulos:' + op.qty + ',precio:' + op.price + ',importe:' + op.importe + ',tipo:\'' + op.type + '\'})" '
        + 'style="cursor:pointer;background:rgba(245,200,66,.15);border:1px solid rgba(245,200,66,.5);'
        + 'color:var(--yel);border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;'
        + 'letter-spacing:.04em;margin-left:4px;white-space:nowrap">⚠ FX?</span>'
      : '';
    return '<tr' + (op.fx_pendiente ? ' style="background:rgba(245,200,66,.04)"' : '') + '>'
      + '<td>'+bdg(op.type,tc2)+'</td>'+
      '<td class="mono" style="color:var(--acciones);font-weight:700">'+op.ticker+'</td>'+
      '<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+op.name+'</td>'+
      '<td>'+bdg(op.asset||'Acción',op.asset==='ETF'?'#0af':'var(--pur)')+'</td>'+
      '<td class="mu" style="white-space:nowrap">'+fmtDMY(op.date)+'</td>'+
      '<td class="mono">'+N(op.qty,op.qty<10?4:0)+'</td>'+
      '<td class="mono">'+N(op.price,4)+'</td><td class="mu">'+op.divisa+'</td>'+
      (function(){
        // M3 fix: mostrar equivalente EUR cuando la divisa no es EUR
        if (op.divisa === 'EUR' || !op.divisa) return '<td class="mono mu" style="color:var(--mu);font-size:10px">—</td>';
        var impEur = toEUR(op.qty * op.price, op.divisa, op.date);
        return '<td class="mono mu" style="font-size:10px;color:var(--mu2)" title="Equiv. EUR estimado al cambio de la fecha">'+E(Math.round(impEur*100)/100)+'</td>';
      })()+
      '<td class="mono" style="color:'+fCol+';font-weight:700">'+fSign+N(op.qty*op.price,2)+' '+op.divisa+fxBadge+'</td>'+
      '<td style="white-space:nowrap">'+(op.ref?'<button onclick="editAccionOp(\''+op.ref+'\')" style="background:none;border:none;color:var(--mu2);cursor:pointer;font-size:14px;padding:2px 5px" title="Editar">✎</button><button onclick="deleteOp(\'acciones\',\''+op.ref+'\')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:13px;padding:2px 5px" title="Eliminar">✕</button>':'')+'</td></tr>';
  }).join('');
  // Update sort arrows
  var tbl=document.querySelector('#a-tb-ops');
  if(tbl){ var thead=tbl.closest('table').querySelector('thead');
    if(thead) thead.querySelectorAll('th').forEach(function(th){
      th.classList.remove('sort-asc','sort-desc');
      var colMap={'0':'type','1':'ticker','4':'date','9':'total'};
      if(colMap[th.dataset.col]===sc) th.classList.add(sd===-1?'sort-desc':'sort-asc');
    });
  }
}

// ════════════════════════════════════════════════════════════════
//  HEADER
// ════════════════════════════════════════════════════════════════
function updateHeaderVal(fifoF) {
  // Solo actualizar el header cuando hay precios frescos (refresh real o auto-refresh)
  if (!window._PRICES_LOADED) return;
  var tvF=FPOS.reduce(function(s,p){return s+p.currentValue;},0);
  var tvA=APOS.reduce(function(s,p){return s+p.currentValue;},0);
  window._PORT_TVF=tvF; window._PORT_TVA=tvA;
  var tv=tvF+tvA;
  var glF=FPOS.reduce(function(s,p){return s+p.gainLoss;},0);  // vs coste_adq
  var glA=APOS.reduce(function(s,p){return s+p.gainLoss;},0);
  var realF=REEMBOLSOS_BROKER.reduce(function(s,v){return s+v.gain;},0);
  var fifoA=calcRealizedAcc(), realA=fifoA.totalEur;
  var divA=AOPS.filter(function(o){return o.type==='dividendo';}).reduce(function(s,o){var imp=o.importe||(o.qty*o.price);return s+toEUR(imp,o.divisa,o.date);},0);
  var glTotal=Math.round((Math.round(glF*100)/100+Math.round(glA*100)/100+Math.round(realF*100)/100+Math.round(realA*100)/100+Math.round(divA*100)/100)*100)/100;
  var costF=FPOS.reduce(function(s,p){return s+p.cost;},0);  // coste_adq
  var costA=APOS.reduce(function(s,p){return s+p.cost;},0);
  var costTotal=costF+costA;
  var pctTotal=costTotal>0?(glTotal/costTotal*100):0;
  var pctF=costF>0?(Math.round(glF*100)/100)/costF*100:0;
  var pctA=costA>0?(Math.round(glA*100)/100)/costA*100:0;
  window._PORT_GL=glTotal; window._PORT_PCT=pctTotal;
  document.getElementById('tv').textContent=E(tv);
  var ts=document.getElementById('ts');
  var now=new Date(); var hhmm=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
  ts.innerHTML='<span style="color:var(--mu2)">actualizado '+hhmm+'</span>';
  var glColor = glTotal>=0?'var(--ac)':'var(--red)';

  // G/P desde el origen: gain real de fondos cerrados (misma lógica que renderResumen)
  var _hdrCurrentISINs = {};
  FPOS_RAW.forEach(function(p){ _hdrCurrentISINs[p.isin] = true; });
  var _hdrClosedGains = {};
  FOPS_RAW.forEach(function(o) {
    var isin = o.isin || '';
    if (_hdrCurrentISINs[isin]) return;
    if (!_hdrClosedGains[isin]) _hdrClosedGains[isin] = { suscrito: 0, t_entrada: 0, salida: 0 };
    var imp = parseFloat(o.titulos||0) * parseFloat(o.precio||0);
    if (o.tipo === 'suscripcion')                               _hdrClosedGains[isin].suscrito  += imp;
    if (o.tipo === 'traspaso_entrada')                          _hdrClosedGains[isin].t_entrada += imp;
    if (o.tipo === 'traspaso_salida' || o.tipo === 'reembolso') _hdrClosedGains[isin].salida    += imp;
  });
  var _hdrPmRoboadvisor = 0;
  var _hdrClosedSusc    = 0;
  Object.keys(_hdrClosedGains).forEach(function(isin) {
    var g = _hdrClosedGains[isin];
    _hdrPmRoboadvisor += g.salida - g.suscrito - g.t_entrada;
    _hdrClosedSusc    += g.suscrito;
  });
  _hdrPmRoboadvisor = Math.round(_hdrPmRoboadvisor * 100) / 100;

  // Denominador: capital real histórico completo
  var _hdrInvReal = FPOS.reduce(function(s,p){ return s+p.invertidoReal; }, 0) + costA;
  var _hdrInvRealCompleto = Math.round((_hdrInvReal + _hdrClosedSusc) * 100) / 100;
  var glOrigen   = Math.round((glTotal + Math.max(0, _hdrPmRoboadvisor)) * 100) / 100;
  var pctOrigen  = _hdrInvRealCompleto > 0 ? (glOrigen / _hdrInvRealCompleto * 100) : 0;
  var glOrigenColor = glOrigen >= 0 ? 'var(--ac)' : 'var(--red)';

  var glLat = Math.round((glF + glA) * 100) / 100;  // G/P latente pura
  var pctLat = costTotal > 0 ? (glLat / costTotal * 100) : 0;
  var glLatColor = glLat >= 0 ? 'var(--ac)' : 'var(--red)';

  document.getElementById('bk-summary').innerHTML=
    '<div class="bks">'+
      '<span class="bks-lbl">Fondos</span>'+
      '<span class="bks-val" style="color:var(--fondos)">'+E(tvF)+'</span>'+
      '<span class="bks-sub" style="color:'+(glF>=0?'var(--fondos)':'var(--red)')+'">'+
        (glF>=0?'+':'')+E(Math.round(glF*100)/100)+
        '<span style="opacity:.55;margin:0 3px">·</span>'+
        '<span style="font-size:10px;opacity:.8">'+(pctF>=0?'+':'')+pctF.toFixed(1)+'%</span>'+
      '</span>'+
    '</div>'+
    '<div class="bks">'+
      '<span class="bks-lbl">Acciones</span>'+
      '<span class="bks-val" style="color:var(--acciones)">'+E(tvA)+'</span>'+
      '<span class="bks-sub" style="color:'+(glA>=0?'var(--acciones)':'var(--red)')+'">'+
        (glA>=0?'+':'')+E(Math.round(glA*100)/100)+
        '<span style="opacity:.55;margin:0 3px">·</span>'+
        '<span style="font-size:10px;opacity:.8">'+(pctA>=0?'+':'')+pctA.toFixed(1)+'%</span>'+
      '</span>'+
    '</div>'+
    '<div class="bks" style="border-left:1px solid var(--bd)" title="G/P no realizada sobre posiciones abiertas">'+
      '<span class="bks-lbl">G/P Latente</span>'+
      '<span class="bks-val" style="color:'+glLatColor+'">'+(glLat>=0?'+':'')+E(glLat)+'</span>'+
      '<span class="bks-sub" style="color:'+glLatColor+'">'+(pctLat>=0?'+':'')+pctLat.toFixed(1)+'%</span>'+
    '</div>'+
    '<div class="bks" style="border-left:1px solid var(--bd)" title="Latente + realizados + dividendos">'+
      '<span class="bks-lbl">G/P Hist\u00f3rica</span>'+
      '<span class="bks-val" style="color:'+glColor+'">'+(glTotal>=0?'+':'')+E(Math.round(glTotal*100)/100)+'</span>'+
      '<span class="bks-sub" style="color:'+glColor+'">'+(pctTotal>=0?'+':'')+pctTotal.toFixed(1)+'%</span>'+
    '</div>'+
    '<div class="bks" style="border-left:1px solid var(--bd)" title="'+
    (_hdrPmRoboadvisor > 1 ? 'Incluye '+E(Math.round(_hdrPmRoboadvisor*100)/100)+' de fondos anteriores cerrados' : 'Rentabilidad total desde el origen')+'">'+
      '<span class="bks-lbl">Desde el origen \u24d8</span>'+
      '<span class="bks-val" style="color:'+glOrigenColor+'">'+(glOrigen>=0?'+':'')+E(glOrigen)+'</span>'+
      '<span class="bks-sub" style="color:'+glOrigenColor+'">'+(pctOrigen>=0?'+':'')+pctOrigen.toFixed(1)+'%</span>'+
    '</div>';
}

// ════════════════════════════════════════════════════════════════
//  RESIZE
// ════════════════════════════════════════════════════════════════
window.addEventListener('resize', function(){
  var on=document.querySelector('.view.on'); if (!on) return;
  var id=on.id;
  if (id==='view-fondos-dashboard') { drawBench('c-bench'); drawPie('c-pie-f',FPOS.map(function(p){return p.ticker;}),FPOS.map(function(p){return p.currentValue;}),COLORS,FPOS.map(function(p){return {nombre:p.nombre,val:p.currentValue,gl:p.gainLoss,glp:p.gainLossPct};})); }
  if (id==='view-fondos-analisis')  drawBars('c-gl-f',FPOS.map(function(p){return p.ticker;}),FPOS.map(function(p){return p.gainLoss;}),COLORS,FPOS.map(function(p){return p.nombre;}));
  if (id==='view-acciones-dashboard'){drawBarsW('c-gl-a-dash',APOS.map(function(p){return p.ticker;}),APOS.map(function(p){return p.gainLoss;}),ACOLORS,0.62,APOS.map(function(p){return p.nombre||p.ticker;}));drawPie('c-pie-a',APOS.map(function(p){return p.ticker;}),APOS.map(function(p){return p.currentValue;}),ACOLORS,APOS.map(function(p){return {nombre:p.nombre||p.ticker,val:p.currentValue,gl:p.gainLoss,glp:p.gainLossPct};}));}
  if (id==='view-acciones-analisis'){drawBars('c-gl-a',APOS.map(function(p){return p.ticker;}),APOS.map(function(p){return p.gainLoss;}),ACOLORS,APOS.map(function(p){return p.nombre||p.ticker;}));drawDividBars();}
});

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
//  REBALANCEO
// ════════════════════════════════════════════════════════════════

var REB = { universe: [], dirty: false };
var _rebInitialized = false;

function rebInit(data) {
  // Soportar tanto formato antiguo (array directo) como nuevo ({universe:[...]})
  var saved = [];
  var reb = data.rebalanceo;
  if (reb) {
    if (reb.universe && reb.universe.length > 0) saved = reb.universe;  // formato {universe:[...]}
    else if (Array.isArray(reb) && reb.length > 0) saved = reb;         // formato array directo
  }
  if (saved.length > 0) {
    REB.universe = saved.map(function(u) {
      return { isin: u.isin, nombre: u.nombre, peso_obj: parseFloat(u.peso_obj) || 0 };
    });
  } else {
    // Sin universo guardado: inicializar con posiciones actuales, pesos a 0
    var MONETARIO = [];  // ISINs a excluir del rebalanceo (ej: monetario)
    REB.universe = (data.fondos.posiciones || [])
      .filter(function(p) { return MONETARIO.indexOf(p.isin) === -1; })
      .map(function(p) { return { isin: p.isin, nombre: p.nombre, peso_obj: 0 }; });
  }
  REB.dirty = false;
}

function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

function rebRenderConfig() {
  var body = document.getElementById('reb-config-body');
  if (!body) return;
  // Ordenar por peso objetivo descendente antes de renderizar
  REB.universe.sort(function(a,b){ return (b.peso_obj||0) - (a.peso_obj||0); });
  var rows = REB.universe.map(function(u, i) {
    var inPortfolio = (FPOS_RAW||[]).some(function(p){ return p.isin === u.isin; });
    return '<div style="display:grid;grid-template-columns:1fr 180px 36px;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--bd)">' +
      '<div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:13px;font-weight:700;color:var(--text)">' + escHtml(u.nombre) + '</span>' +
          '<span style="font-family:\'JetBrains Mono\',monospace;font-size:10px;color:var(--fondos)">' + escHtml(u.isin) + '</span>' +
          (!inPortfolio ? '<span style="font-size:10px;color:var(--yel);background:rgba(245,200,66,.1);border:1px solid rgba(245,200,66,.3);border-radius:4px;padding:1px 5px">futuro</span>' : '') +
        '</div>' +
        '<input class="inp" style="margin-top:4px;font-size:12px;color:var(--mu2)" value="' + escHtml(u.nombre) + '" ' +
          'onchange="rebSetNombre(' + i + ',this.value)" placeholder="Nombre del fondo" title="Editar nombre">' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<input type="number" class="inp" style="font-family:\'JetBrains Mono\',monospace;font-weight:700;font-size:15px;text-align:right" ' +
          'value="' + u.peso_obj + '" min="0" max="100" step="0.1" ' +
          'oninput="rebSetPeso(' + i + ',this.value)">' +
        '<span style="font-size:14px;color:var(--mu2);white-space:nowrap">%</span>' +
      '</div>' +
      '<button onclick="rebRemoveFondo(' + i + ')" title="Eliminar" style="background:rgba(255,61,90,.1);border:1px solid rgba(255,61,90,.25);color:var(--red);border-radius:6px;width:32px;height:32px;font-size:18px;display:flex;align-items:center;justify-content:center;padding:0">×</button>' +
    '</div>';
  }).join('');
  body.innerHTML = '<div style="padding:0 0 4px">' +
    (rows || '<div style="padding:16px 0;color:var(--mu);font-size:13px">No hay fondos — añade el primero abajo</div>') +
    '</div>';
  rebUpdateSumCheck();
}

function rebAutoFill(isin) {
  isin = (isin||'').trim().toUpperCase();
  var el = document.getElementById('reb-new-nombre');
  if (el && KNOWN_FONDOS[isin] && KNOWN_FONDOS[isin].nombre) el.value = KNOWN_FONDOS[isin].nombre;
}

function rebSetPeso(i, val) {
  REB.universe[i].peso_obj = parseFloat(val) || 0;
  REB.dirty = true;
  rebUpdateSumCheck();
  rebCalc();
}

function rebSetNombre(i, val) {
  REB.universe[i].nombre = val.trim() || REB.universe[i].isin;
  REB.dirty = true;
}

function rebUpdateSumCheck() {
  var sum = REB.universe.reduce(function(s,u){ return s + (parseFloat(u.peso_obj)||0); }, 0);
  var el  = document.getElementById('reb-sum-check');
  if (!el) return;
  var ok = Math.abs(sum - 100) < 0.05;
  el.textContent = 'Suma: ' + sum.toFixed(1) + '%' + (ok ? '  ✓' : '  ← debe ser 100%');
  el.style.color = ok ? 'var(--ac)' : 'var(--yel)';
  var btn = document.getElementById('reb-save-btn');
  if (btn) btn.style.opacity = ok ? '1' : '0.5';
}

function rebAddFondo() {
  var isinEl   = document.getElementById('reb-new-isin');
  var nombreEl = document.getElementById('reb-new-nombre');
  if (!isinEl) return;
  var isin   = isinEl.value.trim().toUpperCase();
  var nombre = nombreEl ? nombreEl.value.trim() : '';
  if (!isin) { alert('Introduce un ISIN'); return; }
  if (!nombre && KNOWN_FONDOS[isin]) nombre = KNOWN_FONDOS[isin].nombre;
  if (!nombre) nombre = isin;
  if (REB.universe.some(function(u){ return u.isin === isin; })) { alert('Este fondo ya está en el universo'); return; }
  REB.universe.push({ isin: isin, nombre: nombre, peso_obj: 0 });
  REB.dirty = true;
  rebRenderConfig();
  rebCalc();
}

function rebRemoveFondo(i) {
  if (!confirm('¿Eliminar "' + REB.universe[i].nombre + '" del universo?')) return;
  REB.universe.splice(i, 1);
  REB.dirty = true;
  rebRenderConfig();
  rebCalc();
}

function rebSavePesos() {
  var sum = REB.universe.reduce(function(s,u){ return s+(parseFloat(u.peso_obj)||0); }, 0);
  if (Math.abs(sum - 100) > 0.05) { alert('Los pesos deben sumar 100%'); return; }
  var msg = document.getElementById('reb-save-msg');
  var btn = document.getElementById('reb-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  fetch('guardar.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: AUTH_HASH_CLIENT, action: 'save_rebalanceo',
      universe: REB.universe.map(function(u){ return { isin: u.isin, nombre: u.nombre, peso_obj: u.peso_obj }; }) })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar pesos'; }
    if (d.ok) {
      if (msg) { msg.style.display='inline'; setTimeout(function(){ msg.style.display='none'; }, 3000); }
      REB.dirty = false;
    } else { alert('Error: ' + (d.msg||'desconocido')); }
  })
  .catch(function(e){
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar pesos'; }
    alert('Error de red: ' + e.message);
  });
}

function rebCalc() {
  var importeEl = document.getElementById('reb-importe');
  var importe   = importeEl ? (parseFloat(importeEl.value) || 0) : 0;
  var saldos = {};
  (FPOS_RAW || []).forEach(function(p) { saldos[p.isin] = p.valor_mercado || 0; });
  var totalActual = REB.universe.reduce(function(s,u){ return s + (saldos[u.isin]||0); }, 0);
  var totalFuturo = totalActual + importe;
  var tcEl = document.getElementById('reb-total-cartera');
  var tfEl = document.getElementById('reb-total-futuro');
  if (tcEl) tcEl.textContent = E(totalActual);
  if (tfEl) tfEl.textContent = importe > 0 ? E(totalFuturo) : '—';
  var tbody = document.getElementById('reb-tbody');
  var tfoot = document.getElementById('reb-tfoot');
  var aviso = document.getElementById('reb-aviso');
  if (!tbody) return;
  if (REB.universe.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--mu);padding:24px">Configura el universo de rebalanceo arriba</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    return;
  }
  var items = REB.universe.map(function(u) {
    var pesoObj  = (u.peso_obj || 0) / 100;
    var saldo    = saldos[u.isin] || 0;
    var pesoReal = totalActual > 0 ? saldo / totalActual : 0;
    return { isin: u.isin, nombre: u.nombre, pesoObj: pesoObj, saldo: saldo, pesoReal: pesoReal,
             desv: pesoReal - pesoObj, aport: 0 };
  });
  // Iterative redistribution
  // Fondos sobreponderados se excluyen por ISIN (no por aport, porque aport=0 pasaría el filtro)
  var avisos  = [];
  var excluidos = {};  // set de ISINs sobreponderados excluidos definitivamente
  var activos = items.slice();
  for (var iter = 0; iter < 10; iter++) {
    var sumPeso      = activos.reduce(function(s,it){ return s + it.pesoObj; }, 0);
    var totalActivos = activos.reduce(function(s,it){ return s + it.saldo; }, 0);
    if (sumPeso <= 0) break;
    activos.forEach(function(it) {
      it.aport = (it.pesoObj / sumPeso) * (totalActivos + importe) - it.saldo;
    });
    var negativos = activos.filter(function(it){ return it.aport < -0.005; });
    if (negativos.length === 0) break;
    negativos.forEach(function(it) {
      excluidos[it.isin] = true;
      var ya = avisos.some(function(a){ return a.indexOf(it.nombre) >= 0; });
      if (!ya) avisos.push('"' + it.nombre + '" está sobreponderado — no se asigna aportación');
    });
    // Filtrar por ISIN excluido (no por aport — aport podría ser 0 y pasar el filtro erróneamente)
    activos = activos.filter(function(it){ return !excluidos[it.isin]; });
    if (activos.length === 0) break;
  }
  var activosByISIN = {};
  activos.forEach(function(it){ activosByISIN[it.isin] = it; });
  items.forEach(function(it){ it.aport = activosByISIN[it.isin] ? Math.max(0, activosByISIN[it.isin].aport) : 0; });
  // Rounding adjustment
  if (importe > 0 && activos.length > 0) {
    var sumA = items.reduce(function(s,it){ return s + it.aport; }, 0);
    var diff = importe - sumA;
    if (Math.abs(diff) > 0.005) {
      var maxIt = activos.reduce(function(a,b){ return a.aport > b.aport ? a : b; });
      var ref   = items.filter(function(it){ return it.isin === maxIt.isin; })[0];
      if (ref) ref.aport = Math.max(0, ref.aport + diff);
    }
  }
  // Render
  var sumPesoReal = 0, sumAportFinal = 0;
  var rows = items.map(function(it) {
    var aport = Math.round(it.aport * 100) / 100;
    sumPesoReal  += it.pesoReal;
    sumAportFinal += aport;
    var inP = it.saldo > 0;
    var dc  = !inP ? 'var(--mu)' : Math.abs(it.desv)<0.005 ? 'var(--mu2)' : it.desv>0 ? 'var(--red)' : 'var(--ac)';
    var ap  = importe > 0 && aport > 0 ? (aport/importe*100).toFixed(1)+'%' : '—';
    return '<tr>' +
      '<td title="' + escHtml(it.isin) + '"><div style="font-size:12px;font-weight:700;color:var(--text)">' + escHtml(it.nombre) +
        (!inP ? ' <span style="color:var(--yel);font-size:10px;font-weight:700">· sin posición</span>' : '') + '</div>' +
        '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;color:var(--fondos)">' + escHtml(it.isin) + '</div></td>' +
      '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:700">' + (it.pesoObj*100).toFixed(1) + '%</td>' +
      '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace">' + (inP ? E(it.saldo) : '<span style="color:var(--mu)">—</span>') + '</td>' +
      '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace">' + (inP ? (it.pesoReal*100).toFixed(1)+'%' : '<span style="color:var(--mu)">—</span>') + '</td>' +
      '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:700;color:' + dc + '">' +
        (inP ? (it.desv>=0?'+':'')+(it.desv*100).toFixed(1)+'%' : '<span style="color:var(--mu)">—</span>') + '</td>' +
      '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:800;font-size:14px;color:' + (aport>0?'var(--ac)':'var(--mu)') + '">' +
        (importe > 0 ? E(aport) : '—') + '</td>' +
      '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;color:var(--mu2)">' + ap + '</td>' +
    '</tr>';
  }).join('');
  tbody.innerHTML = rows;
  tfoot.innerHTML = '<tr style="border-top:2px solid var(--bd)">' +
    '<td style="font-weight:700;font-size:11px;color:var(--mu2);text-transform:uppercase;letter-spacing:.06em">TOTAL</td>' +
    '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:700">100%</td>' +
    '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:700">' + E(totalActual) + '</td>' +
    '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:700">' + (totalActual>0?(sumPesoReal*100).toFixed(1)+'%':'—') + '</td>' +
    '<td></td>' +
    '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:800;font-size:15px;color:var(--ac)">' + (importe>0?E(Math.round(sumAportFinal*100)/100):'—') + '</td>' +
    '<td style="text-align:right;font-family:\'JetBrains Mono\',monospace;font-weight:700;color:var(--mu2)">' + (importe>0?'100%':'—') + '</td>' +
  '</tr>';
  if (aviso) {
    if (avisos.length > 0) { aviso.style.display='block'; aviso.innerHTML='⚠ ' + avisos.join('<br>'); }
    else aviso.style.display = 'none';
  }
}

function rebOnEnter() {
  if (!_rebInitialized) { _rebInitialized = true; rebRenderConfig(); }
  rebCalc();
}

function init(data) {
  // Leer hash de credenciales desde data.json (tiene prioridad sobre el hardcodeado)
  if (data.meta && data.meta.auth_hash) AUTH_HASH_CLIENT = data.meta.auth_hash;
  FX_TABLE  = data.fx || {};
  initMaps(data);
  rebInit(data);
  window._FIRE_PARAMS = (data.fire && data.fire.params) ? data.fire.params : null;
  FPOS_RAW  = data.fondos.posiciones   || [];
  FOPS_RAW  = data.fondos.operaciones  || [];
  APOS_RAW  = data.acciones.posiciones || [];
  AOPS_RAW  = data.acciones.operaciones|| [];
  BENCH             = data.fondos.benchmark        || [];
  // Cargar historial de precios (fondos, acciones, índices benchmark)
  PRICE_HISTORY = data.price_history || {};
  // Cargar datos X-Ray si existen
  if (data.xray) window._xrayData = data.xray;

  // Cargar configuración de benchmark guardada
  if (data.bench_config) {
    Object.keys(data.bench_config).forEach(function(sym) {
      if (BENCH_INDICES[sym]) BENCH_INDICES[sym].enabled = data.bench_config[sym];
    });
  }
  REEMBOLSOS_BROKER = data.fondos.reembolsos_broker|| [];
  window._FONDOS_IR_TOTAL = data.fondos.invertido_real_total || 0;
  window._ACCIONES_REALIZED = data.acciones.total_realized || 0;

  // Título dinámico desde fecha NAV más reciente
  (function() {
    var ld = null;
    (data.fondos.posiciones || []).forEach(function(p) {
      if (p.fecha_precio) {
        var pts = p.fecha_precio.split('/');
        if (pts.length === 3) {
          var iso = pts[2]+'-'+pts[1]+'-'+pts[0];
          if (!ld || iso > ld) ld = iso;
        }
      }
    });
    if (!ld && data.meta && data.meta.fecha) ld = data.meta.fecha;
    if (ld) { var p=ld.split('-'); document.title='Portafolio · '+(p.length===3?p[2]+'/'+p[1]+'/'+p[0]:ld); }
    else { document.title = 'tuinvestorPRO'; }
  })();

  // Limpiar header: valores se rellenan solo tras refresh real de precios
  document.getElementById('tv').textContent = '\u2014';
  document.getElementById('ts').textContent = '';
  document.getElementById('bk-summary').innerHTML = '';
  processFondos();
  processAcciones();
  renderFondos();
  renderAcciones();

  // Render inicial: Resumen global es la vista por defecto en V1
  setTimeout(function(){
    renderResumen();
  }, 80);

  // Auto-búsqueda de tickers faltantes antes del refresh
  setTimeout(function() {
    var _mF = (FPOS_RAW||[]).filter(function(p){return !p.yahoo_ticker;}).length;
    var _mA = (APOS_RAW||[]).filter(function(p){return !p.yahoo_ticker;}).length;
    if (_mF + _mA > 0) {
      autoFetchMissingTickers(function(){ _checkAutoRefresh(); });
      return;
    }
    _checkAutoRefresh();
  }, 600);
}

function _checkAutoRefresh() {
    // Solo ejecutar si el usuario está autenticado (login-screen oculto)
    var loginScreen = document.getElementById('login-screen');
    if (loginScreen && loginScreen.style.display !== 'none') return;
    // Evitar doble ejecución
    if (window._autoRefreshDone) return;
    window._autoRefreshDone = true;
    // Reset tras 10s para permitir refresh manual posterior
    setTimeout(function(){ window._autoRefreshDone = false; }, 10000);
    var today = new Date().toISOString().substring(0, 10);
    var lastDate = null;
    // fecha_precio en data.json tiene formato DD/MM/YYYY - convertir a YYYY-MM-DD
    FPOS_RAW.forEach(function(p) {
      if (p.fecha_precio) {
        var parts = p.fecha_precio.split('/');
        if (parts.length === 3) {
          var iso = parts[2]+'-'+parts[1]+'-'+parts[0];
          if (!lastDate || iso > lastDate) lastDate = iso;
        }
      }
    });
    // También comprobar acciones
    APOS_RAW.forEach(function(p) {
      if (p._priceDate && p._priceDate > (lastDate||'')) lastDate = p._priceDate.substring(0,10);
    });
    if (!lastDate) {
      var fxDates = Object.keys(FX_TABLE).sort();
      lastDate = fxDates.length ? fxDates[fxDates.length-1] : null;
    }
    var needsRefresh = !lastDate || lastDate < today;
    var now = new Date();
    var dow = now.getDay();
    var isWeekday = dow >= 1 && dow <= 5;

    // Comprobar si hay índices de benchmark sin datos de hoy
    var sp500hist = PRICE_HISTORY['SP500'] || [];
    var lastSP500 = sp500hist.length ? sp500hist[sp500hist.length-1].date : null;
    var benchNeedsRefresh = !lastSP500 || lastSP500 < today;
    if (!benchNeedsRefresh) {
      Object.keys(BENCH_INDICES).forEach(function(sym) {
        var idx = BENCH_INDICES[sym];
        if (!idx.enabled) return;
        var hist = PRICE_HISTORY[idx.key] || [];
        var last = hist.length ? hist[hist.length-1].date : null;
        if (!last || last < today) benchNeedsRefresh = true;
      });
    }

    // Calcular hora CET
    var utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    var jan = new Date(now.getFullYear(), 0, 1);
    var jul = new Date(now.getFullYear(), 6, 1);
    var isDST = now.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
    var cetHour = utcHour + (isDST ? 2 : 1);
    var navPublished = cetHour >= 18.5;

    if (needsRefresh && isWeekday && navPublished) {
      console.log('[Auto-refresh] Datos de ' + (lastDate||'?') + ', CET ' + cetHour.toFixed(1));
      refreshPrices();
    } else if (needsRefresh && isWeekday) {
      console.log('[Auto-refresh] NAV aún no publicado (CET ' + cetHour.toFixed(1) + ' < 18:30)');
      if (benchNeedsRefresh) {
        console.log('[Auto-refresh] Benchmark desactualizado — actualizando índices');
        refreshPrices();
      }
    } else if (!needsRefresh && benchNeedsRefresh && isWeekday) {
      console.log('[Auto-refresh] Fondos OK, benchmark desactualizado — actualizando');
      refreshPrices();
    } else {
      console.log('[Auto-refresh] Todo al día (' + today + ')');
    }
}

// ════════════════════════════════════════════════════════════════
//  ACTUALIZACIÓN DE PRECIOS (Yahoo Finance)
// ════════════════════════════════════════════════════════════════
var _refreshSeq = 0;  // secuencia global para cancelar refreshes huérfanos

function _showRefreshModal() {
  var m = document.getElementById('_refresh-modal');
  if (!m) {
    m = document.createElement('div');
    m.id = '_refresh-modal';
    m.style.cssText = [
      'position:fixed;inset:0;z-index:99999',
      'display:flex;flex-direction:column;align-items:center;justify-content:center',
      'background:rgba(7,13,22,0.82);backdrop-filter:blur(4px)',
      '-webkit-backdrop-filter:blur(4px)',
    ].join(';');
    m.innerHTML = [
      '<div style="background:#0d1929;border:1px solid #1e3a5a;border-radius:16px;',
      'padding:36px 48px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.6)">',
      '<div style="font-size:32px;margin-bottom:16px;animation:_spin 1.2s linear infinite">⟳</div>',
      '<div style="font-size:15px;font-weight:700;color:#dde6f0;margin-bottom:8px">Actualizando precios</div>',
      '<div style="font-size:12px;color:#4a6785">Obteniendo datos de Yahoo Finance…</div>',
      '</div>',
      '<style>@keyframes _spin{to{transform:rotate(360deg)}}</style>',
    ].join('');
    document.body.appendChild(m);
  }
  m.style.display = 'flex';
}

function _hideRefreshModal() {
  var m = document.getElementById('_refresh-modal');
  if (m) {
    m.style.opacity = '0';
    m.style.transition = 'opacity .3s';
    setTimeout(function(){ m.style.display = 'none'; m.style.opacity = '1'; m.style.transition = ''; }, 300);
  }
}

function refreshPrices() {
  var btn = document.getElementById('btn-refresh');
  btn.innerHTML = '⟳ <span style="font-size:10px;opacity:.8">actualizando…</span>';
  btn.style.color = 'var(--yel)';
  btn.disabled = true;
  _showRefreshModal();

  var PROXY = 'precio.php?s=';
  var mySeq = ++_refreshSeq;  // capturar secuencia actual en closure

  // ISIN → Yahoo symbol
  // YAHOO_GLOBAL construido dinamicamente desde data.json en initMaps()
  var allPos = FPOS_RAW.map(function(p){ return {isin:p.isin, type:'f'}; })
              .concat(APOS_RAW.map(function(p){ return {isin:p.isin, type:'a'}; }))
              .filter(function(p){ return YAHOO_GLOBAL[p.isin]; });

  // Si no hay posiciones con yahoo_ticker solo necesitamos FX y S&P500
  // pending = allPos.length + 2 (FX + S&P500 siempre se fetchean)

  var priceByISIN = {}, dateByISIN = {}, histByISIN = {}, prevByISIN = {};
  var fxRate = null;
  var pending = allPos.length + 2; // +1 for FX, +1 for S&P 500

  function tryFinish() {
    if (mySeq !== _refreshSeq) { clearTimeout(_safetyTimer); return; }
    pending--;
    if (pending > 0) return;

    var fx = fxRate || 1/( (function(){ var t=new Date().toISOString().substring(0,10); return FX_TABLE[t]||FX_TABLE[Object.keys(FX_TABLE).sort().pop()]||1; })() );

    FPOS_RAW.forEach(function(p) {
      if (priceByISIN[p.isin] !== undefined) {
        var nav = priceByISIN[p.isin];
        p.precio        = nav;
        p.valor_mercado = Math.round(p.titulos * nav * 100) / 100;
        p.plus_minus    = Math.round((p.valor_mercado - p.coste_adq) * 100) / 100;
        var invR = p.invertido_real || p.coste_adq;
        p.rentabilidad_real = invR > 0 ? Math.round((p.valor_mercado - invR) / invR * 10000) / 100 : 0;
        p._priceDate    = dateByISIN[p.isin] || null;
        p._hist         = histByISIN[p.isin] || null;
        if (prevByISIN[p.isin] !== undefined) p._prevClose = prevByISIN[p.isin];
        // M4 fix: actualizar fecha_precio en memoria (formato DD/MM/YYYY usado por el auto-refresh)
        // Sin esto, el auto-refresh compara la fecha vieja y se dispara en bucle
        if (p._priceDate) {
          var _dp = p._priceDate.split(' ')[0].split('-');
          if (_dp.length === 3) p.fecha_precio = _dp[2]+'/'+_dp[1]+'/'+_dp[0];
        }
      }
    });
    APOS_RAW.forEach(function(p) {
      if (priceByISIN[p.isin] !== undefined) {
        var price = priceByISIN[p.isin];
        p.precio = price;
        if (p.divisa === 'EUR') {
          p.valor_mercado = Math.round(p.titulos * price * 100) / 100;
          p.valor_eur     = p.valor_mercado;
          p.plus_minus    = Math.round((p.valor_mercado - p.coste_adq) * 100) / 100;
        } else {
          p.valor_mercado = Math.round(p.titulos * price * 100) / 100;
          p.valor_eur     = Math.round(p.valor_mercado / fx * 100) / 100;
          p.plus_minus    = Math.round((p.valor_eur - p.coste_adq) * 100) / 100;  // EUR - EUR
        }
        p._priceDate = dateByISIN[p.isin] || null;
        if (prevByISIN[p.isin] !== undefined) p._prevClose = prevByISIN[p.isin];
        p._priceDateUI = (window._priceDateDisplay && window._priceDateDisplay[p.isin])
          ? window._priceDateDisplay[p.isin] : p._priceDate;
      }
    });

    if (fxRate) {
      var today = new Date().toISOString().substring(0,10);
      FX_TABLE[today] = fxRate;
    }

    window._PRICES_LOADED = true;  // precios frescos disponibles
    processFondos(); renderFondos();
    processAcciones(); renderAcciones();
    // Re-render Resumen Global si era la vista activa al pulsar Actualizar
    var _activeView = document.querySelector('.view.on');
    if (_activeView && _activeView.id.indexOf('resumen') !== -1) { renderResumen(); }

    var now = new Date();
    var hhmm = now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
    document.getElementById('ts').textContent = 'actualizado ' + hhmm;
    btn.innerHTML = '⟳ Actualizar';
    btn.style.color = 'var(--mu2)';
    btn.disabled = false;
    clearTimeout(_safetyTimer);
    _hideRefreshModal();
    savePriceSnapshots();
  }

  // Timeout de seguridad: si en 30s el pending no llega a 0, desbloquear el botón
  var _safetyTimer = setTimeout(function() {
    if (mySeq !== _refreshSeq) return;
    console.warn('[refresh] Timeout de seguridad — desbloqueando botón');
    btn.innerHTML = '⟳ Actualizar'; btn.style.color = 'var(--mu2)'; btn.disabled = false;
    _hideRefreshModal();
  }, 30000);

  // Wrapper de tryFinish que cancela el timer de seguridad al completar


  // Helper fetch con timeout de 15s
  function fetchWithTimeout(url, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 15000);
    return fetch(url, { signal: ctrl.signal })
      .then(function(r) { clearTimeout(timer); return r; })
      .catch(function(e) { clearTimeout(timer); throw e; });
  }

  // Fetch precios individuales via precio.php
  allPos.forEach(function(pos) {
    var sym = YAHOO_GLOBAL[pos.isin];
    fetchWithTimeout(PROXY + encodeURIComponent(sym), 20000)
      .then(function(r){ return r.json(); })
      .then(function(d) {
        if (d.price) {
          priceByISIN[pos.isin] = parseFloat(d.price);
          var _dateOnly = (d.date || '').substring(0, 10);
          dateByISIN[pos.isin] = _dateOnly;
          if (d.hist) histByISIN[pos.isin] = d.hist;
          if (d.prev_close) prevByISIN[pos.isin] = parseFloat(d.prev_close);
          if (d.time) {
            window._priceDateDisplay = window._priceDateDisplay || {};
            window._priceDateDisplay[pos.isin] = _dateOnly + ' ' + d.time;
          }
        } else {
          console.warn('[refresh] No price for', sym, d.error);
        }
        tryFinish();
      })
      .catch(function(e) {
        if (e && e.name === 'AbortError') {
          console.warn('[refresh] Timeout (>20s) fetching', sym, '— continuando sin precio actualizado');
        } else {
          console.warn('[refresh] Error fetching', sym, e.message || e);
        }
        tryFinish();
      });
  });

  // FX via precio.php (server-side, evita CORS y timeouts del navegador)
  fetchWithTimeout(PROXY + encodeURIComponent('EURUSD=X'), 15000)
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.price && d.source === 'yahoo') {
        // EURUSD=X en Yahoo devuelve cuántos USD vale 1 EUR
        fxRate = parseFloat(d.price);
      }
      tryFinish();
    })
    .catch(function() { tryFinish(); });

  // ── Fetch índices de benchmark ──────────────────────────────────
  // Función helper: guardar snapshot en PRICE_HISTORY por key
  function _saveBenchSnapshot(key, price, date) {
    if (!PRICE_HISTORY[key]) PRICE_HISTORY[key] = [];
    var arr = PRICE_HISTORY[key];
    var last = arr[arr.length - 1];
    if (!last || last.date !== date) {
      arr.push({ date: date, price: parseFloat(price) });
      if (arr.length > 400) arr.splice(0, arr.length - 400);
    }
  }

  // S&P 500 benchmark via precio.php
  fetchWithTimeout(PROXY + encodeURIComponent('^GSPC'), 15000)
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.price) {
        var _sp500Date = (d.date || '').substring(0, 10);
        if (!PRICE_HISTORY['SP500']) PRICE_HISTORY['SP500'] = [];
        var _spArr = PRICE_HISTORY['SP500'];
        var _spLast = _spArr[_spArr.length - 1];
        if (!_spLast || _spLast.date !== _sp500Date) {
          _spArr.push({ date: _sp500Date, price: parseFloat(d.price) });
          if (_spArr.length > 400) _spArr.splice(0, _spArr.length - 400);
        } else {
          _spLast.price = parseFloat(d.price);
        }
        window._sp500Snapshot = { isin: 'SP500', price: parseFloat(d.price), date: _sp500Date };
      }
      tryFinish();
    })
    .catch(function(e) {
      console.warn('[refresh] Error fetching ^GSPC', e.message || e);
      tryFinish();
    });

  // Fetch otros índices de benchmark habilitados (no cuentan en pending — son opcionales)
  Object.keys(BENCH_INDICES).forEach(function(sym) {
    var idx = BENCH_INDICES[sym];
    if (sym === '^GSPC') return;  // ya fetcheado arriba
    if (!idx.enabled) return;    // solo si está activo
    fetchWithTimeout(PROXY + encodeURIComponent(sym), 18000)
      .then(function(r){ return r.json(); })
      .then(function(d) {
        if (d.price && d.date) {
          _saveBenchSnapshot(idx.key, d.price, d.date.substring(0,10));
          // Guardar historial completo de Yahoo si disponible
          if (d.hist) {
            window['_benchHist_'+idx.key] = d.hist;
          }
        }
        // Persistir en servidor
        var snap = { isin: idx.key, price: parseFloat(d.price||0), date: (d.date||'').substring(0,10) };
        if (snap.price > 0 && snap.date) {
          if (!window._benchSnapshots) window._benchSnapshots = [];
          window._benchSnapshots.push(snap);
        }
      })
      .catch(function(e){
        if (e && e.name === 'AbortError') {
          console.warn('[bench] Timeout fetching '+sym+' (>10s) — reintentará en el próximo refresh');
        } else {
          console.warn('[bench] Error fetching '+sym, e.message||e);
        }
      });
  });
}



// ════════════════════════════════════════════════════════════════
//  SORT TABLES
// ════════════════════════════════════════════════════════════════
function sortTable(th) {
  var table = th.closest('table');
  var tbody = table.querySelector('tbody');
  var col   = parseInt(th.dataset.col);

  // Delegate fondos ops table
  if (tbody && tbody.id === 'f-tb-ops') {
    var colMapF = {'0':'tipo','1':'nombre','2':'fecha','5':'total'};
    var keyF = colMapF[col+''];
    if (keyF) {
      if (_fOpsSort.col === keyF) _fOpsSort.dir *= -1;
      else { _fOpsSort.col = keyF; _fOpsSort.dir = -1; }
      renderFondos();
    }
    return;
  }
  // Delegate to state-based sort for acciones ops table
  if (tbody && tbody.id === 'a-tb-ops') {
    var colMap = {'0':'type','1':'ticker','4':'date','9':'total'};
    var key = colMap[col+''];
    if (key) {
      if (_aOpsSort.col === key) _aOpsSort.dir *= -1;
      else { _aOpsSort.col = key; _aOpsSort.dir = -1; }
      renderAccionesOps();
    }
    return;
  }

  var asc   = th.classList.contains('sort-desc'); // toggle

  // Clear all sort indicators in this table
  table.querySelectorAll('th').forEach(function(t) {
    t.classList.remove('sort-asc','sort-desc');
  });
  th.classList.add(asc ? 'sort-asc' : 'sort-desc');

  var rows = Array.from(tbody.querySelectorAll('tr'));

  // Separate total/summary rows (keep at bottom)
  var dataRows  = rows.filter(function(r){ return !r.style.background || r.style.background === ''; });
  var fixedRows = rows.filter(function(r){ return r.style.background && r.style.background !== ''; });

  function cellVal(row) {
    var cell = row.cells[col];
    if (!cell) return '';
    var txt = (cell.innerText || cell.textContent || '').trim();
    // dd/mm/aaaa → sortable number aaaammdd
    var dm = txt.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (dm) return parseInt(dm[3]+dm[2]+dm[1]);
    // dd/mm/aa → sortable number yymmdd
    var dm2 = txt.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
    if (dm2) return parseInt(dm2[3]+dm2[2]+dm2[1]);
    // YYYY-MM-DD
    var iso = txt.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return parseInt(iso[1]+iso[2]+iso[3]);
    // Strip whitespace, currency symbols, %, +
    txt = txt.replace(/[€%+\s]/g,'').replace(',','.').trim();
    var n = parseFloat(txt);
    return isNaN(n) ? txt.toLowerCase() : n;
  }

  dataRows.sort(function(a, b) {
    var va = cellVal(a), vb = cellVal(b);
    if (typeof va === 'number' && typeof vb === 'number') return asc ? va-vb : vb-va;
    return asc ? (va>vb?1:-1) : (va<vb?1:-1);
  });

  // Re-append sorted rows + fixed rows at bottom
  dataRows.concat(fixedRows).forEach(function(r){ tbody.appendChild(r); });
}

// ════════════════════════════════════════════════════════════════
//  RESUMEN GLOBAL
// ════════════════════════════════════════════════════════════════
function renderResumen() {
  if (!window._PRICES_LOADED) return; // esperar a precios frescos
  // ── Datos fondos ──
  var fv  = FPOS.reduce(function(s,p){return s+p.currentValue;},0);
  var fc  = FPOS.reduce(function(s,p){return s+p.cost;},0);  // coste_adq
  var fi  = (window._FONDOS_IR_TOTAL) || fc;  // invertido real histórico
  var fgl = fv - fc;  // latente vs coste_adq

  // ── Datos acciones ──
  var av  = APOS.reduce(function(s,p){return s+p.currentValue;},0);
  var ac  = APOS.reduce(function(s,p){return s+p.cost;},0);
  var agl = av - ac;

  // ── Realizados ──
  // Bug 1: filtrar por año en curso — REEMBOLSOS_BROKER acumula histórico completo
  var yr = new Date().getFullYear().toString();
  var realF = REEMBOLSOS_BROKER.filter(function(v){ return (v.fecha||'').startsWith(yr); })
                .reduce(function(s,v){ return s+v.gain; }, 0);
  var realFTotal = REEMBOLSOS_BROKER.reduce(function(s,v){ return s+v.gain; }, 0); // histórico completo para KPIs no fiscales
  // Bug 6: cachear calcRealizedAcc — se usará también en el bloque fiscal sin recalcular
  var fifoA = calcRealizedAcc();
  var realA    = fifoA.totalEur || 0;  // histórico completo acciones
  var realAYTD = Object.values(fifoA.byTicker).reduce(function(s,v){ return s+(v.byYear[yr]||0); }, 0);

  // ── Dividendos ──
  var divids = AOPS_RAW.filter(function(o){return o.tipo==='dividendo';});
  var totalDivid = divids.reduce(function(s,o){
    var imp = o.importe || (o.titulos * o.precio) || 0;
    return s + toEUR(imp, o.divisa||'EUR', o.fecha||'2025-01-01');
  }, 0);

  // ── Totales ──
  var totalVal    = fv + av;
  var totalInv    = fc + ac;   // coste_adq — para G/P latente
  // "Capital aportado" = coste_adq total de posiciones abiertas (fondos + acciones)
  // Incluye pm_real (capital fiscal heredado de traspasos), que tambien es capital del usuario.
  var totalInvReal = totalInv;
  var totalGL     = fgl + agl;
  var totalGLpct  = totalInvReal > 0 ? (totalGL/totalInvReal)*100 : 0;  // sobre capital real aportado
  var totalReal   = realFTotal + realA;  // histórico completo para KPI G/P realizada
  var totalHist   = totalGL + totalReal + totalDivid;

  // ── Plusvalía latente total ──
  var latenteTotal = totalGL;

  // Gain de fondos ya CERRADOS (traspasados o liquidados antes de la cartera actual)
  // Calculado desde FOPS_RAW: para cada ISIN cerrado, (traspaso_salida + reembolso) - suscripciones directas
  var currentISINs = {};
  FPOS_RAW.forEach(function(p){ currentISINs[p.isin] = true; });
  var closedGains = {};
  FOPS_RAW.forEach(function(o) {
    var isin = o.isin || '';
    if (currentISINs[isin]) return; // fondo aún abierto — no contar aquí
    if (!closedGains[isin]) closedGains[isin] = { suscrito: 0, t_entrada: 0, salida: 0 };
    var imp = parseFloat(o.titulos||0) * parseFloat(o.precio||0);
    if (o.tipo === 'suscripcion')                               closedGains[isin].suscrito  += imp;
    if (o.tipo === 'traspaso_entrada')                          closedGains[isin].t_entrada += imp;
    if (o.tipo === 'traspaso_salida' || o.tipo === 'reembolso') closedGains[isin].salida    += imp;
  });
  var pmRoboadvisor   = 0;
  var closedSuscrito  = 0;  // cash directo invertido en fondos cerrados
  Object.keys(closedGains).forEach(function(isin) {
    var g = closedGains[isin];
    // Gain real = salida - coste total (cash directo + capital heredado vía traspaso_entrada)
    // Sin restar t_entrada, el capital traspassado entre fondos se contaría como ganancia
    pmRoboadvisor  += g.salida - g.suscrito - g.t_entrada;
    closedSuscrito += g.suscrito;
  });
  pmRoboadvisor  = Math.round(pmRoboadvisor  * 100) / 100;
  closedSuscrito = Math.round(closedSuscrito * 100) / 100;

  // Denominador completo: todo el cash histórico (fondos abiertos + cerrados + acciones)
  // Denominador histórico: cash directo fondos abiertos (fiReal) + acciones + cash fondos cerrados
  var fiRealOpen = FPOS.reduce(function(s,p){ return s+p.invertidoReal; }, 0);
  var totalInvRealCompleto = Math.round((fiRealOpen + ac + closedSuscrito) * 100) / 100;

  // totalHistCompleto = latente + realizado + dividendos + gain fondos cerrados
  var totalHistCompleto = totalHist + Math.max(0, pmRoboadvisor);

  // ── Fiscal (año en curso) ──
  // Bug 1: base imponible solo con realizados del año en curso
  // Bug 4: no redondear componentes antes de sumar — calcular IRPF sobre la suma exacta
  var dividYTD = AOPS_RAW.filter(function(o){ return o.tipo==='dividendo' && (o.fecha||'').startsWith(yr); })
    .reduce(function(s,o){
      var imp = o.importe || (o.titulos * o.precio) || 0;
      return s + toEUR(imp, o.divisa||'EUR', o.fecha||'');
    }, 0);
  var baseImp   = realF + realAYTD + dividYTD;          // base imponible YTD exacta
  var baseHipot = baseImp + Math.max(0, latenteTotal);  // hipotético si vendes todo
  var irpfEst   = irpf(Math.max(0, baseImp));
  var irpfHipot = irpf(Math.max(0, baseHipot));
  // Versión redondeada solo para display
  var realFr = Math.round(realF*100)/100;
  var realAr = Math.round(realAYTD*100)/100;
  var dividR = Math.round(dividYTD*100)/100;

  // ── Evolución temporal: capital propio aportado/retirado por mes ──
  // Bug 3: excluir traspasos — no son flujo de caja real (no sale/entra dinero del bolsillo)
  var allOps = [];
  FOPS_RAW.forEach(function(o) {
    if (!o.fecha || !o.importe) return;
    var tipo = o.tipo;
    // Solo suscripciones y reembolsos directos — los traspasos son movimientos internos
    var cash = tipo==='suscripcion' ? o.importe :
               tipo==='reembolso'   ? -o.importe : 0;
    if (cash !== 0) allOps.push({ fecha: o.fecha, cash: cash });
  });
  AOPS_RAW.forEach(function(o) {
    if (!o.fecha) return;
    var imp = o.importe || (o.titulos * o.precio) || 0;
    // C1 fix: convertir siempre a EUR para no mezclar divisas en el gráfico
    var impEur = toEUR(imp, o.divisa || 'EUR', o.fecha);
    var cash = (o.tipo==='compra') ? impEur : (o.tipo==='venta') ? -impEur : 0;
    if (cash !== 0) allOps.push({ fecha: o.fecha, cash: cash });
  });
  allOps.sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });

  // Aggregate by month
  var monthMap = {};
  allOps.forEach(function(o) {
    var m = o.fecha.substring(0,7); // YYYY-MM
    monthMap[m] = (monthMap[m]||0) + o.cash;
  });
  var months = Object.keys(monthMap).sort();
  var cumInv = [], cumLabels = [];
  var running = 0;
  months.forEach(function(m) {
    running += monthMap[m];
    cumInv.push(Math.max(0, Math.round(running)));
    cumLabels.push(m);
  });

  // ── KPIs mejorados ──
  var kpiData = [
    (function(){
      var sub =
        '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--fondos)">Fondos</span>' +
            '<span style="color:var(--text);font-weight:600">' + E(fv) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--acciones)">Acciones</span>' +
            '<span style="color:var(--text);font-weight:600">' + E(av) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between;padding-top:3px;border-top:1px solid var(--bd);margin-top:1px">' +
            '<span style="color:var(--mu2)">Capital aportado</span>' +
            '<span style="color:var(--mu2);font-weight:600">' + E(Math.round(totalInvReal*100)/100) + '</span>' +
          '</span>' +
        '</span>';
      return { l:'Valor cartera', v: E(totalVal), s: sub, c:'var(--ac)' };
    })(),

    (function(){
      var sub =
        '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--fondos)">Fondos</span>' +
            '<span style="color:' + C(fgl) + ';font-weight:600">' + (fgl>=0?'+':'') + E(Math.round(fgl*100)/100) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--acciones)">Acciones</span>' +
            '<span style="color:' + C(agl) + ';font-weight:600">' + (agl>=0?'+':'') + E(Math.round(agl*100)/100) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between;padding-top:3px;border-top:1px solid var(--bd);margin-top:1px">' +
            '<span style="color:var(--mu2)">Rentabilidad</span>' +
            '<span style="color:' + C(totalGLpct) + ';font-weight:700">' + (totalGLpct>=0?'+':'') + totalGLpct.toFixed(1) + '%</span>' +
          '</span>' +
        '</span>';
      return { l:'G/P latente', v: (totalGL>=0?'+':'') + E(Math.round(totalGL*100)/100), s: sub, c: C(totalGL) };
    })(),

    (function(){
      var sub =
        '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--mu2)">Reembolsos</span>' +
            '<span style="color:' + C(realFTotal) + ';font-weight:600">' + (realFTotal>=0?'+':'') + E(Math.round(realFTotal*100)/100) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--mu2)">Ventas acc.</span>' +
            '<span style="color:' + C(realA) + ';font-weight:600">' + (realA>=0?'+':'') + E(Math.round(realA*100)/100) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between;padding-top:3px;border-top:1px dashed rgba(255,255,255,.1);margin-top:1px">' +
            '<span style="color:var(--yel)">+ Dividendos</span>' +
            '<span style="color:var(--yel);font-weight:600">+' + E(Math.round(totalDivid*100)/100) + '</span>' +
          '</span>' +
        '</span>';
      // C2 fix: usar realFTotal (histórico completo) en lugar de realF (solo YTD)
      var _rdisplay=Math.round(realFTotal*100)/100+Math.round(realA*100)/100+Math.round(totalDivid*100)/100;
      return { l:'G/P realizada + dividendos', v: (_rdisplay>=0?'+':'')+E(Math.round(_rdisplay*100)/100), s: sub, c: C(_rdisplay) };
    })(),

    (function(){
      var gpHist = Math.round((totalGL + totalReal + totalDivid)*100)/100;
      var gpHistPct = totalInvReal > 0 ? (gpHist / totalInvReal) * 100 : 0;
      var sub =
        '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--mu2)">G/P latente</span>' +
            '<span style="color:' + C(totalGL) + ';font-weight:600">' + (totalGL>=0?'+':'') + E(Math.round(totalGL*100)/100) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--mu2)">G/P realizada</span>' +
            '<span style="color:' + C(totalReal) + ';font-weight:600">' + (totalReal>=0?'+':'') + E(Math.round(totalReal*100)/100) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--yel)">+ Dividendos</span>' +
            '<span style="color:var(--yel);font-weight:600">+' + E(Math.round(totalDivid*100)/100) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between;padding-top:3px;border-top:1px solid var(--bd);margin-top:1px">' +
            '<span style="color:var(--mu2)">Rentab. s/invertido</span>' +
            '<span style="color:' + C(gpHistPct) + ';font-weight:700">' + (gpHistPct>=0?'+':'') + gpHistPct.toFixed(1) + '%</span>' +
          '</span>' +
        '</span>';
      return { l:'G/P Histórica', v: (gpHist>=0?'+':'')+E(gpHist), s: sub, c: C(gpHist) };
    })(),

    (function(){
      var histPct = totalInvRealCompleto > 0 ? (totalHistCompleto/totalInvRealCompleto)*100 : 0;
      var _histDisp = Math.round(totalHistCompleto*100)/100;
      var sub =
        '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--mu2)">G/P Histórica</span>' +
            '<span style="color:' + C(totalGL+totalReal+totalDivid) + ';font-weight:600">' + (totalGL+totalReal+totalDivid>=0?'+':'') + E(Math.round((totalGL+totalReal+totalDivid)*100)/100) + '</span>' +
          '</span>' +
          (pmRoboadvisor > 1 ?
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--mu2)">+ Fondos anteriores</span>' +
            '<span style="color:var(--ac);font-weight:600">+' + E(Math.round(pmRoboadvisor*100)/100) + '</span>' +
          '</span>' : '') +
          '<span style="display:flex;justify-content:space-between;padding-top:3px;border-top:1px solid var(--bd);margin-top:1px">' +
            '<span style="color:var(--mu2)">Rentab. real total</span>' +
            '<span style="color:' + C(histPct) + ';font-weight:700">' + (histPct>=0?'+':'') + histPct.toFixed(1) + '%</span>' +
          '</span>' +
        '</span>';
      return { l:'G/P Histórica total', v: (_histDisp>=0?'+':'')+E(_histDisp), s: sub, c: C(_histDisp) };
    })(),

    (function(){
      var neto = baseImp - irpfEst;
      var latenteTax = irpfHipot - irpfEst;
      var sub =
        '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--mu2)">Base imponible</span>' +
            '<span style="color:var(--text);font-weight:600">' + E(Math.round(baseImp*100)/100) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between">' +
            '<span style="color:var(--red)">IRPF estimado</span>' +
            '<span style="color:var(--red);font-weight:600">-' + E(Math.round(irpfEst*100)/100) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between;padding-top:3px;border-top:1px solid var(--bd);margin-top:1px">' +
            '<span style="color:var(--mu2)">Neto realizado</span>' +
            '<span style="color:' + C(neto) + ';font-weight:700">' + (neto>=0?'+':'') + E(Math.round(neto*100)/100) + '</span>' +
          '</span>' +
          '<span style="display:flex;justify-content:space-between;padding-top:4px;border-top:1px dashed rgba(255,255,255,.08);margin-top:2px">' +
            '<span style="color:var(--mu2);font-size:10px">Latente ' + (latenteTotal>=0?'+':'') + E(Math.round(latenteTotal*100)/100) + ' · IRPF hipotético</span>' +
            '<span style="color:var(--red);font-weight:600;font-size:10px">-' + E(Math.round(latenteTax*100)/100) + '</span>' +
          '</span>' +
        '</span>';
      return { l:'Fiscal realizado', v: '-' + E(Math.round(irpfEst*100)/100), s: sub, c:'var(--red)' };
    })(),
  ];

  document.getElementById('rg-kd').innerHTML = kpiData.map(function(k){
    var sColor = (typeof k.s === 'string' && k.s.indexOf('<') === 0) ? '' : 'color:'+k.c+'55';
    return '<div class="panel" style="padding:14px 16px">' +
      '<div class="klbl">' + k.l + '</div>' +
      '<div class="kval" style="color:'+k.c+'">' + k.v + '</div>' +
      (k.s ? '<div class="ksub" style="'+sColor+'">' + k.s + '</div>' : '') +
    '</div>';
  }).join('');
  document.getElementById('rg-kd').style.cssText = 'display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:16px';

  // ── Tabla desglose por activo ──
  var allActivos = FPOS.map(function(p){
    return { ticker:p.ticker, nombre:p.nombre, tipo:'Fondo', inv:p.cost,
             val:p.currentValue, gl:p.gainLoss, glp:p.gainLossPct,
             peso:(p.currentValue/(totalVal||1))*100, color:'var(--fondos)' };
  }).concat(APOS.map(function(p){
    return { ticker:p.ticker, nombre:p.nombre||p.ticker, tipo:'Acción', inv:p.cost,
             val:p.currentValue, gl:p.gainLoss, glp:p.gainLossPct,
             peso:(p.currentValue/(totalVal||1))*100, color:'var(--acciones)' };
  }));

  window._activosSortState = window._activosSortState || {col:'val', dir:-1};
  var _as = window._activosSortState;
  function sortActivos() {
    var s = _as;
    allActivos.sort(function(a,b){
      if (s.col==='ticker') return s.dir*(a.ticker<b.ticker?-1:a.ticker>b.ticker?1:0);
      return (b[s.col]-a[s.col])*s.dir;
    });
  }
  window._activosSetSort = function(col) {
    if (_as.col===col) _as.dir*=-1; else { _as.col=col; _as.dir=-1; }
    renderResumen();
  };
  sortActivos();

  var tablaRows = allActivos.map(function(r) {
    return '<tr>' +
      '<td title="'+r.nombre+'"><span style="display:inline-flex;align-items:center;gap:6px">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:'+r.color+';flex-shrink:0"></span>' +
        '<span style="font-weight:700;color:var(--text)">'+r.nombre+'</span>' +
        '<span style="color:var(--mu2);font-size:10px;background:var(--s2);border-radius:4px;padding:1px 5px">'+r.tipo+'</span>' +
      '</span></td>' +
      '<td class="mono">'+E(Math.round(r.inv*100)/100)+'</td>' +
      '<td class="mono" style="font-weight:700">'+E(Math.round(r.val*100)/100)+'</td>' +
      '<td class="mono" style="color:'+C(r.gl)+';font-weight:700">'+(r.gl>=0?'+':'')+E(Math.round(r.gl*100)/100)+'</td>' +
      '<td class="mono" style="color:'+C(r.glp)+';font-weight:800">'+(r.glp>=0?'+':'')+r.glp.toFixed(1)+'%</td>' +
      '<td>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<div style="flex:1;height:4px;background:var(--s2);border-radius:2px">' +
            '<div style="width:'+Math.min(100,r.peso).toFixed(1)+'%;height:100%;background:'+r.color+';border-radius:2px"></div>' +
          '</div>' +
          '<span class="mono" style="font-size:10px;color:var(--mu2);width:32px;text-align:right">'+r.peso.toFixed(1)+'%</span>' +
        '</div>' +
      '</td>' +
    '</tr>';
  });

  // Totales row
  tablaRows.push(
    '<tr style="background:var(--s2);font-weight:800;border-top:2px solid var(--bd)">' +
      '<td style="color:var(--ac)">TOTAL</td>' +
      '<td class="mono">'+E(Math.round(totalInv*100)/100)+'</td>' +
      '<td class="mono" style="font-weight:800">'+E(Math.round(totalVal*100)/100)+'</td>' +
      '<td class="mono" style="color:'+C(totalGL)+';font-weight:800">'+(totalGL>=0?'+':'')+E(Math.round(totalGL*100)/100)+'</td>' +
      '<td class="mono" style="color:'+C(totalGLpct)+';font-weight:800">'+(totalGLpct>=0?'+':'')+totalGLpct.toFixed(1)+'%</td>' +
      '<td class="mono" style="color:var(--mu2)">100%</td>' +
    '</tr>'
  );
  document.getElementById('rg-tb-cat').innerHTML = tablaRows.join('');
  // Update sort arrows in thead
  ['ticker','inv','val','gl','glp','peso'].forEach(function(col){
    var el=document.getElementById('_as-'+col); if(!el) return;
    if(_as.col===col){ el.textContent=_as.dir===-1?' ↓':' ↑'; el.style.opacity='1'; }
    else { el.textContent=' ⇅'; el.style.opacity='.35'; }
  });

  // ── Gráfico evolución patrimonial (Opción C: capital aportado + valor actual) ──
  var ctxEv = document.getElementById('rg-evolucion');
  if (ctxEv && cumLabels.length > 1) {
    requestAnimationFrame(function() {
      var cv = ctxEv;
      var W = cv.parentElement.clientWidth || 600;
      var H = 200;
      cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      var pd = {t:24, r:16, b:28, l:56};
      var iW = W - pd.l - pd.r;
      var iH = H - pd.t - pd.b;

      // Valor actual de la cartera — único punto "hoy"
      var valHoy = Math.round(totalVal);
      var lastInv = cumInv[cumInv.length-1] || 0;
      var ganancia = valHoy - lastInv;
      var isGain = ganancia >= 0;

      var maxV = Math.max(Math.max.apply(null, cumInv), valHoy) * 1.05 || 1;
      var minV = 0;
      var rng = maxV - minV || 1;

      function xp(i){ return pd.l + (i/(cumInv.length-1))*iW; }
      function yp(v){ return pd.t + iH - ((v-minV)/rng)*iH; }

      // Grid lines
      ctx.strokeStyle='rgba(255,255,255,.05)';
      ctx.lineWidth=1;
      for(var g=0;g<=4;g++){
        var gy=pd.t+(g/4)*iH;
        ctx.beginPath(); ctx.moveTo(pd.l,gy); ctx.lineTo(pd.l+iW,gy); ctx.stroke();
        var gv=Math.round(maxV*(1-g/4));
        ctx.fillStyle='#556677'; ctx.font='9px monospace'; ctx.textAlign='right';
        ctx.fillText(gv>=1000?(gv/1000).toFixed(1)+'k':gv, pd.l-5, gy+3);
      }

      // ── Línea 1: capital aportado acumulado (verde teal) ──
      ctx.beginPath();
      ctx.moveTo(xp(0), yp(minV));
      for(var i=0;i<cumInv.length;i++) ctx.lineTo(xp(i), yp(cumInv[i]));
      ctx.lineTo(xp(cumInv.length-1), yp(minV));
      ctx.closePath();
      ctx.fillStyle='rgba(0,229,176,0.06)';
      ctx.fill();

      ctx.beginPath();
      ctx.strokeStyle='#00e5b0'; ctx.lineWidth=2; ctx.lineJoin='round';
      for(var i=0;i<cumInv.length;i++){
        if(i===0) ctx.moveTo(xp(i),yp(cumInv[i]));
        else ctx.lineTo(xp(i),yp(cumInv[i]));
      }
      ctx.stroke();

      // ── Punto + línea vertical "hoy": valor actual ──
      var lx = xp(cumInv.length-1);
      var lyInv = yp(lastInv);
      var lyVal = yp(valHoy);
      var valColor = isGain ? '#a78bfa' : '#f87171';  // lila si ganancia, rojo si pérdida

      // Línea vertical discontinua entre capital y valor actual
      ctx.save();
      ctx.setLineDash([3,3]);
      ctx.strokeStyle = valColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(lx, lyInv);
      ctx.lineTo(lx, lyVal);
      ctx.stroke();
      ctx.restore();

      // Punto valor actual
      ctx.beginPath();
      ctx.arc(lx, lyVal, 5, 0, Math.PI*2);
      ctx.fillStyle = valColor;
      ctx.fill();
      ctx.strokeStyle = '#0d1420';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Punto capital aportado (último)
      ctx.beginPath();
      ctx.arc(lx, lyInv, 3, 0, Math.PI*2);
      ctx.fillStyle = '#00e5b0';
      ctx.fill();

      // Labels "hoy"
      var lblValY = lyVal + (lyVal < pd.t + 20 ? 14 : -8);
      ctx.fillStyle = valColor;
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(E(valHoy), lx - 8, lblValY);

      var gaStr = (isGain?'+':'') + E(Math.round(ganancia*100)/100);
      ctx.font = '9px monospace';
      ctx.fillStyle = valColor;
      ctx.fillText(gaStr, lx - 8, lblValY + 12);

      // Label capital aportado
      ctx.fillStyle = '#00e5b0';
      ctx.font = '9px monospace';
      ctx.fillText(E(lastInv), lx - 8, lyInv + (lyInv > lyVal ? 12 : -4));

      // X labels (every N months)
      var step=Math.ceil(cumLabels.length/8);
      ctx.fillStyle='#556677'; ctx.font='9px monospace'; ctx.textAlign='center';
      for(var i=0;i<cumLabels.length;i+=step){
        ctx.fillText(cumLabels[i], xp(i), H-6);
      }

      // ── Leyenda ──
      var legy = pd.t - 8;
      ctx.font = '9px monospace'; ctx.textAlign = 'left';
      ctx.fillStyle = '#00e5b0';
      ctx.fillRect(pd.l, legy - 6, 12, 3);
      ctx.fillText('Capital aportado', pd.l + 16, legy);
      ctx.fillStyle = valColor;
      ctx.beginPath(); ctx.arc(pd.l + 110 + 5, legy - 4, 4, 0, Math.PI*2); ctx.fill();
      ctx.fillText('Valor hoy', pd.l + 120, legy);

      // Tooltip hover
      var _evTip = document.getElementById('_ev-tip');
      if (!_evTip) {
        _evTip = document.createElement('div');
        _evTip.id = '_ev-tip';
        _evTip.style.cssText = 'position:fixed;pointer-events:none;display:none;background:#0d1420;border:1px solid #1e3a5a;border-radius:6px;padding:6px 12px;font-size:12px;color:#dde6f0;z-index:9999;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.5)';
        document.body.appendChild(_evTip);
      }
      cv.onmousemove = function(e) {
        var rect = cv.getBoundingClientRect();
        var mx = (e.clientX - rect.left) * (cv.width / rect.width);
        if (mx < pd.l || mx > pd.l + iW) { _evTip.style.display='none'; return; }
        var idx = Math.round((mx - pd.l) / iW * (cumInv.length - 1));
        idx = Math.max(0, Math.min(cumInv.length-1, idx));
        var isLast = idx === cumInv.length - 1;
        var tipHtml = '<strong style="color:#aab">' + cumLabels[idx] + '</strong><br>' +
          '<span style="color:#00e5b0">● Capital: </span><span style="font-family:monospace">' + E(cumInv[idx]) + '</span>';
        if (isLast) {
          tipHtml += '<br><span style="color:' + valColor + '">● Valor hoy: </span>' +
            '<span style="font-family:monospace">' + E(valHoy) + '</span>' +
            '<br><span style="color:' + valColor + '; font-size:11px">' + gaStr + '</span>';
        }
        _evTip.innerHTML = tipHtml;
        _evTip.style.display = 'block';
        _evTip.style.left = (e.clientX + 14) + 'px';
        _evTip.style.top  = (e.clientY - 32) + 'px';
      };
      cv.onmouseleave = function() { if (_evTip) _evTip.style.display='none'; };
    });
  }

  // ── Gráficos: tarta + barras (en rAF para que el DOM esté pintado) ──
  requestAnimationFrame(function() {
      // ticker para leyenda: Yahoo ticker si existe, si no ISIN[:8]
      // Para acciones: si p.ticker parece un ISIN (12+ chars alfanum) → usar ISIN[:6]
      function _lgTicker(p, isAccion) {
        if (!isAccion) return p.yahoo_ticker || (p.isin||'').substring(0,8);
        var t = p.ticker||'';
        return (t.length >= 10 && /^[A-Z]{2}/.test(t)) ? (p.isin||t).substring(0,6) : (t||p.isin.substring(0,6));
      }
      var _allTotal = FPOS.reduce(function(s,p){return s+p.currentValue;},0) + APOS.reduce(function(s,p){return s+p.currentValue;},0);
      var allPos = FPOS.map(function(p,i){return {ticker:_lgTicker(p,false), nombre:p.nombre, val:p.currentValue, pct:_allTotal>0?p.currentValue/_allTotal*100:0, color:COLORS[i%COLORS.length]};})
                .concat(APOS.map(function(p,i){return {ticker:_lgTicker(p,true), nombre:p.nombre||p.ticker, val:p.currentValue, pct:_allTotal>0?p.currentValue/_allTotal*100:0, color:ACOLORS[i%ACOLORS.length]};}));
    drawPie('rg-pie', allPos.map(function(p){return p.ticker;}), allPos.map(function(p){return p.val;}),
      allPos.map(function(p){return p.color;}),
      allPos.map(function(p){return {nombre:p.nombre,val:p.val};}));
    var legendEl = document.getElementById('rg-pie-legend');
    // allPos now carries nombre for tooltip
    if (legendEl) legendEl.innerHTML = allPos.map(function(p){
      return '<span style="display:flex;align-items:center;gap:4px;cursor:default" title="'+p.nombre+'">' +
        '<span style="width:8px;height:8px;border-radius:2px;background:'+p.color+';flex-shrink:0;display:inline-block"></span>' +
        '<span style="font-weight:600;font-size:11px">'+p.nombre.split(' ').slice(0,2).join(' ')+'</span>' +
        '<span style="color:var(--mu2);font-size:10px;font-family:monospace">'+p.pct.toFixed(1)+'%</span>' +
      '</span>';
    }).join('');
    var allTickers = FPOS.map(function(p){return p.yahoo_ticker||(p.isin||'').substring(0,8);}).concat(APOS.map(function(p){return _lgTicker(p,true);}));
    // Bug 7: usar gainLossReal para fondos (vs invertido_real) en lugar de gainLoss (vs coste_adq del traspaso)
    var allGL      = FPOS.map(function(p){return p.gainLossReal;}).concat(APOS.map(function(p){return p.gainLoss;}));
    var allColors  = FPOS.map(function(p,i){return COLORS[i%COLORS.length];}).concat(APOS.map(function(p,i){return ACOLORS[i%ACOLORS.length];}));
    var allNames = FPOS.map(function(p){return p.nombre;}).concat(APOS.map(function(p){return p.nombre||p.ticker;}));
    drawBarsW('rg-bars', allTickers, allGL, allColors, 0.48, allNames);
  });


}


// ════════════════════════════════════════════════════════════════
//  FIRE SIMULATOR
// ════════════════════════════════════════════════════════════════

var _fireChart = null;

var FIRE_FIELDS = [
  'fire-edad','fire-edad-jubilacion','fire-pension','fire-salario','fire-pct-gastos','fire-patrimonio',
  'fire-herencia','fire-tasa',
  'fire-dca','fire-dca-jub','fire-pagas','fire-paga-importe','fire-trienio','fire-incremento-sal','fire-horizonte',
  'fire-r-pes','fire-r-base','fire-r-opt','fire-inf-baja','fire-inf-alta'
];

// Default values for FIRE fields (mirrors HTML value= attributes)
var FIRE_DEFAULTS = {
  'fire-edad': 35, 'fire-edad-jubilacion': 67, 'fire-pension': 2027,
  'fire-salario': 2000, 'fire-pct-gastos': 70, 'fire-patrimonio': '',
  'fire-herencia': 0, 'fire-tasa': 4,
  'fire-dca': 300, 'fire-dca-jub': 0, 'fire-pagas': 2, 'fire-paga-importe': 1500,
  'fire-trienio': 50, 'fire-incremento-sal': 1.5, 'fire-horizonte': 40,
  'fire-r-pes': 3, 'fire-r-base': 6, 'fire-r-opt': 9,
  'fire-inf-baja': 2, 'fire-inf-alta': 4
};

function fireEscMove(idx, dir) {
  var order = window._FIRE_ESC_ORDER || [0,1,2,3,4,5];
  var newOrder = order.slice();
  var target = idx + dir;
  if (target < 0 || target >= newOrder.length) return;
  var tmp = newOrder[idx]; newOrder[idx] = newOrder[target]; newOrder[target] = tmp;
  window._FIRE_ESC_ORDER = newOrder;
  fireCalc();
}

function fireToggleConfig() {
  var body = document.getElementById('fire-cfg-body');
  var chev = document.getElementById('fire-cfg-chevron');
  if (!body) return;
  var open = body.style.display === 'none' || body.style.display === '';
  body.style.display = open ? 'block' : 'none';
  if (chev) chev.textContent = open ? '▲ ocultar' : '▼ editar parámetros';
}

function fireOnEnter() {
  requestAnimationFrame(function() {
    // Step 1: always set all defaults first
    FIRE_FIELDS.forEach(function(id) {
      var el = document.getElementById(id);
      if (el && FIRE_DEFAULTS[id] !== '') el.value = FIRE_DEFAULTS[id];
    });
    // Step 2: overwrite with saved values from server (if any)
    fireLoadParams();
    // Step 3: pre-fill patrimonio from portfolio if still empty
    var patEl = document.getElementById('fire-patrimonio');
    if (patEl && !patEl.value) {
      var total = (FPOS_RAW||[]).reduce(function(s,p){ return s+(p.valor_mercado||0); },0)
                + (APOS_RAW||[]).reduce(function(s,p){ return s+(p.valor_eur||p.valor_mercado||0); },0);
      if (total > 0) patEl.value = Math.round(total);
    }
    fireCalc();
  });
}

function fireLoadParams() {
  if (!window._FIRE_PARAMS) return;
  var p = window._FIRE_PARAMS;
  FIRE_FIELDS.forEach(function(id) {
    var key = id.replace('fire-','');
    var el  = document.getElementById(id);
    // Restore if saved value exists — including numeric 0, skip only truly empty strings
    var saved = p[key];
    if (el && saved !== undefined && saved !== null && String(saved).trim() !== '') {
      el.value = saved;
    } else if (el && (saved === 0 || saved === '0')) {
      el.value = 0;
    }
    // If saved value is empty string, keep the default (do nothing)
  });
}

function fireSave() {
  var params = {};
  FIRE_FIELDS.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) params[id.replace('fire-','')] = el.value;
  });
  var btn = document.getElementById('fire-save-btn');
  var msg = document.getElementById('fire-save-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  fetch('guardar.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: AUTH_HASH_CLIENT, action: 'save_fire', params: params })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar'; }
    if (d.ok) {
      window._FIRE_PARAMS = params;
      if (msg) { msg.style.display='inline'; setTimeout(function(){ msg.style.display='none'; }, 3000); }
    } else { alert('Error: ' + (d.msg||'desconocido')); }
  })
  .catch(function(e){
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar'; }
    alert('Error de red: ' + e.message);
  });
}

function fireVal(id, def) {
  var el = document.getElementById(id);
  if (!el) return def;
  var v = el.value;
  // If empty, try the element's default attribute before falling back to JS default
  if (v === '' || v === null || v === undefined) {
    var attr = el.getAttribute('value');
    if (attr !== null && attr !== '') {
      var na = parseFloat(attr);
      return isNaN(na) ? def : na;
    }
    return def;
  }
  var n = parseFloat(v);
  return isNaN(n) ? def : n;
}

function fireCalc() {
  var edad          = fireVal('fire-edad', 35);
  var edadJub       = fireVal('fire-edad-jubilacion', 67);
  var pension       = fireVal('fire-pension', 800);       // €/mes nominales hoy
  var herencia      = fireVal('fire-herencia', 0);        // herencia objetivo en € de hoy
  var tasaRet       = fireVal('fire-tasa', 4) / 100;      // tasa de retirada anual
  var salario       = fireVal('fire-salario', 2000);      // salario neto mensual hoy
  var pctGastos     = fireVal('fire-pct-gastos', 70) / 100;
  var gastos        = salario * pctGastos;                // gastos = salario × % hoy
  var patrimonio0   = fireVal('fire-patrimonio', 0);
  var dcaBase       = fireVal('fire-dca', 300);
  var dcaJub        = fireVal('fire-dca-jub', 0);        // aportación mensual post-jubilación
  var nPagas        = fireVal('fire-pagas', 2);
  var pagaImporte   = fireVal('fire-paga-importe', 1500);
  var trienioInc    = fireVal('fire-trienio', 50);        // €/mes cada 3 años
  var incSalPct     = fireVal('fire-incremento-sal', 1.5) / 100;
  var horizonte     = Math.min(Math.max(1, fireVal('fire-horizonte', 40)), 60);
  var rPes          = fireVal('fire-r-pes', 3)   / 100;
  var rBase         = fireVal('fire-r-base', 6)  / 100;
  var rOpt          = fireVal('fire-r-opt', 9)   / 100;
  var infBaja       = fireVal('fire-inf-baja', 2) / 100;
  var infAlta       = fireVal('fire-inf-alta', 4) / 100;

  // ── Ratio de ganancia de la cartera (ajuste fiscal en retiradas) ──
  // Cuando reembolsas fondos/vendes acciones, solo la ganancia sobre coste tributa.
  // Con este ratio estimamos el IRPF real que "se come" cada euro retirado,
  // y corregimos el objetivo FIRE para que cubra gastos NETOS (no brutos).
  var _tvFire = FPOS.reduce(function(s,p){ return s+p.currentValue; }, 0) +
                APOS.reduce(function(s,p){ return s+p.currentValue; }, 0);
  var _glFire = FPOS.reduce(function(s,p){ return s+Math.max(0,p.gainLoss); }, 0) +
                APOS.reduce(function(s,p){ return s+Math.max(0,p.gainLoss); }, 0);
  // ratioGanancia = fracción de cada euro de cartera que es plusvalía latente
  var ratioGanancia = _tvFire > 0 ? Math.min(0.95, _glFire / _tvFire) : 0.30;

  // ── Calcular objetivo FIRE ──
  // La pensión cubre parte de los gastos — solo necesitas cubrir el gap con tu cartera.
  // Si la pensión cubre todo (funcionario con buena base), el objetivo FIRE es 0
  // pero igualmente mostramos la proyección hasta el horizonte.
  // Pension es nominal (primer mes de jubilación en euros futuros)
  // Para comparar con gastos actuales, la deflactamos con inflación media (3%)
  var infMedia       = (fireVal('fire-inf-baja', 2) + fireVal('fire-inf-alta', 4)) / 2 / 100;
  var pensionHoy     = pension / Math.pow(1 + infMedia, edadJub - edad); // equiv. en euros de hoy
  var gapMensual     = Math.max(0, gastos - pensionHoy);
  var gapAnual       = gapMensual * 12;
  // Ajuste fiscal: para neto gapAnual necesitas retirar más (parte va a Hacienda).
  // retiroBruto - irpf(retiroBruto * ratioGanancia) = gapAnual
  // Aproximación: factor = 1 - tipoMarginal * ratioGanancia
  var _tipoMargFire  = irpfMarginal(gapAnual * ratioGanancia);
  var _factorFiscal  = Math.max(0.5, 1 - _tipoMargFire * ratioGanancia);
  var gapAnualBruto  = gapAnual > 0 ? gapAnual / _factorFiscal : 0;
  var objetivoFIRE   = gapAnualBruto > 0 ? (gapAnualBruto / tasaRet) : 0;

  // Si objetivo es 0 (pensión >= gastos en términos reales) mostramos FIRE = jubilación
  var fireEsPension  = objetivoFIRE === 0;

  // ── KPIs ──
  var kpisEl = document.getElementById('fire-kpis');
  if (kpisEl) {
    var cobertura = gastos > 0 ? Math.round(pensionHoy / gastos * 100) : 0;
    var objLabel  = fireEsPension ? 'FIRE al jubilarte (' + edadJub + ' años)' : 'regla del 4%';

    // Patrimonio esperado a los 67 — estimación rápida con escenario base (rBase, infBaja)
    var aniosHastaJubKpi = Math.max(0, edadJub - edad);
    var patJubPes  = 0, patJubBase = 0, patJubOpt = 0;
    (function(){
      var scenarios = [{r:rPes,inf:infBaja,ref:'pes'},{r:rBase,inf:infBaja,ref:'base'},{r:rOpt,inf:infBaja,ref:'opt'}];
      scenarios.forEach(function(s){
        var p = patrimonio0;
        for (var a = 1; a <= aniosHastaJubKpi; a++) {
          var tri = Math.floor(a/3) * trienioInc;
          var dca = (dcaBase + tri) * Math.pow(1+incSalPct,a);
          var dcaA = dca*12 + nPagas*pagaImporte*Math.pow(1+incSalPct,a);
          p = p*(1+s.r) + dcaA;
        }
        if (s.ref==='pes') patJubPes=Math.round(p);
        if (s.ref==='base') patJubBase=Math.round(p);
        if (s.ref==='opt') patJubOpt=Math.round(p);
      });
    })();

    kpisEl.innerHTML = [
      (function(){
        var sub =
          '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
            '<span style="display:flex;justify-content:space-between">' +
              '<span style="color:var(--mu2)">Mensual</span>' +
              '<span style="color:var(--text);font-weight:600">' + E(Math.round(gastos*100)/100) + '</span>' +
            '</span>' +
            '<span style="display:flex;justify-content:space-between">' +
              '<span style="color:var(--mu2)">% salario</span>' +
              '<span style="color:var(--text);font-weight:600">' + N(pctGastos*100,0) + '% de ' + E(salario) + '</span>' +
            '</span>' +
          '</span>';
        return { l:'Gastos anuales', v: E(gastos*12), s: sub, c:'var(--text)' };
      })(),
      (function(){
        var col = cobertura>=100 ? 'var(--ac)' : 'var(--mu2)';
        var sub =
          '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
            '<span style="display:flex;justify-content:space-between">' +
              '<span style="color:var(--mu2)">Nominal ' + (new Date().getFullYear() + (edadJub - edad)) + '</span>' +
              '<span style="color:var(--text);font-weight:600">' + E(Math.round(pension*100)/100) + '/mes</span>' +
            '</span>' +
            '<span style="display:flex;justify-content:space-between">' +
              '<span style="color:var(--mu2)">Hoy equiv.</span>' +
              '<span style="color:var(--text);font-weight:600">' + E(Math.round(pensionHoy)) + '/mes</span>' +
            '</span>' +
            '<span style="display:flex;justify-content:space-between;padding-top:3px;border-top:1px solid var(--bd);margin-top:1px">' +
              '<span style="color:var(--mu2)">Cubre gastos</span>' +
              '<span style="color:' + col + ';font-weight:700">' + cobertura + '%</span>' +
            '</span>' +
          '</span>';
        return { l:'Pensión pública', v: E(Math.round(pension*12)), s: sub, c: col };
      })(),
      (function(){
        var tvF   = window._PORT_TVF || 0;
        var tvA   = window._PORT_TVA || 0;
        var gl    = window._PORT_GL  || 0;
        var pct   = window._PORT_PCT || 0;
        var glCol = gl >= 0 ? 'var(--ac)' : 'var(--red)';
        var sub   =
          '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
            '<span style="display:flex;justify-content:space-between">' +
              '<span style="color:var(--fondos)">Fondos</span>' +
              '<span style="color:var(--text);font-weight:600">' + E(tvF) + '</span>' +
            '</span>' +
            '<span style="display:flex;justify-content:space-between">' +
              '<span style="color:var(--acciones)">Acciones</span>' +
              '<span style="color:var(--text);font-weight:600">' + E(tvA) + '</span>' +
            '</span>' +
            '<span style="display:flex;justify-content:space-between;padding-top:3px;border-top:1px solid var(--bd);margin-top:1px">' +
              '<span style="color:var(--mu2)">G/P total</span>' +
              '<span style="color:' + glCol + ';font-weight:700">' + (gl>=0?'+':'') + E(Math.round(gl*100)/100) + ' <span style="font-size:10px">(' + (pct>=0?'+':'') + pct.toFixed(1) + '%)</span></span>' +
            '</span>' +
          '</span>';
        return { l:'Patrimonio actual', v: E(patrimonio0), s: sub, c:'var(--mu2)' };
      })(),
      (function(){
        var sub =
          '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
            '<span style="display:flex;justify-content:space-between">' +
              '<span style="color:var(--red)">Pesimista</span>' +
              '<span style="color:var(--text);font-weight:600">' + E(patJubPes) + '</span>' +
            '</span>' +
            '<span style="display:flex;justify-content:space-between">' +
              '<span style="color:var(--fondos)">Base</span>' +
              '<span style="color:var(--text);font-weight:600">' + E(patJubBase) + '</span>' +
            '</span>' +
            '<span style="display:flex;justify-content:space-between">' +
              '<span style="color:var(--ac)">Optimista</span>' +
              '<span style="color:var(--text);font-weight:600">' + E(patJubOpt) + '</span>' +
            '</span>' +
          '</span>';
        return { l:'Patrimonio a los ' + edadJub, v: E(patJubBase), s: sub, c:'var(--fondos)' };
      })(),
      { l:'Herencia posible (a los ' + (edad+horizonte) + 'a)', v:'<span id="kpi-herencia-v">—</span>', s:'<span id="kpi-herencia-s"></span>', c:'var(--ac)' },
    ].map(function(k){
      return '<div class="panel" style="padding:14px 16px">' +
        '<div style="font-size:11px;color:var(--mu2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">' + k.l + '</div>' +
        '<div style="font-family:\'JetBrains Mono\',monospace;font-size:18px;font-weight:800;color:' + k.c + '">' + k.v + '</div>' +
        '<div style="font-size:11px;color:var(--mu);margin-top:3px">' + k.s + '</div>' +
      '</div>';
    }).join('');
  }

  // anioJub debe definirse ANTES de la simulación (se usa dentro del loop)
  var anioJub = edadJub - edad;

  // ── Escenarios: orden persistente via _FIRE_ESC_ORDER ──
  var escBase = [
    { id:0, nombre:'Pes. + Inf.Alta',  r: rPes,  inf: infAlta, color:'#ff3d5a', dash: [6,3] },
    { id:1, nombre:'Pes. + Inf.Baja',  r: rPes,  inf: infBaja, color:'#f97316', dash: [4,2] },
    { id:2, nombre:'Base + Inf.Alta',  r: rBase, inf: infAlta, color:'#f5c842', dash: [6,3] },
    { id:3, nombre:'Base + Inf.Baja',  r: rBase, inf: infBaja, color:'#00e5b0', dash: [] },
    { id:4, nombre:'Opt. + Inf.Baja',  r: rOpt,  inf: infBaja, color:'#a78bfa', dash: [] },
    { id:5, nombre:'Opt. + Inf.Alta',  r: rOpt,  inf: infAlta, color:'#60a5fa', dash: [4,2] },
  ];
  // Apply saved order if any
  var escenarios;
  if (window._FIRE_ESC_ORDER && window._FIRE_ESC_ORDER.length === escBase.length) {
    escenarios = window._FIRE_ESC_ORDER.map(function(id) {
      return escBase.filter(function(e){ return e.id === id; })[0] || escBase[id];
    });
  } else {
    escenarios = escBase.slice();
  }

  // ── Simulación año a año ──
  var resultados = escenarios.map(function(esc) {
    var pat           = patrimonio0;
    var anioFIRE      = null;
    var anioAnticipado = null;
    var serie         = [pat];
    var serieAport    = [patrimonio0];  // aportaciones acumuladas (capital propio)
    var aportAcum     = patrimonio0;    // patrimonio inicial cuenta como aportación

    for (var anio = 1; anio <= horizonte; anio++) {
      var edadAnio      = edad + anio;
      var aniosHastaJub = Math.max(0, edadJub - edadAnio);

      // DCA del año — laboral hasta jubilación, post-jub desde entonces
      var trieniosAcum = Math.floor(anio / 3) * trienioInc;
      var dcaAnual;
      if (edadAnio <= edadJub) {
        // Fase laboral: DCA base + trienios + incremento salarial + pagas
        var dcaMensual = (dcaBase + trieniosAcum) * Math.pow(1 + incSalPct, anio);
        dcaAnual = dcaMensual * 12 + nPagas * pagaImporte * Math.pow(1 + incSalPct, anio);
      } else {
        // Fase jubilado: DCA fijo post-jubilación (sin incremento salarial)
        dcaAnual = dcaJub * 12;
      }

      // Crecimiento: tras jubilación se descuenta el retiro anual + IRPF sobre la ganancia
      var retiradaAnual = edadAnio > edadJub ? pat * tasaRet : 0;
      // IRPF sobre la porción de ganancia del retiro (ajuste fiscal España)
      var irpfRetiro    = edadAnio > edadJub ? irpf(retiradaAnual * ratioGanancia) : 0;
      pat = pat * (1 + esc.r) + dcaAnual - retiradaAnual - irpfRetiro;
      if (pat < 0) pat = 0;
      aportAcum += dcaAnual;
      serie.push(Math.round(pat));
      serieAport.push(Math.round(aportAcum));

      // ── FIRE normal ──
      if (anioFIRE === null) {
        // Objetivo crece con salario futuro (trienios + incremento), no solo inflación
        var salarioFuturo   = (salario + Math.floor(anio/3) * trienioInc) * Math.pow(1 + incSalPct, anio);
        var gastosFuturos   = salarioFuturo * pctGastos * 12;
        var pensionFutura   = pension * Math.pow(1 + esc.inf, Math.max(0, anio - anioJub)) * 12;
        var gapFuturo       = Math.max(0, gastosFuturos - pensionFutura);
        // Ajuste fiscal: mismo grosse-up que en el objetivo inicial
        var _tipoMargN     = irpfMarginal(gapFuturo * ratioGanancia);
        var _factorN       = Math.max(0.5, 1 - _tipoMargN * ratioGanancia);
        var gapFuturoBruto = gapFuturo > 0 ? gapFuturo / _factorN : 0;
        var objetivoNominal = gapFuturoBruto > 0 ? gapFuturoBruto / tasaRet : 0;
        if (fireEsPension && edadAnio >= edadJub) {
          anioFIRE = { anio: anio, edad: edadAnio, pat: pat, esPension: true };
        } else if (!fireEsPension && objetivoNominal > 0 && pat >= objetivoNominal) {
          anioFIRE = { anio: anio, edad: edadAnio, pat: pat, esPension: false };
        }
      }

      // ── FIRE anticipado (solo si pension cubre gastos en jubilacion) ──
      // Necesitas cubrir tus gastos nominales desde ahora hasta la jubilacion,
      // después la pensión toma el relevo.
      // Usamos la regla del 4% aplicada solo al periodo puente:
      // necesitas retirar gastos_nominales/año durante aniosHastaJub años.
      // Patrimonio necesario = VA de esa renta al tipo r del escenario.
      // Si aniosHastaJub = 0 (ya llegaste) el puente es gratis.
      if (anioAnticipado === null && fireEsPension && edadAnio < edadJub) {
        // Gastos en el año de FIRE anticipado (salario futuro × pct)
        var salarioAnio  = (salario + Math.floor(anio/3) * trienioInc) * Math.pow(1 + incSalPct, anio);
        var gastosAnio   = salarioAnio * pctGastos * 12;  // gastos anuales en ese momento
        // Pensión: nominal en año de jubilación, se revaloriza solo desde entonces
        var pensionAnio  = pension * 12 * Math.pow(1 + esc.inf, Math.max(0, anio - anioJub));

        // PV de la anualidad creciente durante el puente:
        // Cada año k del puente (k=1..aniosHastaJub) los gastos crecen con inflación:
        //   retiro_k = gastosAnio * (1+inf)^k  —  pensión no llega aún
        // PV = suma k=1..n de retiro_k / (1+r)^k
        // = gastosAnio * (1+inf)/(1+r) * (1 - ((1+inf)/(1+r))^n) / (1 - (1+inf)/(1+r))
        // si r == inf: PV = gastosAnio * n
        var puenteNecesario;
        if (aniosHastaJub === 0) {
          puenteNecesario = 0;
        } else {
          var ratio = (1 + esc.inf) / (1 + esc.r);
          if (Math.abs(esc.r - esc.inf) < 0.0001) {
            // r ≈ inf: growing annuity degenerates to simple sum
            puenteNecesario = gastosAnio * aniosHastaJub;
          } else {
            // PV of growing annuity (first payment = gastosAnio*(1+inf), grows at inf, disc at r)
            puenteNecesario = gastosAnio * ratio * (1 - Math.pow(ratio, aniosHastaJub)) / (1 - ratio);
          }
        }

        if (pat >= puenteNecesario) {
          anioAnticipado = { anio: anio, edad: edadAnio, pat: pat, puente: Math.round(puenteNecesario) };
        }
      }
    }

    return { esc: esc, serie: serie, serieAport: serieAport, fire: anioFIRE, anticipado: anioAnticipado };
  });

  // ── Herencia KPI: usa datos reales de simulación ──
  (function(){
    // Pes = escenario con rPes (índice 0 o 1), Base = rBase (2 o 3), Opt = rOpt (4 o 5)
    // Tomamos el último año del horizonte de cada grupo de rentabilidad
    function patFinal(rTarget) {
      // Toma el escenario con infBaja para esa rentabilidad (mayor patrimonio nominal)
      var esc = resultados.filter(function(r){ return Math.abs(r.esc.r - rTarget) < 0.0001; });
      if (!esc.length) return 0;
      // Preferir infBaja (mismo nominal, pero representativo)
      var escBaja = esc.filter(function(e){ return Math.abs(e.esc.inf - infBaja) < 0.0001; });
      var target  = escBaja.length ? escBaja[0] : esc[0];
      return target.serie[Math.min(horizonte, target.serie.length-1)] || 0;
    }
    var pfPes  = patFinal(rPes);
    var pfBase = patFinal(rBase);
    var pfOpt  = patFinal(rOpt);
    var infMedia  = (infBaja + infAlta) / 2;
    var deflactor = Math.pow(1 + infMedia, horizonte);
    var vEl = document.getElementById('kpi-herencia-v');
    var sEl = document.getElementById('kpi-herencia-s');
    if (vEl) vEl.innerHTML = E(pfBase) + ' <span style="font-size:11px;color:var(--mu2)">(' + E(Math.round(pfBase/deflactor)) + ' hoy)</span>';
    if (sEl) sEl.innerHTML =
      '<span style="display:flex;flex-direction:column;gap:3px;margin-top:2px">' +
        '<span style="display:flex;justify-content:space-between">' +
          '<span style="color:var(--red)">r=' + N(rPes*100,0) + '%</span>' +
          '<span style="color:var(--text);font-weight:600">' + E(pfPes) + ' <span style="font-size:10px;color:var(--mu2)">(' + E(Math.round(pfPes/deflactor)) + ' hoy)</span></span>' +
        '</span>' +
        '<span style="display:flex;justify-content:space-between">' +
          '<span style="color:var(--ac)">r=' + N(rOpt*100,0) + '%</span>' +
          '<span style="color:var(--text);font-weight:600">' + E(pfOpt) + ' <span style="font-size:10px;color:var(--mu2)">(' + E(Math.round(pfOpt/deflactor)) + ' hoy)</span></span>' +
        '</span>' +
      '</span>';
  })();

  // ── Tabla de resultados ──
  var tablaEl = document.getElementById('fire-tabla');
  if (tablaEl) {
    var hayAnticipado = fireEsPension && resultados.some(function(r){ return r.anticipado; });

    // Hitos post-jubilación cada 5 años hasta el horizonte (excl. año exacto de jub — ya está en columna Jubilación)
    // anioJub ya definido antes de la simulación
    var hitos     = [];
    for (var h = anioJub + 5; h <= horizonte; h += 5) hitos.push(h);
    if (hitos.length === 0 || hitos[hitos.length-1] !== horizonte) hitos.push(horizonte);

    var filas = resultados.map(function(r, ri) {
      var aportEnJub = r.serieAport ? r.serieAport[Math.min(r.fire ? r.fire.anio : horizonte, horizonte)] : null;
      var patEnJub   = r.fire ? r.fire.pat : r.serie[horizonte];
      var rendJub    = aportEnJub !== null ? patEnJub - aportEnJub : null;
      var rendJubPct = aportEnJub && patEnJub > 0 ? Math.round(rendJub / patEnJub * 100) : null;
      var fireStr = r.fire
        ? '<div style="font-family:\'JetBrains Mono\',monospace;font-weight:800;font-size:14px;color:var(--ac)">' + r.fire.edad + ' años</div>' +
          '<div style="color:var(--mu);font-size:10px;margin-top:1px">' + r.fire.anio + 'a' + (r.fire.esPension ? ' 🏛' : '') + '</div>' +
          (rendJub !== null ?
            '<div style="font-size:11px;margin-top:4px;font-family:\'JetBrains Mono\',monospace;font-weight:700;color:var(--text)">' + E(Math.round(patEnJub)) + '</div>' +
            '<div style="font-size:10px;color:var(--mu2)">' + E(Math.round(aportEnJub)) + ' aport. · <span style="color:' + (rendJub>=0?'var(--ac)':'var(--red)') + '">' + (rendJub>=0?'+':'') + E(Math.round(rendJub)) + ' (' + rendJubPct + '%)</span></div>' +
            (function(){
              var anioJubFire = r.fire ? r.fire.anio : anioJub;
              // Pensión inicial nominal — ya es el valor del primer mes de jubilación
              var pensionJub  = Math.round(pension);
              var rentaCart   = Math.round(patEnJub * tasaRet / 12);
              var totalJub    = rentaCart + pensionJub;
              return '<div style="font-size:10px;margin-top:4px;padding-top:4px;border-top:1px solid rgba(0,229,176,.2);line-height:1.8">' +
                '<span style="color:var(--mu2)">Cartera (' + N(tasaRet*100,1) + '%): </span><span style="color:var(--fondos);font-family:\'JetBrains Mono\',monospace;font-weight:700">' + E(rentaCart) + '/mes</span><br>' +
                '<span style="color:var(--mu2)">Pensión (+IPC): </span><span style="color:var(--mu2);font-family:\'JetBrains Mono\',monospace">' + E(pensionJub) + '/mes</span><br>' +
                '<span style="color:var(--mu2)">Total mensual: </span><span style="color:var(--ac);font-family:\'JetBrains Mono\',monospace;font-weight:800">' + E(totalJub) + '/mes</span>' +
              '</div>';
            })() +
            // Herencia analysis
            (herencia > 0 ? (function(){
              var herenciaNom  = herencia * Math.pow(1 + r.esc.inf, r.fire ? r.fire.anio : horizonte);
              var tasaHerencia = patEnJub > 0 ? Math.max(0, (patEnJub - herenciaNom) * tasaRet / patEnJub) : 0;
              var rentaHerencia = Math.round(patEnJub * tasaHerencia / 12);
              var tasaOk = patEnJub >= herenciaNom + patEnJub * tasaRet;
              return '<div style="font-size:10px;padding-top:3px;border-top:1px solid var(--bd);margin-top:3px">' +
                '<span style="color:var(--mu2)">Herencia ' + E(herencia) + ': </span>' +
                (patEnJub >= herenciaNom
                  ? '<span style="color:var(--ac)">✓ cubierta · retiro sostenible: ' + E(rentaHerencia) + '/mes</span>'
                  : '<span style="color:var(--red)">✗ faltan ' + E(Math.round(herenciaNom - patEnJub)) + ' nominales</span>') +
              '</div>';
            })() : '')
          : '')
        : '<span style="color:var(--mu)">+' + horizonte + 'a</span>';

      var anticipadoStr = '';
      if (hayAnticipado) {
        if (r.anticipado) {
          var ahorroAnios  = edadJub - r.anticipado.edad;
          // Find aportAcum at FIRE anticipado year
          var aportEnFire  = r.serieAport ? r.serieAport[r.anticipado.anio] : null;
          var rend         = aportEnFire !== null ? r.anticipado.pat - aportEnFire : null;
          var rendPct      = aportEnFire && r.anticipado.pat > 0 ? Math.round(rend / r.anticipado.pat * 100) : null;
          anticipadoStr =
            '<div style="font-family:\'JetBrains Mono\',monospace;font-weight:800;font-size:14px;color:var(--yel)">' + r.anticipado.edad + ' años</div>' +
            '<div style="color:var(--mu);font-size:10px;margin-top:1px">−' + ahorroAnios + 'a · puente ' + E(r.anticipado.puente) + '</div>' +
            (rend !== null ?
              '<div style="font-size:11px;margin-top:4px;font-family:\'JetBrains Mono\',monospace;font-weight:700;color:var(--text)">' + E(Math.round(r.anticipado.pat)) + '</div>' +
              '<div style="font-size:10px;color:var(--mu2)">' + E(Math.round(aportEnFire)) + ' aport. · <span style="color:' + (rend>=0?'var(--ac)':'var(--red)') + '">' + (rend>=0?'+':'') + E(Math.round(rend)) + ' (' + rendPct + '%)</span></div>'
            : '');
        } else {
          anticipadoStr = '<span style="color:var(--mu);font-size:11px">No alcanza</span>';
        }
      }

      return '<tr style="border-bottom:1px solid var(--bd)">' +
        '<td style="padding:7px 4px 7px 0;white-space:nowrap">' +
          '<span style="display:inline-flex;align-items:center;gap:5px">' +
            '<span style="display:flex;flex-direction:column;gap:1px">' +
              (ri > 0 ? '<button onclick="fireEscMove(' + ri + ',-1)" style="background:none;border:none;color:var(--mu2);cursor:pointer;font-size:10px;line-height:1;padding:0" title="Subir">▲</button>' : '<span style="width:14px"></span>') +
              (ri < resultados.length-1 ? '<button onclick="fireEscMove(' + ri + ',1)" style="background:none;border:none;color:var(--mu2);cursor:pointer;font-size:10px;line-height:1;padding:0" title="Bajar">▼</button>' : '<span style="width:14px"></span>') +
            '</span>' +
            '<span style="width:8px;height:8px;border-radius:50%;background:' + r.esc.color + ';flex-shrink:0;display:inline-block"></span>' +
            '<span style="font-size:11px;font-weight:600">' + r.esc.nombre + '</span>' +
          '</span>' +
        '</td>' +
        (hayAnticipado ? '<td style="text-align:right;padding:7px 4px;vertical-align:top">' + anticipadoStr + '</td>' : '') +
        '<td style="text-align:right;padding:7px 6px;vertical-align:top;background:rgba(0,229,176,.04);border-left:1px solid rgba(0,229,176,.12);border-right:1px solid rgba(0,229,176,.12)">' + fireStr + '</td>' +
        hitos.map(function(h) {
          var patH   = r.serie[Math.min(h, r.serie.length-1)] || 0;
          var aportH = r.serieAport ? (r.serieAport[Math.min(h, r.serieAport.length-1)] || 0) : 0;
          var rendH  = patH - aportH;
          var rendHPct = patH > 0 ? Math.round(rendH / patH * 100) : 0;
          var isJub  = (edad + h) === edadJub;
          // Pensión: valor nominal inicial (en euros del año de jubilación)
          // Se revaloriza solo desde la jubilación en adelante (IPC)
          var aniosDesdeJub = Math.max(0, h - anioJub);
          var pensionH = Math.round(pension * Math.pow(1 + r.esc.inf, aniosDesdeJub));
          var rentaMes = Math.round(patH * tasaRet / 12);
          var totalMes = rentaMes + pensionH;
          var herenciaNomH = herencia > 0 ? herencia * Math.pow(1 + r.esc.inf, h) : 0;
          var herenciaOk   = herencia > 0 ? patH >= herenciaNomH : null;
          return '<td style="text-align:right;padding:7px 6px;vertical-align:top;border-left:1px solid var(--bd)">' +
            '<div style="font-family:\'JetBrains Mono\',monospace;font-weight:700;font-size:12px;color:var(--text)">' + E(patH) + '</div>' +
            '<div style="font-size:10px;color:var(--mu2);margin-top:1px">' + E(aportH) + ' aport.</div>' +
            '<div style="font-size:10px;color:' + (rendH>=0?'var(--ac)':'var(--red)') + '">' + (rendH>=0?'+':'') + E(Math.round(rendH)) + ' (' + rendHPct + '%)</div>' +
            (h >= anioJub ? '<div style="font-size:10px;margin-top:3px;padding-top:3px;border-top:1px solid var(--bd);line-height:1.7">' +
              '<span style="color:var(--mu2)">Cartera: </span><span style="color:var(--fondos);font-family:\'JetBrains Mono\',monospace;font-weight:700">' + E(rentaMes) + '/m</span><br>' +
              '<span style="color:var(--mu2)">Pensión (+IPC): </span><span style="color:var(--mu2);font-family:\'JetBrains Mono\',monospace">' + E(pensionH) + '/m</span><br>' +
              '<span style="color:var(--mu2)">Total: </span><span style="color:var(--ac);font-family:\'JetBrains Mono\',monospace;font-weight:800">' + E(totalMes) + '/m</span>' +
            '</div>' : '') +
            (herencia > 0 ? '<div style="font-size:10px;margin-top:1px;color:' + (herenciaOk?'var(--ac)':'var(--red)') + '">' + (herenciaOk?'✓':'✗') + ' her.</div>' : '') +
          '</td>';
        }).join('') +
      '</tr>';
    }).join('');

    var hitoHeaders = hitos.map(function(h) {
      var edH = edad + h;
      var label = edH === edadJub ? '🏛 ' + edH + 'a' : edH + 'a';
      return '<th style="text-align:right;font-size:10px;color:' + (edH===edadJub?'var(--ac)':'var(--mu2)') + ';font-weight:600;padding-bottom:8px;white-space:nowrap">' + label + '</th>';
    }).join('');

    var headers =
      '<th style="text-align:left;font-size:10px;color:var(--mu2);font-weight:600;padding-bottom:8px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap">Escenario</th>' +
      (hayAnticipado ? '<th style="text-align:right;font-size:10px;color:var(--yel);font-weight:600;padding-bottom:8px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap">⚡ Anticipado</th>' : '') +
      '<th style="text-align:right;font-size:10px;color:var(--ac);font-weight:600;padding-bottom:8px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;background:rgba(0,229,176,.04);padding:6px 6px 8px">🏛 Jubilación</th>' +
      hitoHeaders;

    tablaEl.innerHTML = '<table style="width:100%;border-collapse:collapse">' +
      '<thead><tr>' + headers + '</tr></thead>' +
      '<tbody>' + filas + '</tbody>' +
    '</table>' +
    '<div style="margin-top:14px;padding:10px 12px;background:rgba(0,229,176,.04);border:1px solid rgba(0,229,176,.12);border-radius:8px;font-size:11px;color:var(--mu2);line-height:1.7">' +
      (hayAnticipado ? '⚡ <strong style="color:var(--yel)">Anticipado</strong>: cartera cubre gastos hasta la pensión (anualidad a tasa del escenario).<br>' : '') +
      '🏛 <strong style="color:var(--ac)">Jubilación</strong>: ' + (fireEsPension ? 'pensión cubre todo desde los ' + edadJub + ' años.' : 'patrimonio cubre gastos tras pensión (regla 4%).') + '<br>' +
      '📌 Rentabilidades nominales · inflación eleva el objetivo.' +
    '</div>';
  }

  // ── Gráfico ──
  var cv = document.getElementById('fire-chart');
  if (!cv) return;
  var W = Math.min(cv.parentElement.clientWidth - 40, 900);
  if (W < 100) W = 600;
  cv.width  = W;
  cv.height = 320;
  var ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, cv.height);

  var H  = cv.height;
  var pd = { t:20, r:20, b:40, l:72 };
  var iW = W - pd.l - pd.r;
  var iH = H - pd.t - pd.b;

  var labels = [];
  for (var i = 0; i <= horizonte; i++) labels.push(edad + i);

  // Objetivo FIRE nominal para escenario base (inflación baja)
  var objSerie = [];
  for (var i = 0; i <= horizonte; i++) {
    objSerie.push(objetivoFIRE * Math.pow(1 + infBaja, i));
  }

  // Max value for scale
  var allVals = [];
  resultados.forEach(function(r){ allVals = allVals.concat(r.serie); });
  allVals = allVals.concat(objSerie);
  var maxVal = Math.max.apply(null, allVals) * 1.05;
  var minVal = 0;

  function tx(i) { return pd.l + (i / horizonte) * iW; }
  function ty(v) { return pd.t + iH - ((v - minVal) / (maxVal - minVal)) * iH; }

  // Grid
  ctx.strokeStyle = '#1a2a3d';
  ctx.lineWidth   = 1;
  var steps = 5;
  for (var s = 0; s <= steps; s++) {
    var v  = minVal + (maxVal - minVal) * s / steps;
    var yy = ty(v);
    ctx.beginPath(); ctx.moveTo(pd.l, yy); ctx.lineTo(W - pd.r, yy); ctx.stroke();
    ctx.fillStyle = '#4a6785';
    ctx.font      = '10px DM Sans';
    ctx.textAlign = 'right';
    var label = v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? Math.round(v/1e3)+'k' : Math.round(v)+'';
    ctx.fillText(label + '€', pd.l - 6, yy + 3);
  }

  // X axis labels
  ctx.fillStyle = '#4a6785';
  ctx.textAlign = 'center';
  ctx.font      = '10px DM Sans';
  var xStep = Math.ceil(horizonte / 10);
  for (var i = 0; i <= horizonte; i += xStep) {
    ctx.fillText(labels[i], tx(i), H - pd.b + 14);
  }

  // Objetivo FIRE line or jubilacion marker
  ctx.setLineDash([8, 4]);
  if (fireEsPension) {
    // Vertical line at jubilacion age
    var jubAnio = edadJub - edad;
    if (jubAnio > 0 && jubAnio <= horizonte) {
      ctx.strokeStyle = 'rgba(0,229,176,0.35)';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(tx(jubAnio), pd.t);
      ctx.lineTo(tx(jubAnio), pd.t + iH);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,229,176,0.6)';
      ctx.font      = '10px DM Sans';
      ctx.textAlign = 'center';
      ctx.fillText('Jubilación (' + edadJub + ')', tx(jubAnio), pd.t + 12);
    }
  } else if (objetivoFIRE > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    objSerie.forEach(function(v, i) {
      i === 0 ? ctx.moveTo(tx(i), ty(v)) : ctx.lineTo(tx(i), ty(v));
    });
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font      = '10px DM Sans';
    ctx.textAlign = 'left';
    ctx.fillText('Objetivo FIRE', tx(1), ty(objSerie[1]) - 5);
  }
  ctx.setLineDash([]);

  // Aportaciones acumuladas — área sombreada usando escenario base (índice 3)
  // Fix: buscar escenario Base+Inf.Baja por id, no por índice (puede cambiar con reorder)
  var baseResult = resultados.filter(function(r){ return r.esc.id === 3; })[0] || resultados[3];
  if (baseResult && baseResult.serieAport) {
    ctx.beginPath();
    baseResult.serieAport.forEach(function(v, i) {
      i === 0 ? ctx.moveTo(tx(i), ty(v)) : ctx.lineTo(tx(i), ty(v));
    });
    ctx.lineTo(tx(horizonte), ty(0));
    ctx.lineTo(tx(0), ty(0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(74,103,133,0.25)';
    ctx.fill();
    // Línea de aportaciones
    ctx.beginPath();
    baseResult.serieAport.forEach(function(v, i) {
      i === 0 ? ctx.moveTo(tx(i), ty(v)) : ctx.lineTo(tx(i), ty(v));
    });
    ctx.strokeStyle = 'rgba(122,152,184,0.6)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3,3]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Etiqueta
    var midAport = baseResult.serieAport[Math.floor(horizonte/2)];
    ctx.fillStyle = 'rgba(122,152,184,0.8)';
    ctx.font      = '10px DM Sans';
    ctx.textAlign = 'left';
    ctx.fillText('Aportaciones', tx(Math.floor(horizonte/2)+1), ty(midAport) - 4);
  }

  // Series
  resultados.forEach(function(r) {
    ctx.strokeStyle = r.esc.color;
    ctx.lineWidth   = r.esc.dash.length ? 1.5 : 2.5;
    ctx.setLineDash(r.esc.dash);
    ctx.beginPath();
    r.serie.forEach(function(v, i) {
      i === 0 ? ctx.moveTo(tx(i), ty(v)) : ctx.lineTo(tx(i), ty(v));
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // FIRE normal marker (circle)
    if (r.fire) {
      var fx = tx(r.fire.anio);
      var fy = ty(r.fire.pat);
      ctx.beginPath();
      ctx.arc(fx, fy, 5, 0, Math.PI*2);
      ctx.fillStyle = r.esc.color;
      ctx.fill();
    }
    // FIRE anticipado marker (diamond, yellow outline)
    if (r.anticipado) {
      var ax = tx(r.anticipado.anio);
      var ay = ty(r.anticipado.pat);
      var ds = 6;
      ctx.beginPath();
      ctx.moveTo(ax, ay - ds);
      ctx.lineTo(ax + ds, ay);
      ctx.lineTo(ax, ay + ds);
      ctx.lineTo(ax - ds, ay);
      ctx.closePath();
      ctx.strokeStyle = '#f5c842';
      ctx.lineWidth   = 2;
      ctx.stroke();
      ctx.fillStyle = r.esc.color;
      ctx.fill();
    }
  });

  // ── Tooltip en hover ────────────────────────────────────────
  var _fireTip = document.getElementById('_fire-tip');
  if (!_fireTip) {
    _fireTip = document.createElement('div');
    _fireTip.id = '_fire-tip';
    _fireTip.style.cssText = 'position:fixed;pointer-events:none;display:none;background:#0d1420;border:1px solid #1e3a5a;border-radius:6px;padding:5px 10px;font-size:12px;color:#dde6f0;z-index:9999;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.5);min-width:160px';
    document.body.appendChild(_fireTip);
  }
  if (!cv._fireTipBound) {
    cv._fireTipBound = true;
    cv.style.cursor = 'crosshair';
    cv.addEventListener('mousemove', function(e) {
      var rect = cv.getBoundingClientRect();
      var mx = (e.clientX - rect.left) * (cv.width / rect.width);
      if (mx < pd.l || mx > pd.l + iW) { _fireTip.style.display='none'; return; }
      var idx = Math.round((mx - pd.l) / iW * horizonte);
      idx = Math.max(0, Math.min(horizonte, idx));
      var edadHover = edad + idx;
      var rows = resultados.map(function(r) {
        var v = r.serie[idx] || 0;
        return '<div style="display:flex;justify-content:space-between;gap:16px;margin-top:2px">' +
          '<span style="color:' + r.esc.color + '">' + r.esc.nombre + '</span>' +
          '<span style="font-family:monospace;font-weight:700">' + E(v) + '</span></div>';
      }).join('');
      _fireTip.innerHTML = '<strong style="color:#7a98b8">' + edadHover + ' años (año +' + idx + ')</strong>' + rows;
      _fireTip.style.display = 'block';
      _fireTip.style.left = (e.clientX + 14) + 'px';
      _fireTip.style.top  = (e.clientY - 32) + 'px';
    });
    cv.addEventListener('mouseleave', function() { if (_fireTip) _fireTip.style.display='none'; });
  }

  // Legend
  var legEl = document.getElementById('fire-chart-legend');
  if (legEl) {
    legEl.innerHTML = resultados.map(function(r) {
      return '<span style="display:flex;align-items:center;gap:4px">' +
        '<span style="width:16px;height:3px;background:' + r.esc.color + ';display:inline-block;border-radius:2px"></span>' +
        '<span style="color:var(--mu2)">' + r.esc.nombre + '</span>' +
      '</span>';
    }).join('');
  }
}

// ════════════════════════════════════════════════════════════════
//  DESINVERSIÓN — MÓDULO 1: OPTIMIZADOR DE VENTA
// ════════════════════════════════════════════════════════════════
//  FIFO HELPERS — reconstrucción de cola fiscal real por fondo
// ════════════════════════════════════════════════════════════════

// Reconstruye los lotes FIFO que quedan en cartera para un ISIN.
// Devuelve array [{fecha, tipo, qty, costPerUnit}] ordenado más antiguo primero.
function buildFIFOQueue(isin) {
  var ops = FOPS_RAW.filter(function(o){ return o.isin === isin; });
  ops.sort(function(a, b){ return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0; });

  var lots = [];

  ops.forEach(function(o) {
    var qty   = parseFloat(o.titulos) || 0;
    var price = parseFloat(o.precio)  || 0;
    var tipo  = o.tipo || '';

    if (tipo === 'suscripcion' || tipo === 'traspaso_entrada') {
      if (qty > 0) lots.push({ fecha: o.fecha, tipo: tipo, qty: qty, costPerUnit: price });

    } else if (tipo === 'reembolso' || tipo === 'traspaso_salida') {
      // Consumir FIFO
      var rem = qty;
      while (rem > 0.000001 && lots.length > 0) {
        var use = Math.min(rem, lots[0].qty);
        lots[0].qty -= use;
        rem         -= use;
        if (lots[0].qty < 0.000001) lots.shift();
      }
    }
  });

  // Eliminar residuos de precisión flotante
  return lots.filter(function(l){ return l.qty > 0.000001; });
}

// Simula vender titulosVender participaciones consumiendo la cola FIFO
// (no muta lots — trabaja sobre copia).
// precioActual: NAV actual del fondo.
// baseYTD: base imponible ya devengada en el año.
// Devuelve { glFIFO, taxParc, lotsDetail }
function calcFiscalVentaFIFO(lots, titulosVender, precioActual, baseYTD) {
  // Copia profunda de los lotes
  var cola = lots.map(function(l){ return { fecha: l.fecha, tipo: l.tipo, qty: l.qty, costPerUnit: l.costPerUnit }; });

  var rem       = titulosVender;
  var glTotal   = 0;
  var lotsDetail = [];

  while (rem > 0.000001 && cola.length > 0) {
    var use      = Math.min(rem, cola[0].qty);
    var ganancia = use * (precioActual - cola[0].costPerUnit);
    glTotal     += ganancia;
    lotsDetail.push({
      fecha:       cola[0].fecha,
      tipo:        cola[0].tipo,
      qtyUsed:     use,
      costPerUnit: cola[0].costPerUnit,
      ganancia:    ganancia
    });
    cola[0].qty -= use;
    rem         -= use;
    if (cola[0].qty < 0.000001) cola.shift();
  }

  var taxParc = Math.round((irpf(baseYTD + Math.max(0, glTotal)) - irpf(baseYTD)) * 100) / 100;
  return { glFIFO: Math.round(glTotal * 100) / 100, taxParc: taxParc, lotsDetail: lotsDetail };
}

// ════════════════════════════════════════════════════════════════
function renderOptimizador() {
  var need = parseFloat(document.getElementById('dv-need').value) || 0;

  // ── Bloque 1: situación fiscal YTD ──────────────────────────
  var yr = new Date().getFullYear().toString();
  var dividYTD = AOPS.filter(function(o){ return o.type==='dividendo' && o.date.startsWith(yr); })
    .reduce(function(s,o){ var _i=o.importe||(o.qty*o.price); return s + toEUR(_i, o.divisa, o.date); }, 0);
  var fifoYTD    = calcRealizedAcc();
  var realAccYTD = Object.values(fifoYTD.byTicker).reduce(function(s,v){ return s + (v.byYear[yr]||0); }, 0);
  var reembolYTD = (REEMBOLSOS_BROKER||[]).filter(function(r){ return (r.fecha||'').startsWith(yr); })
    .reduce(function(s,r){ return s + (r.gain||0); }, 0);
  var baseYTD  = Math.max(0, dividYTD + realAccYTD + reembolYTD);
  var tramosLim = [6000, 50000, 200000, 300000];
  var tramosTip = [19, 21, 23, 27, 28];
  var tramoActual = 0;
  for (var _t = 0; _t < tramosLim.length; _t++) { if (baseYTD >= tramosLim[_t]) tramoActual = _t + 1; }
  var margenTramoAct = tramoActual < tramosLim.length ? tramosLim[tramoActual] - baseYTD : 0;
  var tipoActual = tramosTip[tramoActual];

  var fiscalColor = baseYTD === 0 ? 'var(--mu2)' : baseYTD < 6000 ? 'var(--ac)' : baseYTD < 50000 ? 'var(--yel)' : 'var(--red)';
  document.getElementById('dv-fiscal-ytd').innerHTML =
    '<div class="panel" style="padding:16px 20px;display:flex;gap:32px;align-items:center;flex-wrap:wrap">' +
      '<div>' +
        '<div style="font-size:10px;color:var(--mu);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Base imponible ' + yr + '</div>' +
        '<div style="font-size:22px;font-weight:800;font-family:\'JetBrains Mono\',monospace;color:' + fiscalColor + '">' + E(Math.round(baseYTD*100)/100) + '</div>' +
      '</div>' +
      '<div style="width:1px;height:36px;background:var(--bd)"></div>' +
      '<div>' +
        '<div style="font-size:10px;color:var(--mu);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Tramo actual</div>' +
        '<div style="font-size:22px;font-weight:800;font-family:\'JetBrains Mono\',monospace;color:' + fiscalColor + '">' + tipoActual + '%</div>' +
      '</div>' +
      '<div style="width:1px;height:36px;background:var(--bd)"></div>' +
      '<div>' +
        '<div style="font-size:10px;color:var(--mu);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Margen hasta tramo ' + (tramosTip[tramoActual+1]||'—') + '%</div>' +
        '<div style="font-size:22px;font-weight:800;font-family:\'JetBrains Mono\',monospace;color:var(--ac)">' +
          (margenTramoAct > 0 ? E(Math.round(margenTramoAct)) : '—') + '</div>' +
      '</div>' +
    '</div>';

  if (!need) {
    document.getElementById('dv-opt-result').innerHTML =
      '<div style="padding:24px;color:var(--mu);text-align:center;font-size:13px">Introduce el importe que necesitas para ver el plan.</div>';
    return;
  }

  // ── Construir candidatos FIFO ────────────────────────────────
  // Solo fondos (acciones no son traspasables y tienen menor eficiencia fiscal)
  var candidatos = [];
  FPOS.forEach(function(p) {
    var lots = buildFIFOQueue(p.isin);
    if (!lots.length || p.qty <= 0) return;
    var fifo = calcFiscalVentaFIFO(lots, p.qty, p.currentPrice, baseYTD);
    candidatos.push({
      isin:      p.isin,
      nombre:    p.nombre,
      val:       p.currentValue,
      qty:       p.qty,
      precio:    p.currentPrice,
      gl:        fifo.glFIFO,             // ganancia real por FIFO si vendes todo
      glPerEur:  p.currentValue > 0 ? fifo.glFIFO / p.currentValue : 0,
      lots:      lots
    });
  });

  // ── Ordenación ───────────────────────────────────────────────
  // 1º minusvalías primero (compensan otras ganancias → IRPF = 0)
  // 2º menor ganancia por € vendido (menos "caro" fiscalmente)
  candidatos.sort(function(a, b) {
    var aMin = a.gl < 0, bMin = b.gl < 0;
    if (aMin && !bMin) return -1;
    if (!aMin && bMin) return  1;
    return a.glPerEur - b.glPerEur;
  });

  // ── Simular plan ─────────────────────────────────────────────
  var acumVal  = 0, acumGL = 0, acumTax = 0, acumNeto = 0;
  var plan = [];

  candidatos.forEach(function(c) {
    if (acumNeto >= need - 0.01) return;
    if (c.val <= 0) return;

    // ¿Cuánto valor bruto necesito para obtener lo que falta neto?
    // Iteramos fracción hasta que el neto cubra lo que falta
    var faltaNeto = need - acumNeto;
    // Estimación inicial: fracción = faltaNeto / val (sin IRPF)
    // Refinamos en una sola iteración para ser más precisos
    var fraccion = Math.min(1, faltaNeto / c.val);
    var titulosV, fifoRes, neto, intentos = 0;
    // Ajuste iterativo (max 6 pasos) para cubrir exactamente el neto pedido
    while (intentos++ < 6) {
      titulosV = c.qty * fraccion;
      fifoRes  = calcFiscalVentaFIFO(c.lots, titulosV, c.precio, baseYTD + Math.max(0, acumGL));
      neto     = c.val * fraccion - Math.max(0, fifoRes.taxParc);
      if (neto >= faltaNeto - 0.01 || fraccion >= 0.9999) break;
      // Aumentar fracción para compensar el IRPF
      fraccion = Math.min(1, fraccion * (faltaNeto / Math.max(0.01, neto)));
    }
    fraccion = Math.min(1, fraccion);
    titulosV = c.qty * fraccion;
    fifoRes  = calcFiscalVentaFIFO(c.lots, titulosV, c.precio, baseYTD + Math.max(0, acumGL));
    var valParc  = Math.round(c.val * fraccion * 100) / 100;
    var glParc   = fifoRes.glFIFO;
    var taxParc  = Math.max(0, fifoRes.taxParc);
    var netoParc = Math.round((valParc - taxParc) * 100) / 100;

    plan.push({ c: c, fraccion: fraccion, titulosV: titulosV, valParc: valParc, glParc: glParc, taxParc: taxParc, netoParc: netoParc });
    acumVal  += valParc;
    acumGL   += glParc;
    acumNeto += netoParc;
    acumTax  += taxParc;
  });

  // ── Diagnóstico de tramo ──────────────────────────────────────
  var baseFinal   = baseYTD + Math.max(0, acumGL);
  var tramoFinal  = 0;
  for (var _t2 = 0; _t2 < tramosLim.length; _t2++) { if (baseFinal >= tramosLim[_t2]) tramoFinal = _t2 + 1; }
  var cruzaTramo  = tramoFinal > tramoActual;
  var msgColor    = acumNeto < need - 0.5 ? 'rgba(244,63,94,.09)' : cruzaTramo ? 'rgba(245,200,66,.09)' : 'rgba(0,229,176,.07)';
  var msgBorder   = acumNeto < need - 0.5 ? 'rgba(244,63,94,.35)' : cruzaTramo ? 'rgba(245,200,66,.35)' : 'rgba(0,229,176,.25)';
  var msgTexto;
  if (acumNeto < need - 0.5) {
    msgTexto = '⚠ La cartera de fondos no es suficiente para cubrir ' + E(need) + '. Máximo disponible: ' + E(Math.round(acumNeto*100)/100) + '.';
  } else if (cruzaTramo) {
    msgTexto = '⚠ Este plan genera ' + E(Math.round(Math.max(0,acumGL)*100)/100) + ' en plusvalías y sube al tramo ' +
      tramosTip[tramoFinal] + '%. Considera reembolsar solo ' + E(Math.round(margenTramoAct)) +
      ' en plusvalías este año y diferir el resto al siguiente.';
  } else {
    msgTexto = '✓ El plan se queda dentro del tramo ' + tipoActual + '%. ' +
      (acumGL > 0
        ? 'Usas ' + E(Math.round(Math.max(0,acumGL)*100)/100) + ' de ' + E(Math.round(margenTramoAct)) + ' disponibles.'
        : 'Sin plusvalías realizadas — coste fiscal 0€.');
  }

  // ── Render ───────────────────────────────────────────────────
  var html = '<div class="panel" style="padding:20px 24px">';

  if (plan.length === 0) {
    html += '<div style="color:var(--mu);font-size:13px">No hay fondos con posición suficiente.</div>';
  } else {
    html += '<div style="overflow-x:auto"><table class="tbl" style="width:100%"><thead><tr>' +
      '<th style="text-align:left">Fondo</th>' +
      '<th style="text-align:right">Participaciones</th>' +
      '<th style="text-align:right">G/P fiscal (FIFO)</th>' +
      '<th style="text-align:right">IRPF</th>' +
      '<th style="text-align:right">Recibes neto</th>' +
      '</tr></thead><tbody>';

    plan.forEach(function(p) {
      var parcialLabel = p.fraccion < 0.9999
        ? '<br><span style="font-size:10px;color:var(--mu2)">venta parcial — ' + N(Math.round(p.fraccion*100),0) + '% de la posición</span>'
        : '';
      html += '<tr>' +
        '<td><strong style="color:var(--text)">' + p.c.nombre.substring(0,40) + '</strong>' +
          '<br><span class="mono" style="font-size:10px;color:var(--fondos)">' + p.c.isin + '</span>' +
          parcialLabel + '</td>' +
        '<td class="mono" style="text-align:right">' + N(Math.round(p.titulosV*1000)/1000, 3) + '</td>' +
        '<td class="mono" style="text-align:right;color:' + C(p.glParc) + '">' +
          (p.glParc >= 0 ? '+' : '') + E(Math.round(p.glParc*100)/100) + '</td>' +
        '<td class="mono" style="text-align:right;color:var(--red)">' +
          (p.taxParc > 0 ? '-' + E(p.taxParc) : '<span style="color:var(--ac)">0€</span>') + '</td>' +
        '<td class="mono" style="text-align:right;font-weight:700;color:var(--ac)">' + E(p.netoParc) + '</td>' +
      '</tr>';
    });

    // Fila de totales
    html += '<tr style="background:var(--s2);font-weight:800;border-top:2px solid var(--bd)">' +
      '<td style="color:var(--mu)">TOTAL</td>' +
      '<td></td>' +
      '<td class="mono" style="text-align:right;color:' + C(acumGL) + '">' +
        (acumGL >= 0 ? '+' : '') + E(Math.round(acumGL*100)/100) + '</td>' +
      '<td class="mono" style="text-align:right;color:var(--red)">' +
        (acumTax > 0 ? '-' + E(Math.round(acumTax*100)/100) : '<span style="color:var(--ac)">0€</span>') + '</td>' +
      '<td class="mono" style="text-align:right;font-weight:800;color:var(--ac)">' + E(Math.round(acumNeto*100)/100) + '</td>' +
    '</tr>';

    html += '</tbody></table></div>';

    // Mensaje de tramo
    html += '<div style="margin-top:14px;padding:10px 14px;border-radius:8px;font-size:12px;line-height:1.5;background:' +
      msgColor + ';border:1px solid ' + msgBorder + ';color:var(--mu2)">' + msgTexto + '</div>';
  }

  html += '</div>';
  document.getElementById('dv-opt-result').innerHTML = html;
}


// ════════════════════════════════════════════════════════════════
//  DESINVERSIÓN — MÓDULO 2: METAS DE AHORRO
// ════════════════════════════════════════════════════════════════
function renderMetas() {
  // Si el año de inicio está desactualizado (sigue en el valor por defecto HTML o en el pasado), actualizar
  (function() {
    var el = document.getElementById('mt-año-inicio');
    if (!el) return;
    var curVal = parseInt(el.value);
    var minSensible = new Date().getFullYear() + 2;
    if (!curVal || curVal < minSensible) el.value = new Date().getFullYear() + 10;
  })();
  var importeCerca = parseFloat(document.getElementById('mt-univ-cerca').value) || 20000;
  var importeFuera = parseFloat(document.getElementById('mt-univ-fuera').value) || 60000;
  var añoInicio    = parseInt(document.getElementById('mt-año-inicio').value)   || 2036;
  var rent         = (parseFloat(document.getElementById('mt-rent').value) || 6) / 100;
  var hoy          = new Date().getFullYear();
  var años         = Math.max(0, añoInicio - hoy);

  // Valor actual cartera
  var tvF = FPOS.reduce(function(s,p){ return s+p.currentValue; }, 0);
  var tvA = APOS.reduce(function(s,p){ return s+p.currentValue; }, 0);
  var tv  = tvF + tvA;

  // Proyección cartera en año inicio universidad (con DCA cero — solo rentabilidad)
  var proyCartera = tv * Math.pow(1 + rent, años);

  function analizar(label, importe) {
    var cubre = proyCartera >= importe;
    var exceso = proyCartera - importe;
    // ¿Qué fracción de la cartera se necesita liquidar?
    var fracNecesaria = cubre ? (importe / proyCartera) : 1;
    // Plusvalía estimada en esa fracción (proporcional a la latente actual)
    var glActual = FPOS.reduce(function(s,p){return s+Math.max(0,p.gainLoss);},0)+
                   APOS.reduce(function(s,p){return s+Math.max(0,p.gainLoss);},0);
    var glEstimada = glActual * Math.pow(1+rent, años) * fracNecesaria;
    var irpfEst = irpf(glEstimada);
    var netoCubrir = importe - irpfEst;

    // DCA adicional necesario si no cubre
    var dcaMensual = 0;
    if (!cubre) {
      var deficit = importe - proyCartera;
      // PMT inverso: cuánto hay que aportar mensualmente para acumular 'deficit' en 'años' años
      var r = rent / 12;
      var n = años * 12;
      dcaMensual = n > 0 && r > 0 ? deficit * r / (Math.pow(1+r, n) - 1) : (n>0 ? deficit/n : deficit);
    }

    return { label:label, importe:importe, cubre:cubre, proyCartera:proyCartera,
             exceso:exceso, irpfEst:irpfEst, netoCubrir:netoCubrir,
             fracNecesaria:fracNecesaria*100, dcaMensual:dcaMensual };
  }

  var cerca = analizar('Universidad cerca de casa', importeCerca);
  var fuera = analizar('Universidad fuera de casa', importeFuera);

  var html = '';

  [cerca, fuera].forEach(function(r) {
    var ok = r.cubre;
    html += '<div class="panel" style="padding:20px 24px;margin-bottom:16px;border:1px solid '+(ok?'rgba(0,229,176,.25)':'rgba(244,63,94,.25)')+'">'+
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">'+
        '<span style="font-size:18px">'+(ok?'✅':'⚠️')+'</span>'+
        '<div>'+
          '<div style="font-size:13px;font-weight:700;color:var(--text)">'+r.label+'</div>'+
          '<div style="font-size:11px;color:var(--mu2)">Objetivo: '+E(r.importe)+' en '+añoInicio+' ('+años+' años)</div>'+
        '</div>'+
      '</div>'+
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">'+
        '<div><div style="font-size:10px;color:var(--mu)">Cartera proyectada</div>'+
          '<div style="font-family:monospace;font-weight:700;color:var(--text)">'+E(Math.round(r.proyCartera))+'</div></div>'+
        '<div><div style="font-size:10px;color:var(--mu)">'+(ok?'Excedente':'Déficit')+'</div>'+
          '<div style="font-family:monospace;font-weight:700;color:'+(ok?'var(--ac)':'var(--red)')+'">'+
            (ok?'+':'')+E(Math.round(Math.abs(r.exceso)))+'</div></div>'+
        '<div><div style="font-size:10px;color:var(--mu)">IRPF estimado liquidación</div>'+
          '<div style="font-family:monospace;font-weight:700;color:var(--red)">-'+E(Math.round(r.irpfEst))+'</div>'+
          '<div style="font-size:9px;color:var(--mu2)">('+r.fracNecesaria.toFixed(0)+'% de la cartera)</div></div>'+
        (ok
          ? '<div><div style="font-size:10px;color:var(--mu)">Cartera restante</div>'+
              '<div style="font-family:monospace;font-weight:700;color:var(--ac)">'+E(Math.round(r.exceso+r.irpfEst > 0 ? r.proyCartera - r.importe : 0))+'</div></div>'
          : '<div><div style="font-size:10px;color:var(--mu)">DCA adicional necesario</div>'+
              '<div style="font-family:monospace;font-weight:700;color:var(--yel)">'+E(Math.round(r.dcaMensual))+'/mes</div></div>'
        )+
      '</div>'+
      (ok
        ? '<div style="font-size:11px;color:var(--mu2);background:rgba(0,229,176,.06);padding:10px 14px;border-radius:8px">'+
            '✓ Con la cartera actual y un '+((rent*100).toFixed(0))+'% de rentabilidad anual, cubrirías el coste sin aportar nada más. '+
            'La liquidación supone aproximadamente el '+r.fracNecesaria.toFixed(0)+'% de la cartera y generaría un IRPF estimado de '+E(Math.round(r.irpfEst))+'.'+
          '</div>'
        : '<div style="font-size:11px;color:var(--mu2);background:rgba(244,63,94,.06);padding:10px 14px;border-radius:8px">'+
            '⚠ La cartera actual no cubre el objetivo. Necesitarías aportar aproximadamente '+E(Math.round(r.dcaMensual))+' adicionales al mes durante '+años+' años, o reducir el objetivo a '+E(Math.round(r.proyCartera - r.irpfEst))+'.'+
          '</div>'
      )+
    '</div>';
  });

  // Comparativa visual
  html += '<div class="panel" style="padding:20px 24px">'+
    '<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mu);margin-bottom:14px">Proyección de la cartera — '+hoy+' → '+añoInicio+'</div>'+
    '<div style="display:flex;flex-direction:column;gap:10px">';

  var maxVal = Math.max(fuera.proyCartera, importeFuera) * 1.05;
  [[tv, 'Valor actual cartera', 'var(--mu2)'],
   [cerca.proyCartera, 'Proyección en '+añoInicio, 'var(--fondos)'],
   [importeCerca, 'Objetivo cerca de casa', 'var(--yel)'],
   [importeFuera, 'Objetivo fuera de casa', 'var(--red)']
  ].forEach(function(row) {
    var pct = Math.min(100, row[0]/maxVal*100);
    html += '<div><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">'+
      '<span style="color:var(--mu2)">'+row[1]+'</span>'+
      '<span style="color:'+row[2]+';font-family:monospace;font-weight:700">'+E(Math.round(row[0]))+'</span></div>'+
      '<div style="height:8px;background:rgba(255,255,255,.05);border-radius:4px">'+
        '<div style="height:100%;width:'+pct+'%;background:'+row[2]+';border-radius:4px;transition:width .4s"></div>'+
      '</div></div>';
  });
  html += '</div></div>';

  document.getElementById('dv-metas-result').innerHTML = html;
}

// ════════════════════════════════════════════════════════════════
//  DESINVERSIÓN — MÓDULO 3: JUBILACIÓN & HERENCIA
// ════════════════════════════════════════════════════════════════
function renderJubilacion() {
  var edadActual = parseInt(document.getElementById('jb-edad').value)  || 40;
  var edadJub    = parseInt(document.getElementById('jb-jub').value)    || 67;
  var pension    = parseFloat(document.getElementById('jb-pension').value) || 1500;
  var gasto      = parseFloat(document.getElementById('jb-gasto').value)   || 2500;
  var rent       = (parseFloat(document.getElementById('jb-rent').value)  || 5) / 100;
  var inf        = (parseFloat(document.getElementById('jb-inf').value)   || 2.5) / 100;
  var dca        = parseFloat(document.getElementById('jb-dca').value)    || 300;
  var objHerencia= parseFloat(document.getElementById('jb-herencia').value)|| 100000;
  var vidaEst    = parseInt(document.getElementById('jb-vida').value)   || 88;

  var tvF = FPOS.reduce(function(s,p){ return s+p.currentValue; }, 0);
  var tvA = APOS.reduce(function(s,p){ return s+p.currentValue; }, 0);
  var tv  = tvF + tvA;

  var añosAcum  = Math.max(0, edadJub - edadActual);
  var añosDesac = Math.max(0, vidaEst - edadJub);
  var rentReal  = (1 + rent) / (1 + inf) - 1;  // rentabilidad real ajustada a inflación

  // ── FASE DE ACUMULACIÓN ──
  // Proyectar cartera con DCA mensual hasta jubilación
  var carteraJub = tv * Math.pow(1+rent, añosAcum);
  var r = rent / 12, n = añosAcum * 12;
  if (r > 0 && n > 0) carteraJub += dca * (Math.pow(1+r,n) - 1) / r;

  // ── FASE DE DESACUMULACIÓN ──
  var retiradaMensual = Math.max(0, gasto - pension);  // lo que pone la cartera
  var retiradaAnual   = retiradaMensual * 12;

  // Ratio de ganancia real de la cartera (sustituye el hardcoded 40%)
  // En jubilación la cartera habrá crecido desde hoy; el coste de adquisición
  // se mantiene, así que el ratio de ganancia sube. Proyectamos el coste base
  // hasta la jubilación (permanece constante — no hay nuevas compras relevantes).
  var _glJubActual  = FPOS.reduce(function(s,p){ return s+Math.max(0,p.gainLoss); }, 0) +
                      APOS.reduce(function(s,p){ return s+Math.max(0,p.gainLoss); }, 0);
  var _costeActual  = Math.max(1, tv - _glJubActual);  // coste de adquisición actual
  // En jubilación el coste base es el mismo, el valor habrá crecido → ratio mayor
  var ratioGanJub   = carteraJub > 0
    ? Math.min(0.95, Math.max(0, (carteraJub - _costeActual) / carteraJub))
    : 0.40;
  // Coste base dinámico: se reduce proporcionalmente en cada retiro
  var costeBaseJub  = carteraJub * (1 - ratioGanJub);

  // Calcular retiro óptimo que no sube de tramo IRPF
  var margenAnual19    = 6000;   // primer tramo
  var retiradaOptima19 = margenAnual19 / Math.max(0.01, ratioGanJub);

  // Simulación año a año
  var rows = [];
  var cartera = carteraJub;
  var costeBase = costeBaseJub;
  var herenciaFinal = 0;
  var agotada = null;

  for (var i = 0; i < añosDesac; i++) {
    var edad = edadJub + i;
    var retInfl = retiradaAnual * Math.pow(1+inf, i);  // retirada ajustada inflación
    var rendimiento = cartera * rent;
    var saldoAnteRetiro = cartera + rendimiento;

    // ¿Cuánto retira? Lo necesario, limitado por cartera disponible
    var retiro = Math.min(retInfl, saldoAnteRetiro);
    cartera = saldoAnteRetiro - retiro;

    // IRPF estimado: ganancia = retiro - proporción de coste recuperado
    // fracción del coste que se "consume" al retirar
    var fracRetiro   = saldoAnteRetiro > 0 ? retiro / saldoAnteRetiro : 0;
    var costeRetirado = Math.min(costeBase, costeBase * fracRetiro);
    costeBase        -= costeRetirado;
    var glEstRetiro  = Math.max(0, retiro - costeRetirado);
    var irpfRetiro   = irpf(glEstRetiro);
    var netoRetiro   = retiro - irpfRetiro;

    rows.push({
      edad: edad, cartera: Math.round(cartera),
      retiro: Math.round(retiro), rendimiento: Math.round(rendimiento),
      irpfRetiro: Math.round(irpfRetiro), netoRetiro: Math.round(netoRetiro),
      ok: cartera > 0
    });

    if (cartera <= 0 && !agotada) agotada = edad;
  }
  herenciaFinal = Math.max(0, cartera);

  // ── KPIs resumen ──
  var cubreGasto = retiradaMensual * 12 <= carteraJub * rent;
  var tasaRetiro = carteraJub > 0 ? (retiradaAnual / carteraJub * 100) : 0;
  var regla4pct  = carteraJub * 0.04;

  var html = '';

  // Resumen acumulación
  html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">';
  [
    { l:'Cartera al jubilarte', v: E(Math.round(carteraJub)), s: 'en '+añosAcum+' años con DCA de '+E(dca)+'/mes', c:'var(--ac)'},
    { l:'Retirada mensual necesaria', v: E(Math.round(retiradaMensual)), s: 'gasto '+E(gasto)+' − pensión '+E(pension), c: retiradaMensual>0?'var(--yel)':'var(--ac)'},
    { l:'Tasa de retiro', v: tasaRetiro.toFixed(1)+'%', s: 'regla 4%: '+E(Math.round(regla4pct/12))+'/mes sostenible', c: tasaRetiro<=4?'var(--ac)':tasaRetiro<=5?'var(--yel)':'var(--red)'},
    { l:'Herencia estimada', v: herenciaFinal>0?E(Math.round(herenciaFinal)):'Cartera agotada', s: agotada?'⚠ agotada a los '+agotada+' años':'a los '+vidaEst+' años', c: herenciaFinal>=objHerencia?'var(--ac)':herenciaFinal>0?'var(--yel)':'var(--red)'}
  ].forEach(function(k){
    html += '<div class="panel" style="padding:14px 16px">'+
      '<div class="klbl">'+k.l+'</div>'+
      '<div class="kval" style="color:'+k.c+'">'+k.v+'</div>'+
      '<div class="ksub" style="color:'+k.c+'55;font-size:10px">'+k.s+'</div>'+
    '</div>';
  });
  html += '</div>';

  // Mensaje clave
  var msgColor = (!agotada && herenciaFinal>=objHerencia) ? 'rgba(0,229,176,.08)' : agotada ? 'rgba(244,63,94,.08)' : 'rgba(245,200,66,.08)';
  var msgBorder = (!agotada && herenciaFinal>=objHerencia) ? 'rgba(0,229,176,.3)' : agotada ? 'rgba(244,63,94,.3)' : 'rgba(245,200,66,.3)';
  var msg = '';
  if (!agotada && herenciaFinal >= objHerencia) {
    msg = '✅ Con los parámetros actuales, la cartera aguanta hasta los '+vidaEst+' años y deja una herencia de '+E(Math.round(herenciaFinal))+
          ', superando tu objetivo de '+E(objHerencia)+'. La tasa de retiro del '+tasaRetiro.toFixed(1)+'% está '+
          (tasaRetiro<=4?'dentro':'cerca')+ ' de la regla del 4%, considerada sostenible indefinidamente.';
  } else if (agotada) {
    msg = '⚠️ Con estos parámetros, la cartera se agota a los '+agotada+' años. Opciones: reducir el gasto mensual en jubilación, aumentar las aportaciones ahora ('+E(dca)+'/mes), o mejorar la rentabilidad esperada.';
  } else {
    msg = '⚠️ La cartera aguanta pero la herencia estimada ('+E(Math.round(herenciaFinal))+') no alcanza el objetivo de '+E(objHerencia)+'. Considera aumentar las aportaciones actuales o reducir el gasto en jubilación.';
  }
  html += '<div class="panel" style="padding:16px 20px;margin-bottom:16px;background:'+msgColor+';border-color:'+msgBorder+'">'+
    '<div style="font-size:12px;color:var(--text);line-height:1.6">'+msg+'</div>'+
    '<div style="font-size:10px;color:var(--mu2);margin-top:8px">Nota: la plusvalía latente acumulada en la cartera en el momento de la herencia queda exenta de IRPF para tu heredera (step-up fiscal). El Impuesto de Sucesiones depende de tu CCAA.</div>'+
  '</div>';

  // Tabla año a año (primeros 20 años o hasta agotamiento)
  var rowsShow = rows.slice(0, 25);
  html += '<div class="panel" style="padding:20px 24px;margin-bottom:16px">'+
    '<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mu);margin-bottom:14px">Proyección año a año — fase jubilación</div>'+
    '<div style="overflow-x:auto"><table class="tbl" style="width:100%"><thead><tr>'+
      '<th>Edad</th><th>Cartera inicio</th><th>Rendimiento</th><th>Retiro</th><th>IRPF est.</th><th>Neto retiro</th><th>Cartera fin</th>'+
    '</tr></thead><tbody>';
  var carteraIter = carteraJub;
  rowsShow.forEach(function(r) {
    var ci = carteraIter;
    carteraIter = r.cartera;
    html += '<tr style="'+(r.cartera<=0?'opacity:.4':'')+'">'+
      '<td class="mono mu">'+r.edad+'</td>'+
      '<td class="mono" style="text-align:right">'+E(Math.round(ci))+'</td>'+
      '<td class="mono" style="text-align:right;color:var(--ac)">+'+E(r.rendimiento)+'</td>'+
      '<td class="mono" style="text-align:right;color:var(--yel)">-'+E(r.retiro)+'</td>'+
      '<td class="mono" style="text-align:right;color:var(--red)">'+(r.irpfRetiro>0?'-'+E(r.irpfRetiro):'—')+'</td>'+
      '<td class="mono" style="text-align:right">'+E(r.netoRetiro)+'</td>'+
      '<td class="mono" style="text-align:right;font-weight:700;color:'+(r.cartera>objHerencia?'var(--ac)':r.cartera>0?'var(--yel)':'var(--red)')+'">'+
        (r.cartera>0?E(r.cartera):'AGOTADA')+'</td>'+
    '</tr>';
  });
  if (rows.length > 25) {
    html += '<tr><td colspan="7" style="text-align:center;color:var(--mu);font-size:11px;padding:8px">… '+
      (rows.length-25)+' años más hasta los '+vidaEst+'</td></tr>';
  }
  html += '</tbody></table></div>';

  // Herencia final
  if (herenciaFinal > 0) {
    html += '<div style="margin-top:12px;padding:12px 16px;background:rgba(0,229,176,.06);border-radius:8px;font-size:11px;color:var(--mu2)">'+
      '<strong style="color:var(--ac)">🏛 Herencia estimada: '+E(Math.round(herenciaFinal))+'</strong> — '+
      'Tu heredera recibe este valor con step-up fiscal (coste de adquisición = valor en fecha de fallecimiento). '+
      'Las plusvalías acumuladas durante toda tu vida de inversor quedan exentas de IRPF. '+
      'Solo tributa por Impuesto de Sucesiones (variable según CCAA).</div>';
  }
  html += '</div>';

  document.getElementById('dv-jub-result').innerHTML = html;
}

// ════════════════════════════════════════════════════════════════
//  CONFIGURACIÓN — cambio de credenciales
// ════════════════════════════════════════════════════════════════
function openCfg() {
  var m = document.getElementById('cfg-modal');
  if (!m) return;
  document.getElementById('cfg-user').value  = '';
  document.getElementById('cfg-pass').value  = '';
  document.getElementById('cfg-pass2').value = '';
  document.getElementById('cfg-msg').textContent = '';
  document.getElementById('cfg-msg').style.color = '';
  resetStep(0);  // resetear zona de peligro al abrir
  m.classList.add('open');
  setTimeout(function(){ document.getElementById('cfg-user').focus(); }, 80);
}

function closeCfg() {
  var m = document.getElementById('cfg-modal');
  if (m) m.classList.remove('open');
}

function saveCfg() {
  var user  = document.getElementById('cfg-user').value.trim();
  var pass  = document.getElementById('cfg-pass').value;
  var pass2 = document.getElementById('cfg-pass2').value;
  var msg   = document.getElementById('cfg-msg');

  function setMsg(txt, ok) {
    msg.textContent = txt;
    msg.style.color = ok ? 'var(--ac)' : 'var(--red)';
  }

  if (!user)           { setMsg('El usuario no puede estar vacío.', false); return; }
  if (pass.length < 6) { setMsg('La contraseña debe tener al menos 6 caracteres.', false); return; }
  if (pass !== pass2)  { setMsg('Las contraseñas no coinciden.', false); return; }

  setMsg('Guardando…', true);

  // Generar hash SHA-256 de "usuario:contraseña"
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(user + ':' + pass))
    .then(function(buf) {
      var newHash = Array.from(new Uint8Array(buf))
        .map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');

      return fetch('guardar.php', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          token:    AUTH_HASH_CLIENT,
          action:   'change_credentials',
          new_hash: newHash
        })
      });
    })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.ok) {
        // Actualizar el hash en memoria — la sesión actual sigue activa
        AUTH_HASH_CLIENT = d.new_hash;
        setMsg('✓ Credenciales actualizadas. La próxima vez usa el nuevo usuario y contraseña.', true);
        setTimeout(closeCfg, 2800);
      } else {
        setMsg('Error: ' + (d.msg || 'desconocido'), false);
      }
    })
    .catch(function(e) {
      setMsg('Error de conexión: ' + e.message, false);
    });
}


function resetStep(n) {
  var steps = document.querySelectorAll('#cfg-reset-steps > div');
  steps.forEach(function(s, i){ s.classList.toggle('active', i === n); });
  if (n === 0) {
    var inp = document.getElementById('cfg-confirm-word');
    if (inp) { inp.value = ''; }
    var btn = document.getElementById('cfg-reset-btn');
    if (btn) btn.disabled = true;
  }
}

function doReset() {
  var word = (document.getElementById('cfg-confirm-word').value || '').trim();
  if (word !== 'BORRAR') return;

  resetStep(2);
  var icon   = document.getElementById('cfg-reset-icon');
  var result = document.getElementById('cfg-reset-result');
  var close  = document.getElementById('cfg-reset-close');

  icon.textContent   = '⏳';
  result.textContent = 'Vaciando datos…';
  result.style.color = 'var(--mu2)';
  if (close) close.style.display = 'none';

  fetch('guardar.php', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ token: AUTH_HASH_CLIENT, action: 'reset_data' })
  })
  .then(function(r){ return r.json(); })
  .then(function(d) {
    if (d.ok) {
      icon.textContent   = '✅';
      result.style.color = 'var(--ac)';
      result.textContent = 'Datos eliminados correctamente. La app se recargará en 3 segundos.';
      if (close) close.style.display = 'block';
      setTimeout(function(){ window.location.reload(); }, 3000);
    } else {
      icon.textContent   = '❌';
      result.style.color = 'var(--red)';
      result.textContent = 'Error: ' + (d.msg || 'desconocido');
      if (close) close.style.display = 'block';
    }
  })
  .catch(function(e) {
    icon.textContent   = '❌';
    result.style.color = 'var(--red)';
    result.textContent = 'Error de conexión: ' + e.message;
    if (close) close.style.display = 'block';
  });
}

// Cerrar con Escape
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    var m = document.getElementById('cfg-modal');
    if (m && m.classList.contains('open')) closeCfg();
  }
});

// ════════════════════════════════════════════════════════════════
//  YAHOO TICKER ACCIONES — save, search, pick
// ════════════════════════════════════════════════════════════════
function saveYahooTickerA(ticker, isin) {
  var inp = document.getElementById('yt-a-' + ticker);
  if (!inp) return;
  var symbol = inp.value.trim();
  fetch('guardar.php', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ token: AUTH_HASH_CLIENT, action: 'save_yahoo_ticker_accion',
                           ticker: ticker, isin: isin || '', yahoo_ticker: symbol })
  })
  .then(function(r){ return r.json(); })
  .then(function(d) {
    if (d.ok) {
      if (isin) YAHOO_GLOBAL[isin] = symbol;
      YAHOO_GLOBAL[ticker] = symbol;
      var rp = APOS_RAW.find(function(p){ return p.ticker===ticker||p.isin===isin; });
      if (rp) rp.yahoo_ticker = symbol;
      inp.style.borderColor = symbol ? 'var(--ac)' : 'rgba(255,77,109,.4)';
      setTimeout(function(){
        inp.style.borderColor = symbol ? 'var(--bd)' : 'rgba(255,77,109,.4)';
        if (symbol) refreshPrices();
      }, 600);
    } else { alert('Error: ' + (d.msg||'desconocido')); }
  }).catch(function(e){ alert('Error: '+e.message); });
}

function searchYahooTickerA(ticker, isin) {
  var inp  = document.getElementById('yt-a-' + ticker);
  var srch = document.getElementById('yt-srch-a-' + ticker);
  if (!inp) return;
  var orig = srch ? srch.innerHTML : '';
  if (srch) { srch.innerHTML = '⏳'; srch.style.pointerEvents = 'none'; }
  inp.style.opacity = '.5';
  fetch('precio.php?action=search&isin=' + encodeURIComponent(isin || ticker))
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (srch) { srch.innerHTML = orig; srch.style.pointerEvents = ''; }
      inp.style.opacity = '1';
      if (d.error || !d.symbol) {
        inp.style.borderColor = 'var(--red)';
        setTimeout(function(){ inp.style.borderColor = 'rgba(255,77,109,.4)'; }, 2500);
        return;
      }
      if (d.all && d.all.length > 1) { _showTickerPickerA(ticker, isin, d.all); }
      else { inp.value = d.symbol; inp.style.borderColor='var(--ac)'; setTimeout(function(){ saveYahooTickerA(ticker,isin); }, 200); }
    })
    .catch(function(){ if(srch){srch.innerHTML=orig;srch.style.pointerEvents='';} inp.style.opacity='1'; });
}

function _showTickerPickerA(ticker, isin, options) {
  var oldP = document.getElementById('yt-picker'); if (oldP) oldP.remove();
  var inp  = document.getElementById('yt-a-' + ticker);
  var rect = inp ? inp.getBoundingClientRect() : {left:100,bottom:100};
  var items = options.map(function(q){
    return '<div onclick="_pickTickerA(\''+ticker+'\',\''+isin+'\',\''+q.symbol+'\')"'+
      ' style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--bd);display:flex;justify-content:space-between;gap:10px"'+
      ' onmouseover="this.style.background=\'var(--s2)\'" onmouseout="this.style.background=\'\'">'+
      '<span style="font-family:monospace;font-weight:700;color:var(--acciones);white-space:nowrap">'+q.symbol+'</span>'+
      '<span style="font-size:11px;color:var(--mu2);flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">'+(q.name||'')+'</span>'+
      '<span style="font-size:10px;color:var(--mu);white-space:nowrap">'+(q.type||'')+'·'+(q.exchange||'')+'</span></div>';
  }).join('');
  var picker = document.createElement('div');
  picker.id = 'yt-picker';
  picker.innerHTML = '<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mu2);padding:8px 12px;border-bottom:1px solid var(--bd)">Selecciona el ticker para '+ticker+'</div>'+items+
    '<div style="padding:6px 12px;text-align:right"><button onclick="document.getElementById(\'yt-picker\').remove()" style="background:none;border:none;color:var(--mu);cursor:pointer;font-size:11px">Cancelar</button></div>';
  picker.style.cssText='position:fixed;z-index:9999;background:var(--s);border:1px solid var(--bd);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);min-width:380px;max-width:500px;left:'+Math.min(rect.left,window.innerWidth-510)+'px;top:'+(rect.bottom+6)+'px';
  document.body.appendChild(picker);
  setTimeout(function(){
    document.addEventListener('click',function _c(e){ var p2=document.getElementById('yt-picker'); if(p2&&!p2.contains(e.target)){p2.remove();document.removeEventListener('click',_c);} });
  },100);
}
function _pickTickerA(ticker,isin,symbol){
  var p=document.getElementById('yt-picker'); if(p) p.remove();
  var inp=document.getElementById('yt-a-'+ticker);
  if(inp){inp.value=symbol;inp.style.borderColor='var(--ac)';}
  saveYahooTickerA(ticker,isin);
}

// ════════════════════════════════════════════════════════════════
//  AUTO-BÚSQUEDA DE TICKERS AL CARGAR (fondos + acciones)
// ════════════════════════════════════════════════════════════════

// Mapa de tickers conocidos para fondos UCITS cuyo ISIN no es buscable en Yahoo.
// Clave: ISIN, Valor: Yahoo Finance ticker.
// Para actualizar: ve a Fondos → tabla de cartera → columna Yahoo Ticker → icono 💾.
// Este mapa actúa de fallback ANTES de la búsqueda en la API, ahorrando una llamada
// y garantizando el ticker correcto para fondos con IDs del tipo 0P*.
// Tickers validados manualmente para fondos UCITS cuyo ISIN no resuelve bien en Yahoo Search.
// La app los usa directamente sin llamar a precio.php?action=search,
// y los guarda en data.json la primera vez que detecta el fondo sin ticker.
var KNOWN_TICKER_OVERRIDES = {
  'FR0000447823': 'FR0000447823.PA',
  'FR0007390174': '0P00017WHL.F',
  'IE00B42W4L06': '0P00009WEM.F',
  'IE000QAZP7L2': '0P0001XF42.F',
  'IE000ZYRH0Q7': '0P0001XF40.F',
};

function autoFetchMissingTickers(onComplete) {
  var missing = [];
  (FPOS_RAW||[]).forEach(function(p){
    if (p.isin && !p.yahoo_ticker) missing.push({key:p.isin,isin:p.isin,type:'fondo'});
  });
  (APOS_RAW||[]).forEach(function(p){
    if (!p.yahoo_ticker) missing.push({key:p.isin||p.ticker,isin:p.isin||'',ticker:p.ticker||'',type:'accion'});
  });
  if (!missing.length) { if (onComplete) onComplete(); return; }
  console.log('[autoTicker] Buscando '+missing.length+' ticker(s) faltantes…');
  var idx=0, saved=0, ambiguous=[], failedIsins=[];
  function next() {
    if (idx >= missing.length) {
      if (saved > 0) { renderFondos(); renderAcciones(); }
      if (ambiguous.length) { _pickQueue(ambiguous, 0, onComplete); }
      else {
        // Mostrar aviso en consola para ISINs que no se resolvieron automáticamente
        if (failedIsins.length) {
          console.warn('[autoTicker] Sin ticker automático para:', failedIsins.join(', '),
            '— Introdúcelo manualmente en Fondos → tabla de cartera → columna "Yahoo Ticker".');
        }
        if (onComplete) onComplete();
      }
      return;
    }
    var item = missing[idx++];

    // 1) Comprobar mapa de overrides conocidos ANTES de llamar a la API
    if (KNOWN_TICKER_OVERRIDES[item.isin]) {
      _autoSave(item, KNOWN_TICKER_OVERRIDES[item.isin], function(){ saved++; setTimeout(next,200); });
      return;
    }

    fetch('precio.php?action=search&isin='+encodeURIComponent(item.key))
      .then(function(r){return r.json();})
      .then(function(d){
        if (!d.error && d.symbol) {
          var opts = d.all || [{symbol:d.symbol}];
          if (opts.length === 1) {
            _autoSave(item, d.symbol, function(){ saved++; setTimeout(next,400); });
          } else { ambiguous.push({item:item,options:opts}); setTimeout(next,400); }
        } else {
          // No encontrado en Yahoo — registrar para aviso al usuario
          failedIsins.push(item.isin || item.ticker || item.key);
          setTimeout(next,400);
        }
      }).catch(function(){ setTimeout(next,400); });
  }
  next();
}

function _autoSave(item, symbol, cb) {
  var action = item.type==='fondo' ? 'save_yahoo_ticker' : 'save_yahoo_ticker_accion';
  var body = {token:AUTH_HASH_CLIENT, action:action, yahoo_ticker:symbol};
  if (item.type==='fondo') { body.isin = item.isin; }
  else { body.ticker = item.ticker||item.isin; body.isin = item.isin||''; }
  fetch('guardar.php',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json();})
    .then(function(d){
      if (d.ok) {
        if (item.isin) YAHOO_GLOBAL[item.isin] = symbol;
        if (item.ticker) YAHOO_GLOBAL[item.ticker] = symbol;
        var rp = item.type==='fondo'
          ? FPOS_RAW.find(function(p){return p.isin===item.isin;})
          : APOS_RAW.find(function(p){return p.ticker===item.ticker||p.isin===item.isin;});
        if (rp) rp.yahoo_ticker = symbol;
        if (item.type==='fondo' && KNOWN_FONDOS[item.isin]) KNOWN_FONDOS[item.isin].yahoo_ticker = symbol;
      }
      if (cb) cb();
    }).catch(function(){ if(cb) cb(); });
}

function _pickQueue(queue, qi, done) {
  if (qi >= queue.length) { if (done) done(); return; }
  var entry = queue[qi], item = entry.item, opts = entry.options;
  var oldP = document.getElementById('yt-picker'); if (oldP) oldP.remove();
  var label = item.type==='fondo'
    ? (KNOWN_FONDOS[item.isin]?KNOWN_FONDOS[item.isin].nombre:item.isin)
    : (item.ticker||item.isin);
  var items = opts.slice(0,6).map(function(q){
    return '<div onclick="window._aqPick(\''+q.symbol+'\')" style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--bd);display:flex;justify-content:space-between;gap:10px" onmouseover="this.style.background=\'var(--s2)\'" onmouseout="this.style.background=\'\'">'+
      '<span style="font-family:monospace;font-weight:700;color:'+(item.type==='fondo'?'var(--fondos)':'var(--acciones)')+';white-space:nowrap">'+q.symbol+'</span>'+
      '<span style="font-size:12px;color:var(--mu2);flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">'+(q.name||'')+'</span>'+
      '<span style="font-size:10px;color:var(--mu);white-space:nowrap">'+(q.type||'')+'·'+(q.exchange||'')+'</span></div>';
  }).join('');
  var picker = document.createElement('div');
  picker.id = 'yt-picker';
  picker.innerHTML = '<div style="font-size:12px;color:var(--mu2);padding:12px 14px 6px;line-height:1.6">'+
    '<strong style="color:var(--text)">Selecciona el ticker para:</strong><br>'+
    '<span style="font-family:monospace;font-size:11px;color:'+(item.type==='fondo'?'var(--fondos)':'var(--acciones)')+'">'+label+'</span>'+
    (qi+1<queue.length?' <span style="color:var(--mu);font-size:10px">(+'+(queue.length-qi-1)+' más)</span>':'')+
    '</div>'+items+
    '<div style="padding:8px 14px;display:flex;justify-content:space-between">'+
      '<button onclick="window._aqSkip()" style="background:none;border:none;color:var(--mu);cursor:pointer;font-size:12px">Saltar</button>'+
      '<span style="font-size:10px;color:var(--mu)">'+(qi+1)+'/'+queue.length+'</span></div>';
  picker.style.cssText='position:fixed;z-index:10001;background:var(--s);border:1px solid var(--bd);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.6);min-width:420px;max-width:540px;left:50%;top:50%;transform:translate(-50%,-50%)';
  document.body.appendChild(picker);
  window._aqPick = function(sym){
    picker.remove(); delete window._aqPick; delete window._aqSkip;
    _autoSave(item, sym, function(){ _pickQueue(queue,qi+1,done); });
  };
  window._aqSkip = function(){
    picker.remove(); delete window._aqPick; delete window._aqSkip;
    _pickQueue(queue,qi+1,done);
  };
}
