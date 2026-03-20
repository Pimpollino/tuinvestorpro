<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

define('DATA_FILE', __DIR__ . '/data.json');

// Hash de credenciales almacenado en data.json → meta.auth_hash
// Fallback al hash hardcodeado para compatibilidad con instalaciones antiguas
define('HASH_FALLBACK', 'b920988cc2ef76ff726fa53d13598502215935543361aa7557fb984905434a46');  // tuinvestor:12345678 — cambiar tras la instalación con el botón ⚙ → Credenciales

function respond($ok, $msg, $data = []) {
    echo json_encode(array_merge(['ok' => $ok, 'msg' => $msg], $data));
    exit;
}

// Read input
$input = json_decode(file_get_contents('php://input'), true);
if (!$input) respond(false, 'Invalid JSON input');

// Load data.json (necesario para leer el hash)
if (!file_exists(DATA_FILE)) respond(false, 'data.json no encontrado');
$raw  = file_get_contents(DATA_FILE);
$data = json_decode($raw, true);
if (!$data) respond(false, 'Error al parsear data.json');

// Auth check: hash en data.json tiene prioridad sobre el hardcodeado
$stored_hash = $data['meta']['auth_hash'] ?? HASH_FALLBACK;
$token = $input['token'] ?? '';
if ($token !== $stored_hash) respond(false, 'No autorizado');

$action = $input['action'] ?? '';

// ── ADD OPERATION ──────────────────────────────────────────────
if ($action === 'save_bench_config') {
    $config = $input['config'] ?? [];
    // Validar: solo claves de índices conocidos
    $allowed = ['^GSPC', 'URTH', '^IBEX', '^STOXX50E', 'GC=F', '^NDX'];
    $clean = [];
    foreach ($allowed as $sym) {
        if (isset($config[$sym])) $clean[$sym] = (bool)$config[$sym];
    }
    $data['bench_config'] = $clean;
    file_put_contents(DATA_FILE, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    echo json_encode(['ok' => true]);
    exit;
}

if ($action === 'save_fire') {
    $params = $input['params'] ?? [];
    $data['fire'] = [
        'params'     => $params,
        'updated_at' => date('Y-m-d H:i:s'),
    ];
    file_put_contents(DATA_FILE, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    echo json_encode(['ok' => true]);
    exit;
}

if ($action === 'save_rebalanceo') {
    $universe = $input['universe'] ?? [];
    $sum = array_sum(array_column($universe, 'peso_obj'));
    if (abs($sum - 100) > 0.1) {
        echo json_encode(['ok' => false, 'msg' => 'Los pesos deben sumar 100% (suma: '.$sum.')']);
        exit;
    }
    $data['rebalanceo'] = [
        'universe'   => array_map(function($u) {
            return [
                'isin'     => strtoupper(trim($u['isin']   ?? '')),
                'nombre'   => trim($u['nombre']  ?? ''),
                'peso_obj' => floatval($u['peso_obj'] ?? 0),
            ];
        }, $universe),
        'updated_at' => date('Y-m-d H:i:s'),
    ];
    file_put_contents(DATA_FILE, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    echo json_encode(['ok' => true]);
    exit;
}

if ($action === 'add_op') {
    $broker = $input['broker'] ?? ''; // 'fondos' or 'acciones'
    $op     = $input['op']     ?? [];

    if (!$broker || !$op) respond(false, 'Faltan parámetros');
    if (!in_array($broker, ['fondos', 'acciones'])) respond(false, 'Broker inválido');

    // Validate required fields
    if ($broker === 'fondos') {
        if (empty($op['isin']) || empty($op['fecha']) || !isset($op['titulos']) || !isset($op['precio']))
            respond(false, 'Campos obligatorios: isin, fecha, titulos, precio');

        // Bug 1: validar tipo
        $tiposValidosFondos = ['suscripcion', 'reembolso', 'traspaso_entrada', 'traspaso_salida'];
        if (!in_array($op['tipo'] ?? '', $tiposValidosFondos))
            respond(false, 'Tipo de operación inválido: ' . ($op['tipo'] ?? ''));

        // Bug 2: titulos y precio deben ser positivos
        if (floatval($op['titulos']) <= 0 || floatval($op['precio']) <= 0)
            respond(false, 'Títulos y precio deben ser mayores que cero');

        // Bug 3: reembolso/traspaso_salida — verificar participaciones disponibles
        $tipoOp = $op['tipo'];
        if ($tipoOp === 'reembolso' || $tipoOp === 'traspaso_salida') {
            $titulosActuales = 0;
            foreach (($data['fondos']['posiciones'] ?? []) as $pos) {
                if (($pos['isin'] ?? '') === $op['isin']) {
                    $titulosActuales = floatval($pos['titulos'] ?? 0);
                    break;
                }
            }
            if (floatval($op['titulos']) > $titulosActuales + 0.000001)
                respond(false, 'No hay participaciones suficientes. Disponibles: ' . $titulosActuales . ', solicitadas: ' . floatval($op['titulos']));
        }

        // Bug 4: recalcular importe en el servidor, no confiar en el cliente
        $op['importe'] = round(floatval($op['titulos']) * floatval($op['precio']), 6);

        $op['ref'] = 'manual-' . time() . '-' . rand(1000,9999);
        $data['fondos']['operaciones'][] = $op;
    } else {
        if (empty($op['ticker']) || empty($op['fecha']) || !isset($op['titulos']) || !isset($op['precio']))
            respond(false, 'Campos obligatorios: ticker, fecha, titulos, precio');

        $tiposValidosAcciones = ['compra', 'venta', 'dividendo'];
        if (!in_array($op['tipo'] ?? '', $tiposValidosAcciones))
            respond(false, 'Tipo de operación inválido: ' . ($op['tipo'] ?? ''));

        if (floatval($op['titulos']) <= 0 || floatval($op['precio']) <= 0)
            respond(false, 'Títulos y precio deben ser mayores que cero');

        $op['ref'] = 'manual-' . time() . '-' . rand(1000,9999);
        // Preservar fx_aplicado; limpiar fx_pendiente cuando el usuario haya verificado el FX
        if (!empty($op['fx_aplicado'])) {
            $op['fx_aplicado'] = round(floatval($op['fx_aplicado']), 7);
            unset($op['fx_pendiente']);
        }
        $data['acciones']['operaciones'][] = $op;
    }

    // Recalculate position for affected ticker/isin
    if ($broker === 'fondos') {
        $data = recalcFondosPos($data, $op['isin']);
        recalcFondosInvertidoRealTotal($data);
    } else {
        $data = recalcAccionesPos($data, $op['ticker']);
        recalcAccionesRealized($data);
    }

    saveData($data);
    respond(true, 'Operación guardada', ['ref' => $op['ref']]);
}

// ── BULK ADD OPS (importación masiva XLS Inversis) ─────────────



if ($action === 'save_yahoo_ticker_accion') {
    $ticker = trim($input['ticker']       ?? '');
    $isin   = trim($input['isin']         ?? '');
    $symbol = trim($input['yahoo_ticker'] ?? '');
    if (!$ticker) respond(false, 'Ticker requerido');
    $found = false;
    foreach ($data['acciones']['posiciones'] as &$pos) {
        if (($pos['ticker'] ?? '') === $ticker || ($isin && ($pos['isin'] ?? '') === $isin)) {
            $pos['yahoo_ticker'] = $symbol ?: null;
            $found = true; break;
        }
    }
    unset($pos);
    if (!$found) respond(false, 'Posición no encontrada: '.$ticker);
    saveData($data);
    respond(true, 'Yahoo ticker acción actualizado', ['ticker'=>$ticker,'yahoo_ticker'=>$symbol]);
}

if ($action === 'save_yahoo_ticker') {
    $isin   = trim($input['isin']         ?? '');
    $ticker = trim($input['yahoo_ticker'] ?? '');

    if (!$isin) respond(false, 'ISIN requerido');

    // Actualizar en posiciones de fondos
    $found = false;
    foreach ($data['fondos']['posiciones'] as &$pos) {
        if (($pos['isin'] ?? '') === $isin) {
            $pos['yahoo_ticker'] = $ticker ?: null;
            $found = true;
            break;
        }
    }
    unset($pos);

    // Actualizar también en todas las operaciones de ese ISIN
    foreach ($data['fondos']['operaciones'] as &$op) {
        if (($op['isin'] ?? '') === $isin) {
            $op['yahoo_ticker'] = $ticker ?: null;
        }
    }
    unset($op);

    if (!$found) respond(false, 'Posición no encontrada para ISIN: ' . $isin);

    saveData($data);
    respond(true, 'Yahoo ticker actualizado', ['isin' => $isin, 'yahoo_ticker' => $ticker]);
}

if ($action === 'bulk_add_ops_all') {
    $fondosOps   = $input['fondos_ops']   ?? [];
    $accionesOps = $input['acciones_ops'] ?? [];

    $tiposF = ['suscripcion','reembolso','traspaso_entrada','traspaso_salida'];
    $tiposA = ['compra','venta','dividendo'];

    $refsF = [];
    foreach (($data['fondos']['operaciones'] ?? []) as $o) {
        if (!empty($o['ref'])) $refsF[$o['ref']] = true;
    }
    $refsA = [];
    foreach (($data['acciones']['operaciones'] ?? []) as $o) {
        if (!empty($o['ref'])) $refsA[$o['ref']] = true;
    }

    $fAdded = 0; $fSkipped = 0;
    $aAdded = 0; $aSkipped = 0;
    $isinsF = []; $tickersA = [];

    foreach ($fondosOps as $i => $op) {
        $ref   = $op['ref']   ?? '';
        $tipo  = $op['tipo']  ?? '';
        $isin  = $op['isin']  ?? '';
        $fecha = $op['fecha'] ?? '';
        $tit   = floatval($op['titulos'] ?? 0);
        $prec  = floatval($op['precio']  ?? 0);
        if (!$isin || !$fecha || $tit <= 0 || $prec <= 0) { $fSkipped++; continue; }
        if (!in_array($tipo, $tiposF)) { $fSkipped++; continue; }
        if ($ref && isset($refsF[$ref])) { $fSkipped++; continue; }
        $newOp = ['tipo'=>$tipo,'isin'=>$isin,'nombre'=>$op['nombre']??$isin,
                  'fecha'=>$fecha,'titulos'=>$tit,'precio'=>$prec,
                  'importe'=>round($tit*$prec,6),
                  'ref'=>$ref?:('xls-f-'.time().'-'.$i)];
        if (!empty($op['yahoo_ticker'])) $newOp['yahoo_ticker'] = $op['yahoo_ticker'];
        $data['fondos']['operaciones'][] = $newOp;
        if ($ref) $refsF[$ref] = true;
        $isinsF[$isin] = true;
        $fAdded++;
    }

    foreach ($accionesOps as $i => $op) {
        $ref    = $op['ref']    ?? '';
        $tipo   = $op['tipo']   ?? '';
        $ticker = strtoupper($op['ticker'] ?? '');
        $isin   = $op['isin']   ?? '';
        $fecha  = $op['fecha']  ?? '';
        $tit    = floatval($op['titulos'] ?? 0);
        $prec   = floatval($op['precio']  ?? 0);
        $divisa = $op['divisa'] ?? 'EUR';
        if (!$ticker || !$fecha || $tit <= 0 || $prec <= 0) { $aSkipped++; continue; }
        if (!in_array($tipo, $tiposA)) { $aSkipped++; continue; }
        if ($ref && isset($refsA[$ref])) { $aSkipped++; continue; }
        $newOp = ['tipo'=>$tipo,'ticker'=>$ticker,'isin'=>$isin,
                  'nombre'=>$op['nombre']??$ticker,'tipo_activo'=>$op['tipo_activo']??'Accion',
                  'fecha'=>$fecha,'titulos'=>$tit,'precio'=>$prec,'divisa'=>$divisa,
                  'importe'=>round($tit*$prec,6),
                  'ref'=>$ref?:('xls-a-'.time().'-'.$i)];
        // Preservar fx_pendiente para operaciones en divisa extranjera
        if (!empty($op['fx_pendiente'])) $newOp['fx_pendiente'] = true;
        $data['acciones']['operaciones'][] = $newOp;
        if ($ref) $refsA[$ref] = true;
        $tickersA[$ticker] = true;
        $aAdded++;
    }

    foreach (array_keys($isinsF) as $isin) { $data = recalcFondosPos($data, $isin); }
    if ($fAdded > 0) { recalcFondosInvertidoRealTotal($data); recalcReembolsosBroker($data); }
    foreach (array_keys($tickersA) as $ticker) { $data = recalcAccionesPos($data, $ticker); }
    if ($aAdded > 0) { recalcAccionesRealized($data); }

    saveData($data);
    respond(true, 'Importacion completada', [
        'fondos_added'    => $fAdded,   'fondos_skipped'  => $fSkipped,
        'acciones_added'  => $aAdded,   'acciones_skipped'=> $aSkipped,
    ]);
}

if ($action === 'bulk_add_ops') {
    $ops = $input['ops'] ?? [];
    if (empty($ops) || !is_array($ops)) respond(false, 'No se recibieron operaciones');

    $tiposValidos = ['suscripcion', 'reembolso', 'traspaso_entrada', 'traspaso_salida'];
    $added   = 0;
    $skipped = 0;

    // Construir set de refs existentes para deduplicar
    $refsExistentes = [];
    foreach (($data['fondos']['operaciones'] ?? []) as $op) {
        if (!empty($op['ref'])) $refsExistentes[$op['ref']] = true;
    }

    // Mapa ISIN → yahoo_ticker desde posiciones existentes
    $yahooMap = [];
    foreach (($data['fondos']['posiciones'] ?? []) as $pos) {
        if (!empty($pos['isin']) && !empty($pos['yahoo_ticker']))
            $yahooMap[$pos['isin']] = $pos['yahoo_ticker'];
    }

    // Conjunto de ISINs que necesitan recalcularse al final
    $isinsAfectados = [];

    foreach ($ops as $i => $op) {
        $ref   = $op['ref']    ?? '';
        $tipo  = $op['tipo']   ?? '';
        $isin  = $op['isin']   ?? '';
        $fecha = $op['fecha']  ?? '';
        $tit   = floatval($op['titulos'] ?? 0);
        $prec  = floatval($op['precio']  ?? 0);

        if (!$isin || !$fecha || $tit <= 0 || $prec <= 0) { $skipped++; continue; }
        if (!in_array($tipo, $tiposValidos)) { $skipped++; continue; }
        if ($ref && isset($refsExistentes[$ref])) { $skipped++; continue; }

        $newOp = [
            'tipo'    => $tipo,
            'isin'    => $isin,
            'nombre'  => $op['nombre'] ?? $isin,
            'fecha'   => $fecha,
            'titulos' => $tit,
            'precio'  => $prec,
            'importe' => round($tit * $prec, 6),
            'ref'     => $ref ?: ('xls-' . time() . '-' . $i),
        ];
        $yt = $op['yahoo_ticker'] ?? ($yahooMap[$isin] ?? null);
        if ($yt) $newOp['yahoo_ticker'] = $yt;

        $data['fondos']['operaciones'][] = $newOp;
        if ($ref) $refsExistentes[$ref] = true;
        $isinsAfectados[$isin] = true;
        $added++;
    }

    foreach (array_keys($isinsAfectados) as $isin) {
        $data = recalcFondosPos($data, $isin);
    }
    recalcFondosInvertidoRealTotal($data);
    recalcReembolsosBroker($data);

    saveData($data);
    respond(true, 'Importacion completada', [
        'added'   => $added,
        'skipped' => $skipped,
    ]);
}

// ── ADD TRASPASO ────────────────────────────────────────────────
if ($action === 'add_traspaso') {
    $op = $input['op'] ?? [];
    if (empty($op['isin_origen']) || empty($op['isin_destino']) || empty($op['fecha']) ||
        !isset($op['titulos_origen']) || !isset($op['precio_origen']) ||
        !isset($op['titulos_destino']) || !isset($op['precio_destino']))
        respond(false, 'Faltan parámetros del traspaso');

    $ref = 'traspaso-' . time() . '-' . rand(1000,9999);

    $salida = [
        'tipo'         => 'traspaso_salida',
        'isin'         => $op['isin_origen'],
        'nombre'       => $op['nombre_origen']        ?? $op['isin_origen'],
        'yahoo_ticker' => $op['yahoo_ticker_origen']  ?? null,
        'fecha'        => $op['fecha'],
        'titulos'      => floatval($op['titulos_origen']),
        'precio'       => floatval($op['precio_origen']),
        'importe'      => floatval($op['titulos_origen']) * floatval($op['precio_origen']),
        'ref'          => $ref . '-S',
        'traspaso_ref' => $ref,
    ];
    $entrada = [
        'tipo'         => 'traspaso_entrada',
        'isin'         => $op['isin_destino'],
        'nombre'       => $op['nombre_destino']       ?? $op['isin_destino'],
        'yahoo_ticker' => $op['yahoo_ticker_destino'] ?? null,
        'fecha'        => $op['fecha'],
        'titulos'      => floatval($op['titulos_destino']),
        'precio'       => floatval($op['precio_destino']),
        'importe'      => floatval($op['titulos_destino']) * floatval($op['precio_destino']),
        'ref'          => $ref . '-E',
        'traspaso_ref' => $ref,
    ];

    $data['fondos']['operaciones'][] = $salida;
    $data['fondos']['operaciones'][] = $entrada;
    $data = recalcFondosPos($data, $op['isin_origen']);
    $data = recalcFondosPos($data, $op['isin_destino']);
    recalcFondosInvertidoRealTotal($data);

    saveData($data);
    respond(true, 'Traspaso guardado', ['ref' => $ref]);
}

// ── DELETE OPERATION ────────────────────────────────────────────
if ($action === 'delete_op') {
    $broker = $input['broker'] ?? '';
    $ref    = $input['ref']    ?? '';
    if (!$broker || !$ref) respond(false, 'Faltan parámetros');

    $key = $broker === 'fondos' ? 'fondos' : 'acciones';
    $ops = $data[$key]['operaciones'];

    // Find the op to delete
    $toDelete = null;
    foreach ($ops as $op) {
        if (($op['ref'] ?? '') === $ref) { $toDelete = $op; break; }
    }
    if (!$toDelete) respond(false, 'Operación no encontrada');

    // If traspaso, delete both legs
    $traspRef = $toDelete['traspaso_ref'] ?? null;
    if ($traspRef) {
        $data[$key]['operaciones'] = array_values(array_filter($ops, function($o) use ($traspRef) {
            return ($o['traspaso_ref'] ?? '') !== $traspRef;
        }));
    } else {
        $data[$key]['operaciones'] = array_values(array_filter($ops, function($o) use ($ref) {
            return ($o['ref'] ?? '') !== $ref;
        }));
    }

    // Recalc affected position(s)
    if ($broker === 'fondos') {
        // If traspaso, both legs share traspaso_ref — collect all ISINs affected
        $affectedIsin = $toDelete['isin'] ?? '';
        $data = recalcFondosPos($data, $affectedIsin);
        if ($traspRef) {
            // Find the other leg's ISIN (already deleted, use original ops list before filter)
            foreach ($ops as $o) {
                $otherIsin = $o['isin'] ?? '';
                if (($o['traspaso_ref'] ?? '') === $traspRef && $otherIsin !== $affectedIsin) {
                    $data = recalcFondosPos($data, $otherIsin);
                    break;
                }
            }
        }
        recalcFondosInvertidoRealTotal($data);
    } else {
        $data = recalcAccionesPos($data, $toDelete['ticker'] ?? '');
    }

    saveData($data);
    respond(true, 'Operación eliminada');
}


// ── SAVE PRICE SNAPSHOTS ────────────────────────────────────────
if ($action === 'save_prices') {
    $prices = $input['prices'] ?? []; // [{isin, price, date}]
    if (empty($prices)) respond(false, 'No prices provided');

    $today = date('Y-m-d');
    if (!isset($data['price_history'])) $data['price_history'] = [];

    foreach ($prices as $entry) {
        $isin  = $entry['isin']  ?? '';
        $price = floatval($entry['price'] ?? 0);
        $date  = $entry['date']  ?? $today;
        if (!$isin || !$price) continue;

        if (!isset($data['price_history'][$isin])) $data['price_history'][$isin] = [];

        // Only save one snapshot per day per isin
        $exists = false;
        foreach ($data['price_history'][$isin] as &$snap) {
            if ($snap['date'] === $date) { $snap['price'] = $price; $exists = true; break; }
        }
        unset($snap);

        if (!$exists) {
            $data['price_history'][$isin][] = ['date' => $date, 'price' => $price];
        }

        // Keep only last 400 snapshots per isin (> 1 year of daily data)
        if (count($data['price_history'][$isin]) > 400) {
            usort($data['price_history'][$isin], function($a,$b){ return strcmp($a['date'],$b['date']); });
            $data['price_history'][$isin] = array_slice($data['price_history'][$isin], -400);
        }
    }

    // Actualizar precio, valor_mercado, plus_minus y rentabilidad_real en posiciones
    // Para que data.json refleje siempre el NAV más reciente (no solo price_history)
    $priceMap = [];
    foreach ($prices as $entry) {
        $isin  = $entry['isin']  ?? '';
        $price = floatval($entry['price'] ?? 0);
        $date  = $entry['date']  ?? $today;
        $prev = floatval($entry['prev_close'] ?? 0);
        if ($isin && $price) $priceMap[$isin] = ['price' => $price, 'date' => $date, 'prev_close' => $prev];
    }
    foreach ($data['fondos']['posiciones'] as &$pos) {
        $isin = $pos['isin'] ?? '';
        if (!isset($priceMap[$isin])) continue;
        $nav  = $priceMap[$isin]['price'];
        $date = $priceMap[$isin]['date'];
        $pos['precio']        = $nav;
        $pos['valor_mercado'] = round($pos['titulos'] * $nav, 6);
        $pos['plus_minus']    = round($pos['valor_mercado'] - $pos['coste_adq'], 6);
        if (!empty($priceMap[$isin]['prev_close'])) $pos['_prevClose'] = $priceMap[$isin]['prev_close'];
        // fecha_precio: convertir YYYY-MM-DD a DD/MM/YY para consistencia con el broker
        $parts = explode('-', $date);
        if (count($parts) === 3)
            $pos['fecha_precio'] = $parts[2].'/'.$parts[1].'/'.substr($parts[0], 2);
        // rentabilidad_real
        $invR = floatval($pos['invertido_real'] ?? 0) ?: floatval($pos['coste_adq']);
        $pos['rentabilidad_real'] = $invR > 0
            ? round(($pos['valor_mercado'] - $invR) / $invR * 10000) / 100
            : 0;
    }
    unset($pos);
    foreach ($data['acciones']['posiciones'] as &$pos) {
        $isin = $pos['isin'] ?? '';
        if (!isset($priceMap[$isin])) continue;
        $price = $priceMap[$isin]['price'];
        $date  = $priceMap[$isin]['date'];
        $pos['precio'] = $price;
        if (!empty($priceMap[$isin]['prev_close'])) $pos['_prevClose'] = $priceMap[$isin]['prev_close'];
        // valor_mercado en divisa nativa; valor_eur se recalcula con FX del JS — aquí solo precio nativo
        $pos['valor_mercado'] = round($pos['titulos'] * $price, 6);
        // plus_minus en EUR se calcula en JS con FX correcto; aquí dejamos el nativo como referencia
    }
    unset($pos);

    // Save FX rate to data.json fx table (used by getFXPhp for future ops)
    $fxRate = floatval($input['fx'] ?? 0);
    if ($fxRate > 0) {
        if (!isset($data['fx'])) $data['fx'] = [];
        $data['fx'][$today] = $fxRate;
    }

    saveData($data);
    respond(true, 'Snapshots guardados', ['count' => count($prices)]);
}

if ($action === 'change_credentials') {
    $new_hash = trim($input['new_hash'] ?? '');

    // Validar: debe ser SHA-256 hex (64 caracteres, minúsculas)
    if (!preg_match('/^[a-f0-9]{64}$/', $new_hash)) {
        respond(false, 'Hash inválido');
    }

    // Guardar el nuevo hash en data.json → meta.auth_hash
    // No se modifica ningún fichero de código: más robusto y portable
    if (!isset($data['meta'])) $data['meta'] = [];
    $data['meta']['auth_hash'] = $new_hash;

    saveData($data);
    respond(true, 'Credenciales actualizadas', ['new_hash' => $new_hash]);
}

if ($action === 'reset_data') {
    // Estructura vacía — mantiene el esquema pero sin ningún dato personal
    $empty = [
        'meta'    => ['version' => '2.0', 'created' => date('Y-m-d'), 'auth_hash' => ($data['meta']['auth_hash'] ?? HASH_FALLBACK)],
        'fx'      => [],
        'fondos'  => [
            'posiciones'           => [],
            'operaciones'          => [],
            'benchmark'            => [],
            'reembolsos_broker'    => [],
            'invertido_real_total' => 0,
        ],
        'acciones' => [
            'posiciones'     => [],
            'operaciones'    => [],
            'total_realized' => 0,
        ],
        'yahoo_fx_ticker' => 'EURUSD=X',
        'rebalanceo'      => ['universe' => [], 'updated_at' => ''],
        'fire'            => (object)[],
        'bench_config'    => ['^GSPC' => true],
        'xray'            => null,
        'price_history'   => [],
    ];

    // Backup automático antes de borrar
    $backup = DATA_FILE . '.pre-reset.' . date('Ymd-His') . '.bak';
    if (file_exists(DATA_FILE)) copy(DATA_FILE, $backup);

    file_put_contents(DATA_FILE, json_encode($empty, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
    respond(true, 'Datos eliminados correctamente');
}

respond(false, 'Acción desconocida: ' . $action);

// ── HELPERS ─────────────────────────────────────────────────────

function saveData($data) {
    // Trim price_history to max 400 per ISIN (clean up any legacy bloat)
    if (isset($data['price_history'])) {
        foreach ($data['price_history'] as $isin => &$snaps) {
            if (count($snaps) > 400) {
                usort($snaps, function($a,$b){ return strcmp($a['date'],$b['date']); });
                $snaps = array_slice($snaps, -400);
            }
        }
        unset($snaps);
    }
    // Backup first
    $backup = DATA_FILE . '.bak';
    if (file_exists(DATA_FILE)) copy(DATA_FILE, $backup);
    file_put_contents(DATA_FILE, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

function recalcFondosPos(&$data, $isin) {
    if (!$isin) return $data;
    $ops = array_filter($data['fondos']['operaciones'], function($o) use ($isin) {
        return ($o['isin'] ?? '') === $isin;
    });

    // Precio medio ponderado (metodo broker Inversis)
    $titulos = 0; $coste_total = 0;
    $invertido_real = 0;
    usort($ops, function($a,$b){ return strcmp($a['fecha'],$b['fecha']); });

    foreach ($ops as $op) {
        $tipo  = $op['tipo'] ?? '';
        $qty   = floatval($op['titulos'] ?? 0);
        $price = floatval($op['precio']  ?? 0);

        if ($tipo === 'suscripcion') {
            $coste_total    += $qty * $price;
            $titulos        += $qty;
            $invertido_real += $qty * $price;
        } elseif ($tipo === 'traspaso_entrada') {
            $coste_total += $qty * $price;
            $titulos     += $qty;
        } elseif (in_array($tipo, ['reembolso', 'traspaso_salida'])) {
            $precio_medio = $titulos > 0 ? $coste_total / $titulos : $price;
            $inv_medio    = $titulos > 0 ? $invertido_real / $titulos : 0;
            $coste_total    -= $qty * $precio_medio;
            $invertido_real -= $qty * $inv_medio;
            $titulos        -= $qty;
        }
    }

    $titulos        = max(0, round($titulos, 6));
    $coste_total    = max(0, round($coste_total, 2));
    $invertido_real = max(0, round($invertido_real, 2));
    $coste_medio    = $titulos > 0 ? round($coste_total / $titulos, 4) : 0;

    // Update position
    $found = false;
    foreach ($data['fondos']['posiciones'] as &$pos) {
        if (($pos['isin'] ?? '') === $isin) {
            $vm = $pos['valor_mercado'] ?? $coste_total;
            $pos['titulos']            = $titulos;
            $pos['coste_adq']          = $coste_total;
            $pos['coste_medio']        = $coste_medio;
            $pos['plus_minus']         = round($vm - $coste_total, 2);
            $pos['invertido_real']     = $invertido_real;
            // rentabilidad_real: siempre vs coste_adq (base económica correcta)
            $pos['rentabilidad_real']  = $coste_total > 0
                ? round(($vm - $coste_total) / $coste_total * 100, 2) : 0;
            $pos['pm_real']            = round($vm - $invertido_real - ($vm - $coste_total), 2);
            $found = true;
            break;
        }
    }
    unset($pos);

    // If not found and titulos > 0, create new position
    if (!$found && $titulos > 0) {
        // Recuperar metadatos de la primera operacion de este ISIN
        $metaOp = null;
        foreach ($data['fondos']['operaciones'] as $o) {
            if (($o['isin'] ?? '') === $isin) { $metaOp = $o; break; }
        }
        $data['fondos']['posiciones'][] = [
            'ticker'            => $isin,
            'nombre'            => $metaOp['nombre']       ?? $isin,
            'isin'              => $isin,
            'yahoo_ticker'      => $metaOp['yahoo_ticker'] ?? null,
            'titulos'           => $titulos,
            'coste_medio'       => $coste_medio,
            'precio'            => $coste_medio,
            'fecha_precio'      => date('d/m/Y'),
            'coste_adq'         => $coste_total,
            'valor_mercado'     => $coste_total,
            'plus_minus'        => 0,
            'invertido_real'    => $coste_total,
            'rentabilidad_real' => 0,
            'pm_real'           => 0,
        ];
    }

    // Remove position if titulos = 0
    if ($titulos <= 0) {
        $data['fondos']['posiciones'] = array_values(array_filter(
            $data['fondos']['posiciones'],
            function($p) use ($isin) { return ($p['isin'] ?? '') !== $isin; }
        ));
    }

    return $data;
}

function recalcAccionesPos(&$data, $ticker) {
    if (!$ticker) return $data;
    $ops = array_filter($data['acciones']['operaciones'], function($o) use ($ticker) {
        return ($o['ticker'] ?? '') === $ticker && in_array($o['tipo']??'', ['compra','venta']);
    });

    $titulos = 0; $coste_total = 0; $lots = [];
    usort($ops, function($a,$b){ return strcmp($a['fecha'],$b['fecha']); });

    foreach ($ops as $op) {
        $qty  = floatval($op['titulos'] ?? 0);
        $price= floatval($op['precio']  ?? 0);
        $div  = $op['divisa'] ?? 'EUR';
        $fecha= $op['fecha']  ?? '';
        // Usar op['importe'] directamente: el cliente ya lo convierte a EUR
        // con el FX real del broker (fx_aplicado) o el FX del BCE (FX_TABLE).
        // Solo recalcular desde precio+FX si importe no existe (datos legacy).
        $importeEur = floatval($op['importe'] ?? 0);
        if ($importeEur <= 0) {
            $importeEur = $div === 'EUR'
                ? $qty * $price
                : $qty * $price / getFXPhp($data, $fecha);
        }
        $priceEur = $qty > 0 ? $importeEur / $qty : 0;

        if ($op['tipo'] === 'compra') {
            $lots[] = ['qty'=>$qty,'priceEur'=>$priceEur];
            $titulos    += $qty;
            $coste_total += $importeEur;
        } elseif ($op['tipo'] === 'venta') {
            $rem = $qty;
            while ($rem > 0.00001 && count($lots) > 0) {
                $use = min($rem, $lots[0]['qty']);
                $coste_total -= $use * $lots[0]['priceEur'];
                $lots[0]['qty'] -= $use;
                $rem -= $use;
                if ($lots[0]['qty'] < 0.00001) array_shift($lots);
            }
            $titulos -= $qty;
        }
    }

    $titulos     = max(0, round($titulos, 6));
    $coste_total = max(0, round($coste_total, 2));
    $coste_medio = $titulos > 0 ? round($coste_total / $titulos, 4) : 0;

    $found = false;
    foreach ($data['acciones']['posiciones'] as &$pos) {
        if (($pos['ticker'] ?? '') === $ticker) {
            $pos['titulos']    = $titulos;
            $pos['coste_adq']  = $coste_total;
            $pos['coste_medio']= $coste_medio;
            $pos['plus_minus'] = round($pos['valor_eur'] - $coste_total, 2);
            // Rellenar yahoo_ticker si faltaba
            if (empty($pos['yahoo_ticker'])) {
                $metaOp = null;
                foreach ($data['acciones']['operaciones'] as $o) {
                    if (($o['ticker'] ?? '') === $ticker && !empty($o['yahoo_ticker'])) {
                        $metaOp = $o; break;
                    }
                }
                if ($metaOp) $pos['yahoo_ticker'] = $metaOp['yahoo_ticker'];
            }
            $found = true;
            break;
        }
    }
    unset($pos);

    // Si la posicion no existe, crearla con todos los metadatos
    if (!$found && $titulos > 0) {
        $metaOp = null;
        foreach ($data['acciones']['operaciones'] as $o) {
            if (($o['ticker'] ?? '') === $ticker) { $metaOp = $o; break; }
        }
        $data['acciones']['posiciones'][] = [
            'ticker'       => $ticker,
            'nombre'       => $metaOp['nombre']       ?? $ticker,
            'isin'         => $metaOp['isin']         ?? '',
            'yahoo_ticker' => $metaOp['yahoo_ticker'] ?? null,
            'divisa'       => $metaOp['divisa']       ?? 'EUR',
            'titulos'      => $titulos,
            'coste_medio'  => $coste_medio,
            'precio'       => $coste_medio,
            'coste_adq'    => $coste_total,
            'valor_mercado'=> $coste_total,
            'valor_eur'    => $coste_total,
            'plus_minus'   => 0,
        ];
    }

    if ($titulos <= 0) {
        $data['acciones']['posiciones'] = array_values(array_filter(
            $data['acciones']['posiciones'],
            function($p) use ($ticker) { return ($p['ticker'] ?? '') !== $ticker; }
        ));
    }

    return $data;
}


function recalcReembolsosBroker(&$data) {
    $ops = $data['fondos']['operaciones'] ?? [];
    usort($ops, function($a, $b) { return strcmp($a['fecha'] ?? '', $b['fecha'] ?? ''); });
    $lots = []; $reembolsos = [];
    foreach ($ops as $o) {
        $isin  = $o['isin']   ?? ''; $tipo  = $o['tipo']   ?? '';
        $qty   = floatval($o['titulos'] ?? 0); $price = floatval($o['precio']  ?? 0);
        if (!isset($lots[$isin])) $lots[$isin] = [];
        if ($tipo === 'suscripcion' || $tipo === 'traspaso_entrada') {
            $lots[$isin][] = ['qty' => $qty, 'price' => $price];
        } elseif ($tipo === 'reembolso') {
            $rem = $qty; $costFifo = 0.0;
            while ($rem > 0.0000001 && !empty($lots[$isin])) {
                $use = min($rem, $lots[$isin][0]['qty']);
                $costFifo += $use * $lots[$isin][0]['price'];
                $lots[$isin][0]['qty'] -= $use; $rem -= $use;
                if ($lots[$isin][0]['qty'] < 0.0000001) array_shift($lots[$isin]);
            }
            $saleVal = round($qty * $price, 6);
            $reembolsos[] = [
                'isin'    => $isin,   'ticker'  => $isin,
                'nombre'  => $o['nombre'] ?? $isin,
                'fecha'   => $o['fecha']  ?? '', 'titulos' => $qty,
                'precio'  => $price,  'importe' => $saleVal,
                'coste'   => round($costFifo, 6),
                'gain'    => round($saleVal - $costFifo, 2),
                'ref'     => $o['ref'] ?? '',
            ];
        } elseif ($tipo === 'traspaso_salida') {
            $rem = $qty;
            while ($rem > 0.0000001 && !empty($lots[$isin])) {
                $use = min($rem, $lots[$isin][0]['qty']);
                $lots[$isin][0]['qty'] -= $use; $rem -= $use;
                if ($lots[$isin][0]['qty'] < 0.0000001) array_shift($lots[$isin]);
            }
        }
    }
    $data['fondos']['reembolsos_broker'] = $reembolsos;
}

function recalcFondosInvertidoRealTotal(&$data) {
    $suscrito = 0.0; $reembolsado = 0.0;
    foreach ($data['fondos']['operaciones'] ?? [] as $o) {
        $tipo = $o['tipo'] ?? ''; $importe = floatval($o['importe'] ?? 0);
        if ($tipo === 'suscripcion') $suscrito    += $importe;
        if ($tipo === 'reembolso')   $reembolsado += $importe;
    }
    $data['fondos']['invertido_real_total'] = round($suscrito - $reembolsado, 2);
}

function recalcAccionesRealized(&$data) {
    $ops = array_filter($data['acciones']['operaciones'] ?? [], function($o) {
        return in_array($o['tipo'] ?? '', ['compra', 'venta']);
    });
    usort($ops, function($a, $b) { return strcmp($a['fecha'], $b['fecha']); });
    $lots = []; $total = 0.0;
    foreach ($ops as $o) {
        $t = $o['ticker'] ?? ''; $q = floatval($o['titulos'] ?? 0);
        $p = floatval($o['precio'] ?? 0); $div = $o['divisa'] ?? 'EUR'; $fecha = $o['fecha'] ?? '';
        // Usar importe directamente (ya en EUR desde el cliente)
        $impEur = floatval($o['importe'] ?? 0);
        if ($impEur <= 0) {
            $impEur = $div === 'EUR' ? $q * $p : $q * $p / getFXPhp($data, $fecha);
        }
        $pEur = $q > 0 ? $impEur / $q : 0;
        if (!isset($lots[$t])) $lots[$t] = [];
        if ($o['tipo'] === 'compra') {
            $lots[$t][] = ['q' => $q, 'pEur' => $pEur];
        } elseif ($o['tipo'] === 'venta') {
            $rem = $q; $cost = 0.0;
            while ($rem > 0.00001 && count($lots[$t]) > 0) {
                $use = min($rem, $lots[$t][0]['q']);
                $cost += $use * $lots[$t][0]['pEur'];
                $lots[$t][0]['q'] -= $use; $rem -= $use;
                if ($lots[$t][0]['q'] < 0.00001) array_shift($lots[$t]);
            }
            $saleEur = $impEur;  // venta: importe ya en EUR
            $total += $saleEur - $cost;
        }
    }
    $data['acciones']['total_realized'] = round($total, 2);
}


function getFXPhp($data, $fecha, $divisa = 'USD') {
    // Only USD→EUR implemented. For other currencies (GBP, CHF...) add separate tables.
    $fx = $data['fx'] ?? [];
    if (isset($fx[$fecha])) return $fx[$fecha];
    if (empty($fx)) return 1.08;
    $closest = null; $minDiff = PHP_INT_MAX;
    foreach ($fx as $d => $r) {
        $diff = abs(strtotime($d) - strtotime($fecha));
        if ($diff < $minDiff) { $minDiff = $diff; $closest = $r; }
    }
    return $closest ?? 1.08;
}
