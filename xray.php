<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

// Mostrar errores PHP como JSON en lugar de HTML
set_error_handler(function($errno, $errstr, $errfile, $errline) {
    echo json_encode(['ok'=>false,'msg'=>"PHP error $errno: $errstr at line $errline"]);
    exit;
});

try {

$data_file = __DIR__ . '/data.json';
$token = $_POST['token'] ?? '';

if (!file_exists($data_file)) { echo json_encode(['ok'=>false,'msg'=>'data.json no encontrado']); exit; }
$data = json_decode(file_get_contents($data_file), true);
if (!$data) { echo json_encode(['ok'=>false,'msg'=>'data.json invalido']); exit; }
$stored_hash = $data['meta']['auth_hash'] ?? '';
if (!$token || $token !== $stored_hash) { echo json_encode(['ok'=>false,'msg'=>'No autorizado']); exit; }

if (!isset($_FILES['pdf']) || $_FILES['pdf']['error'] !== UPLOAD_ERR_OK) {
    $codes=[1=>'Fichero demasiado grande',4=>'No se subio ningun fichero'];
    echo json_encode(['ok'=>false,'msg'=>$codes[$_FILES['pdf']['error']??0]??'Error al subir']); exit;
}
$tmp  = $_FILES['pdf']['tmp_name'];
$size = $_FILES['pdf']['size'];
if ($size < 500) { echo json_encode(['ok'=>false,'msg'=>'Fichero vacio']); exit; }

// ── Extraccion PDF nativa ───────────────────────────────────────
function extractPdfText($path) {
    $raw = file_get_contents($path);
    preg_match_all('/stream
?
(.*?)
?
endstream/s', $raw, $sm);
    $streams = $sm[1];
    $skipIdx = [];
    foreach ($streams as $i => $s) {
        $dec = @gzuncompress($s) ?: @gzinflate(substr($s, 2)) ?: '';
        if (strpos($dec, 'beginbfchar') !== false) $skipIdx[$i] = true;
    }
    $decodeHex = function($hex) {
        $out = '';
        for ($j = 0; $j < strlen($hex); $j += 4) {
            $code = hexdec(substr($hex, $j, 4));
            if ($code <= 3) { $out .= ' '; continue; }
            $c = $code + 29;
            if ($c >= 32 && $c <= 126) { $out .= chr($c); }
            elseif ($c > 127 && $c <= 255) { $out .= mb_convert_encoding(chr($c), 'UTF-8', 'ISO-8859-1'); }
        }
        return $out;
    };
    $fullText = '';
    foreach ($streams as $i => $s) {
        if (isset($skipIdx[$i])) continue;
        $dec = @gzuncompress($s) ?: @gzinflate(substr($s, 2));
        if (!$dec) continue;
        $pt = '';
        preg_match_all('/\[([^\]]+)\]\s*TJ/', $dec, $tja);
        foreach ($tja[1] as $arr) {
            preg_match_all('/<([0-9A-Fa-f]+)>/', $arr, $hm);
            foreach ($hm[1] as $h) $pt .= $decodeHex($h);
            preg_match_all('/\s(-?\d+)\s/', $arr, $kn);
            foreach ($kn[1] as $k) {
                if ((int)$k < -200 && substr($pt,-1) !== ' ') $pt .= ' ';
            }
        }
        preg_match_all('/<([0-9A-Fa-f]+)>\s*Tj/', $dec, $tjs);
        foreach ($tjs[1] as $h) $pt .= $decodeHex($h);
        if (trim($pt)) $fullText .= $pt . "
";
    }
    return preg_replace('/[ 	]+/', ' ', $fullText);
}

$text = extractPdfText($tmp);

if (strlen(trim($text)) < 100) {
    echo json_encode(['ok'=>false,'msg'=>'No se pudo extraer texto del PDF. Tamanyo: '.$size.' bytes.']); exit;
}
if (stripos($text, 'Morningstar') === false) {
    echo json_encode(['ok'=>false,'msg'=>'El PDF no parece ser un informe Morningstar.']); exit;
}

function pn($s) {
    $s = trim((string)$s);
    if ($s === '' || $s === '-') return null;
    return is_numeric(str_replace(',', '.', $s)) ? floatval(str_replace(',', '.', $s)) : null;
}

$r = [
    'fecha'               => null,
    'distribucion_activos'=> [],
    'exposicion_pais'     => [],
    'regiones'            => [],
    'sectores'            => [],
    'estilo_acciones'     => [],
    'estilo_matriz'       => null,
    'rentabilidades'      => [],
    'riesgo'              => [],
    'posiciones'          => [],
    'top10'               => [],
    'importado_en'        => date('Y-m-d'),
    'metodo'              => 'php_native_hex29',
];

// Fecha
if (preg_match('/Informe\s+a\s+(\d{1,2})\s+(\w+)\s+(\d{4})/u', $text, $m)) {
    $mes=['ene'=>'01','feb'=>'02','mar'=>'03','abr'=>'04','may'=>'05','jun'=>'06',
          'jul'=>'07','ago'=>'08','sep'=>'09','oct'=>'10','nov'=>'11','dic'=>'12'];
    $k = strtolower(substr($m[2],0,3));
    $r['fecha'] = $m[3].'-'.($mes[$k]??'01').'-'.str_pad($m[1],2,'0',STR_PAD_LEFT);
}

// Distribucion activos
foreach (['Acciones'=>'acciones','Obligaciones'=>'obligaciones','Efectivo'=>'efectivo','Otro'=>'otro'] as $label=>$key) {
    if (preg_match('/'.preg_quote($label,'/').'(\d{1,6},\d{2})(\d{1,6},\d{2})/u', $text, $m))
        $r['distribucion_activos'][$key] = ['port'=>pn($m[1]),'ref'=>pn($m[2])];
}

// Paises
$paises = ['Estados Unidos'=>'Estados Unidos','Canad'=>'Canadá','Jap'=>'Japón',
           'China'=>'China','Taiw'=>'Taiwán','Corea'=>'Corea','Reino Unido'=>'Reino Unido',
           'India'=>'India','Australia'=>'Australia','Suiza'=>'Suiza'];
$seenP = [];
foreach ($paises as $partial=>$fullName) {
    if (isset($seenP[$partial])) continue;
    if (preg_match('/'.preg_quote($partial,'/').'[^\d]*(\d{1,6},\d{2})/u', $text, $m)) {
        $r['exposicion_pais'][] = ['pais'=>$fullName,'pct'=>pn($m[1])];
        $seenP[$partial] = true;
    }
}
usort($r['exposicion_pais'], function($a,$b){ return $b['pct'] <=> $a['pct']; });

// Regiones
if (preg_match('/Desglose por regiones(.+?)Sectores de Renta/us', $text, $regM)) {
    $regText = $regM[1];
    $regDefs = [
        ['pat'=>'Europa',                 'key'=>'europa',       'nombre'=>'Europa',              'parent'=>null],
        ['pat'=>'Am',                     'key'=>'america',      'nombre'=>'América',             'parent'=>null],
        ['pat'=>'Asia',                   'key'=>'asia',         'nombre'=>'Asia',                'parent'=>null],
        ['pat'=>'Reino Unido',            'key'=>'eur_ru',       'nombre'=>'Reino Unido',         'parent'=>'europa'],
        ['pat'=>'Europa Occidental- Euro','key'=>'eur_oe',       'nombre'=>'Europa Occ. Euro',    'parent'=>'europa'],
        ['pat'=>'Europa Occidental- No',  'key'=>'eur_one',      'nombre'=>'Europa Occ. No Euro', 'parent'=>'europa'],
        ['pat'=>'Europa Emergente',       'key'=>'eur_em',       'nombre'=>'Europa Emergente',    'parent'=>'europa'],
        ['pat'=>'Oriente Medio',          'key'=>'oriente',      'nombre'=>'Oriente Medio/Africa','parent'=>'europa'],
        ['pat'=>'Estados Unidos',         'key'=>'ame_eeuu',     'nombre'=>'Estados Unidos',      'parent'=>'america'],
        ['pat'=>'Canadá',                 'key'=>'ame_ca',       'nombre'=>'Canadá',              'parent'=>'america'],
        ['pat'=>'Latina',                 'key'=>'ame_lat',      'nombre'=>'América Latina',      'parent'=>'america'],
        ['pat'=>'Jap',                    'key'=>'asi_jp',       'nombre'=>'Japón',               'parent'=>'asia'],
        ['pat'=>'Australasia',            'key'=>'asi_au',       'nombre'=>'Australasia',         'parent'=>'asia'],
        ['pat'=>'Los 4 tigres',           'key'=>'asi_4t',       'nombre'=>'Los 4 tigres',        'parent'=>'asia'],
        ['pat'=>'Ex. 4 tigres',           'key'=>'asi_em',       'nombre'=>'Asia Emergente',      'parent'=>'asia'],
    ];
    foreach ($regDefs as $reg) {
        if (preg_match('/'.preg_quote($reg['pat'],'/').'[^\d]{0,20}?(\d{1,6},\d{2})/u', $regText, $m)) {
            $r['regiones'][] = ['key'=>$reg['key'],'nombre'=>$reg['nombre'],'parent'=>$reg['parent'],'pct'=>pn($m[1])];
        }
    }
}

// Sectores
$sects = ['Materiales'=>['materiales','Materiales Básicos'],'Consumo C'=>['consumo_ciclico','Consumo Cíclico'],
          'Servicios Financieros'=>['financieros','Servicios Financieros'],'Inmobiliario'=>['inmobiliario','Inmobiliario'],
          'Comunicaci'=>['comunicacion','Servicios de Comunicación'],'Energ'=>['energia','Energía'],
          'Industria'=>['industria','Industria'],'Tecnolog'=>['tecnologia','Tecnología'],
          'Consumo Defensivo'=>['consumo_defensivo','Consumo Defensivo'],'Salud'=>['salud','Salud'],
          'Servicios P'=>['servicios_publicos','Servicios Públicos']];
foreach ($sects as $partial=>$info) {
    if (preg_match('/'.preg_quote($partial,'/').'[^\d]*(\d{1,6},\d{2})/u', $text, $m))
        $r['sectores'][$info[0]] = ['nombre'=>$info[1],'pct'=>pn($m[1])];
}

// Estilo acciones
foreach (['Precio/Valor Contable'=>'pvc','Precio/Beneficio'=>'pb','Precio/Cashflow'=>'pcf'] as $l=>$k) {
    if (preg_match('/'.preg_quote($l,'/').'(\d{1,6},\d{2})/u', $text, $m))
        $r['estilo_acciones'][$k] = pn($m[1]);
}

// Estilo matriz 3x3
if (preg_match('/Estilo de inversi.{0,8}?(\d{8,20})/u', $text, $estM)) {
    $digits = $estM[1];
    // Iterar para encontrar 9 numeros 1-2 digitos que sumen ~100
    $found = [];
    $stack = [['pos'=>0,'nums'=>[]]];
    $iters = 0;
    while (!empty($stack) && empty($found) && $iters < 10000) {
        $iters++;
        $frame = array_pop($stack);
        $pos = $frame['pos']; $nums = $frame['nums'];
        $rem = 9 - count($nums);
        if ($rem === 0) {
            if (array_sum($nums) >= 95 && array_sum($nums) <= 105) $found = $nums;
            continue;
        }
        $maxLen = min(2, strlen($digits) - $pos - $rem + 1);
        for ($len = 1; $len <= $maxLen; $len++) {
            $v = intval(substr($digits, $pos, $len));
            if ($v >= 0 && $v <= 100)
                $stack[] = ['pos'=>$pos+$len,'nums'=>array_merge($nums,[$v])];
        }
    }
    if (!empty($found)) {
        $r['estilo_matriz'] = [
            'labels_fila'=>['Grande','Mediana','Pequeña'],
            'labels_col'=>['Valor','Mixto','Crecimiento'],
            'valores'=>[[$found[0],$found[1],$found[2]],[$found[3],$found[4],$found[5]],[$found[6],$found[7],$found[8]]],
        ];
    }
}

// Rentabilidades
if (preg_match('/Rentab\.\s*acum\.\s*%(.+?)Rentab\.\s*por\s*periodos/us', $text, $rsec)) {
    $rt = $rsec[1];
    foreach (['3 meses'=>'3m','6 meses'=>'6m','1 a'=>'1y','3 A'=>'3y','5 A'=>'5y'] as $l=>$k) {
        if (preg_match('/'.preg_quote($l,'/').'[^\d]*(\d{1,6},\d{2})\s*(\d{1,6},\d{2})/u', $rt, $m))
            $r['rentabilidades'][$k] = ['port'=>pn($m[1]),'ref'=>pn($m[2])];
    }
    if (preg_match('/A.o(\d{1,6},\d{2})\s*(\d{1,6},\d{2})/u', $rt, $m))
        $r['rentabilidades']['ytd'] = ['port'=>pn($m[1]),'ref'=>pn($m[2])];
}

// Riesgo
$riskStart = strpos($text, 'Ratio de Sharpe');
if ($riskStart !== false) {
    $riskText = substr($text, max(0,$riskStart-200), 800);
    foreach (['Volatilidad'=>'volatilidad','Media Aritm'=>'media','Ratio de Sharpe'=>'sharpe',
              'Alfa 3a'=>'alfa','Beta'=>'beta','R cuadrado'=>'r2',
              'Ratio de Inform'=>'info_ratio','Tracking Error'=>'tracking_error'] as $l=>$k) {
        if (preg_match('/'.preg_quote($l,'/').'[^\d]*(\d{1,6},\d{2})\s*(\d{1,6},\d{2})/u', $riskText, $m))
            $r['riesgo'][$k] = ['3y'=>pn($m[1]),'5y'=>pn($m[2])];
    }
}

// Posiciones
if (preg_match('/Posiciones de Cartera(.+?)Rentabilidades pasadas/us', $text, $posM)) {
    $posText = $posM[1];
    // Skip lines with header words; nombre must be a real fund name
    $posPattern = '/([A-Z](?!nualizado|astos)[^
]{5,60}?)\s*Fondo\s*\d{1,2}\s*\w+\.\s*\d{4}\s*[-PPPP*?]+\s*((?:(?:\d{1,6},\d{2}|-)\s*){2,7})/u';
    if (preg_match_all($posPattern, $posText, $pm)) {
        for ($i=0; $i<count($pm[1]); $i++) {
            $nombre = trim($pm[1][$i]);
            $nums = [];
            preg_match_all('/\d{1,6},\d{2}/', $pm[2][$i], $nm);
            $nums = $nm[0];
            $isin = null;
            foreach (($data['fondos']['posiciones'] ?? []) as $pos) {
                similar_text(strtolower($nombre), strtolower($pos['nombre']??''), $pct);
                if ($pct > 60) { $isin = $pos['isin']; break; }
            }
            $r['posiciones'][] = [
                'nombre'=>$nombre,'isin'=>$isin,
                'rentab_1y'=>count($nums)>=5?pn($nums[0]):null,
                'rentab_3y'=>count($nums)>=5?pn($nums[1]):null,
                'rentab_5y'=>count($nums)>=5?pn($nums[2]):null,
                'gastos'=>count($nums)>=2?pn($nums[count($nums)-2]):null,
                'peso'=>count($nums)>=1?pn($nums[count($nums)-1]):null,
            ];
        }
    }
}

// Top 10 subyacentes
if (preg_match('/Las 10 principal[^\d]+([\s\S]+?)Rentabilidades pasadas/u', $text, $top10M)) {
    $top10Text = $top10M[1];
    $entries = preg_split('/(?=\d{1,2},\d{2}[A-Z])/', $top10Text);
    foreach ($entries as $entry) {
        $entry = trim($entry);
        if (!$entry) continue;
        if (!preg_match('/^(\d{1,2},\d{2})/', $entry, $pctM)) continue;
        $pct = pn($pctM[1]);
        if (!$pct) continue;
        $tipo = 'Otro';
        if (strpos($entry, 'Bono') !== false) $tipo = 'Bono';
        elseif (strpos($entry, 'Acci') !== false) $tipo = 'Accion';
        $nombre = preg_replace('/^\d{1,2},\d{2}/', '', $entry);
        $nombre = preg_replace('/(Bono|Acci.n).*/us', '', $nombre);
        $nombre = trim(preg_replace('/\s+/', ' ', $nombre));
        if (strlen($nombre) < 2) continue;
        $r['top10'][] = ['pct'=>$pct,'nombre'=>$nombre,'tipo'=>$tipo];
        if (count($r['top10']) >= 10) break;
    }
}

// Guardar
$data['xray'] = $r;
$saved = file_put_contents($data_file, json_encode($data, JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE));
if ($saved === false) {
    echo json_encode(['ok'=>false,'msg'=>'No se pudo guardar data.json']); exit;
}
echo json_encode(['ok'=>true,'data'=>$r]);

} catch (Exception $e) {
    echo json_encode(['ok'=>false,'msg'=>'Exception: '.$e->getMessage()]);
}
