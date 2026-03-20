<?php
header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json');


// ── BÚSQUEDA DE TICKER POR ISIN ─────────────────────────────────
$action = $_GET['action'] ?? '';
if ($action === 'search') {
    $isin = trim($_GET['isin'] ?? '');
    if (!$isin || !preg_match('/^[A-Z]{2}[A-Z0-9]{10}$/', $isin)) {
        echo json_encode(['error' => 'ISIN inválido']); exit;
    }

    $searchUrl = 'https://query2.finance.yahoo.com/v1/finance/search?q=' . urlencode($isin)
               . '&quotesCount=8&newsCount=0&listsCount=0&enableFuzzyQuery=false';

    $ctx = stream_context_create(['http' => [
        'header'        => "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\nAccept: application/json\r\n",
        'timeout'       => 8,
        'ignore_errors' => true,
    ]]);

    $raw = @file_get_contents($searchUrl, false, $ctx);
    if (!$raw) { echo json_encode(['error' => 'No se pudo contactar Yahoo Finance']); exit; }

    $data = json_decode($raw, true);
    $quotes = $data['quotes'] ?? [];

    if (empty($quotes)) { echo json_encode(['error' => 'No se encontraron resultados', 'isin' => $isin]); exit; }

    // Preferir tipos MUTUALFUND o ETF, luego EQUITY
    $preferred = array_filter($quotes, function($q) {
        return in_array($q['quoteType'] ?? '', ['MUTUALFUND', 'ETF', 'EQUITY']);
    });
    if (empty($preferred)) $preferred = $quotes;

    // Ordenar: primero los que tienen el ISIN en el símbolo, luego MUTUALFUND > ETF > EQUITY
    usort($preferred, function($a, $b) use ($isin) {
        $typeOrder = ['MUTUALFUND' => 0, 'ETF' => 1, 'EQUITY' => 2];
        $aT = $typeOrder[$a['quoteType'] ?? ''] ?? 3;
        $bT = $typeOrder[$b['quoteType'] ?? ''] ?? 3;
        if ($aT !== $bT) return $aT - $bT;
        return 0;
    });

    $best = array_values($preferred)[0];
    echo json_encode([
        'symbol'    => $best['symbol']    ?? '',
        'name'      => $best['longname']  ?? $best['shortname'] ?? '',
        'type'      => $best['quoteType'] ?? '',
        'exchange'  => $best['exchange']  ?? '',
        'isin'      => $isin,
        'all'       => array_map(function($q) {
            return [
                'symbol'   => $q['symbol']   ?? '',
                'name'     => $q['longname'] ?? $q['shortname'] ?? '',
                'type'     => $q['quoteType'] ?? '',
                'exchange' => $q['exchange']  ?? '',
            ];
        }, array_slice(array_values($preferred), 0, 5)),
    ]);
    exit;
}

function findCC($ts,$cs,$tgt){
  $b=null; $bd=PHP_INT_MAX;
  for($i=0;$i<count($cs);$i++){
    if($cs[$i]===null||$ts[$i]===null) continue;
    if($ts[$i]>$tgt) continue;
    $d=abs($ts[$i]-$tgt);
    if($d<$bd){ $bd=$d; $b=$cs[$i]; }
  }
  return $b;
}

$symbol = $_GET['s'] ?? '';
if (!$symbol) { echo json_encode(['error' => 'no symbol']); exit; }

// Whitelist dinamica desde data.json — cualquier yahoo_ticker registrado queda autorizado
// Indices de benchmark — isin=null: Yahoo directo (sin fallback FT)
$symbols = [
    'EURUSD=X'    => null,   // Tipo de cambio EUR/USD
    '^GSPC'       => null,   // S&P 500
    'URTH'        => null,   // MSCI World ETF (iShares)
    '^IBEX'       => null,   // IBEX 35
    '^STOXX50E'   => null,   // Euro Stoxx 50
    'GC=F'        => null,   // Oro (futuros)
    '^NDX'        => null,   // Nasdaq 100
];
$data_file = __DIR__ . '/data.json';
if (file_exists($data_file)) {
    $djson = json_decode(file_get_contents($data_file), true);
    foreach (($djson['fondos']['posiciones'] ?? []) as $pos) {
        if (!empty($pos['yahoo_ticker']) && !empty($pos['isin']))
            $symbols[$pos['yahoo_ticker']] = $pos['isin'];
    }
    foreach (($djson['acciones']['posiciones'] ?? []) as $pos) {
        if (!empty($pos['yahoo_ticker']))
            $symbols[$pos['yahoo_ticker']] = null;
    }
}

if (!array_key_exists($symbol, $symbols)) {
    echo json_encode(['error' => 'symbol not allowed', 'symbol' => $symbol]);
    exit;
}

$isin = $symbols[$symbol];

if ($isin) {
    $ft_url = 'https://markets.ft.com/data/funds/tearsheet/summary?s=' . $isin . ':EUR';
    $ctx = stream_context_create(['http' => [
        'header' => implode("\r\n", [
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language: en-US,en;q=0.9',
        ]),
        'timeout' => 10,
        'ignore_errors' => true,
    ]]);

    $html = @file_get_contents($ft_url, false, $ctx);
    if ($html && strlen($html) > 1000) {
        $price = null;
        $date  = null;

        // Extract price
        $price_patterns = [
            '/"price"\s*:\s*\{[^}]*"value"\s*:\s*"?([\d.]+)"?/i',
            '/"lastPrice"\s*:\s*([\d.]+)/',
            '/class="mod-ui-data-list__value"[^>]*>\s*([\d,]+\.?\d*)/',
            '/"price"\s*:\s*([\d.]+)/',
        ];
        foreach ($price_patterns as $pat) {
            if (preg_match($pat, $html, $m)) {
                $p = floatval(str_replace(',', '', $m[1]));
                if ($p > 0.01) { $price = $p; break; }
            }
        }

        // Extract date - FT shows "as of Mon DD YYYY" or "as of Mon DD, YYYY"
        $date_patterns = [
            '/as of\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i',
            '/data[- ]as[- ]of[^"]*"([^"]+)"/i',
            '/"dataAsOf"\s*:\s*"([^"]+)"/i',
            '/as\s+of\s+(\w+\s+\d{1,2}\s+\d{4})/i',
        ];
        foreach ($date_patterns as $pat) {
            if (preg_match($pat, $html, $m)) {
                $raw = trim($m[1]);
                // Parse to Y-m-d
                $ts = strtotime($raw);
                if ($ts) { $date = date('Y-m-d', $ts); break; }
            }
        }

        if ($price) {
            // Try to get prev_close from Yahoo even for FT funds
            $prev_close = null;
            $yahoo_sym  = array_search($isin, $symbols);
            if ($yahoo_sym) {
                $yurl = 'https://query1.finance.yahoo.com/v8/finance/chart/' . urlencode($yahoo_sym) . '?interval=1d&range=2y';
                $yctx = stream_context_create(['http' => [
                    'header'  => "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n",
                    'timeout' => 8,
                    'ignore_errors' => true,
                ]]);
                $yraw = @file_get_contents($yurl, false, $yctx);
                if ($yraw) {
                    $ydata   = json_decode($yraw, true);
                    $ycloses = $ydata['chart']['result'][0]['indicators']['quote'][0]['close'] ?? [];
                    $lastIdx = null;
                    for ($i = count($ycloses)-1; $i >= 0; $i--) {
                        if ($ycloses[$i] !== null) {
                            if ($lastIdx === null) { $lastIdx = $i; }
                            else { $prev_close = $ycloses[$i]; break; }
                        }
                    }
                }
            }
            // Extract hist from Yahoo data already fetched
            $ft_hist = null;
            if (isset($ydata)) {
                $yts = $ydata['chart']['result'][0]['timestamp'] ?? [];
                $ycs = $ydata['chart']['result'][0]['indicators']['quote'][0]['close'] ?? [];
                $now2 = time();
                $ft_hist = ['1w'=>findCC($yts,$ycs,$now2-7*86400),'1m'=>findCC($yts,$ycs,$now2-30*86400),'3m'=>findCC($yts,$ycs,$now2-91*86400),'1y'=>findCC($yts,$ycs,$now2-365*86400)];
            }
            echo json_encode([
                'symbol'     => $symbol,
                'price'      => $price,
                'prev_close' => $prev_close,
                'date'       => $date ?? date('Y-m-d'),
                'date_raw'   => $date ? null : 'date not found',
                'source'     => 'ft',
                'currency'   => 'EUR',
                'hist'       => $ft_hist
            ]);
            exit;
        }
    }
}

// Yahoo Finance chart range=2y (precio + historial + prev_close)
$yahoo_url = 'https://query1.finance.yahoo.com/v8/finance/chart/' . urlencode($symbol) . '?interval=1d&range=2y';
$ctx2 = stream_context_create(['http' => [
    'header' => "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n",
    'timeout' => 12,
    'ignore_errors' => true,
]]);

$raw = @file_get_contents($yahoo_url, false, $ctx2);
if (!$raw) { echo json_encode(['error' => 'fetch failed', 'symbol' => $symbol]); exit; }

$data = json_decode($raw, true);
$meta = $data['chart']['result'][0]['meta'] ?? null;
if (!$meta) { echo json_encode(['error' => 'no data', 'symbol' => $symbol]); exit; }

$timestamps = $data['chart']['result'][0]['timestamp'] ?? [];
$closes     = $data['chart']['result'][0]['indicators']['quote'][0]['close'] ?? [];

$lastPrice = null; $lastDate = null; $lastTime = null;
$prevClose = null;
$lastIdx   = null;
for ($i = count($closes)-1; $i >= 0; $i--) {
    if ($closes[$i] !== null) {
        if ($lastIdx === null) {
            $lastIdx   = $i;
            $lastPrice = $closes[$i];
            $lastDate  = date('Y-m-d', $timestamps[$i]);
            $lastTime  = date('H:i', $timestamps[$i]);
        } else {
            $prevClose = $closes[$i];
            break;
        }
    }
}

// Historical prices: find closest close to 1w, 1m, 3m, 1y ago
// findCC: busca el close más cercano anterior a $tgt en arrays de Yahoo
// findCC defined above

function findClosestClose($timestamps, $closes, $targetTs) {
    $best = null; $bestDiff = PHP_INT_MAX;
    for ($i = 0; $i < count($closes); $i++) {
        if ($closes[$i] === null || $timestamps[$i] === null) continue;
        if ($timestamps[$i] > $targetTs) continue; // only past dates
        $diff = abs($timestamps[$i] - $targetTs);
        if ($diff < $bestDiff) { $bestDiff = $diff; $best = $closes[$i]; }
    }
    return $best;
}
$now = time();
$hist = [
    '1w'  => findClosestClose($timestamps, $closes, $now - 7*86400),
    '1m'  => findClosestClose($timestamps, $closes, $now - 30*86400),
    '3m'  => findClosestClose($timestamps, $closes, $now - 91*86400),
    '1y'  => findClosestClose($timestamps, $closes, $now - 365*86400),
];

// Also try regularMarketTime for more precise timestamp
$mktTime = $meta['regularMarketTime'] ?? null;
if ($mktTime) {
    $lastDate = date('Y-m-d', $mktTime);
    $lastTime = date('H:i', $mktTime);
}

echo json_encode([
    'symbol'     => $symbol,
    'price'      => $lastPrice ?? $meta['regularMarketPrice'],
    'prev_close' => $prevClose,
    'date'       => $lastDate ?? date('Y-m-d'),
    'time'       => $lastTime,
    'source'     => 'yahoo',
    'currency'   => $meta['currency'] ?? 'EUR',
    'hist'       => $hist ?? null
]);
