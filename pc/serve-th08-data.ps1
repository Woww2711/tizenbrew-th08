# Serves the TH08 data files (th08.dat, thbgm.dat) to the TV once, over the LAN.
# Windows PowerShell 5.1. TcpListener needs no admin rights (HttpListener would need urlacl).
# Usage:  powershell -ExecutionPolicy Bypass -File serve-th08-data.ps1 [-DataDir E:\th08-tv]
#         [-Address 192.168.1.10] [-Port 8765] [-Token <digits>]     Stop with Ctrl+C.
# Routes (GET only, ?t=<token> required): /manifest.json, /th08.dat, /thbgm.dat (spec section 3.1).
param(
  [string]$DataDir = 'E:\th08-tv',
  [string]$Address = '192.168.1.10',
  [int]$Port = 8765,
  [string]$Token = '',
  [int]$HeaderTimeoutMs = 5000   # time a client has to send the request head
)
$ErrorActionPreference = 'Stop'
$Names = @('th08.dat', 'thbgm.dat')
$HeaderLimit = 8192          # bytes of request head accepted
$SendTimeoutMs = 30000       # a client that stops reading is dropped after this

function Write-Log([string]$text) { Write-Host ((Get-Date).ToString('HH:mm:ss') + ' ' + $text) }

# 8 random digits: typed with the number keys of the TV remote.
if (-not $Token) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 4
  $rng.GetBytes($bytes)
  $Token = ([BitConverter]::ToUInt32($bytes, 0) % 100000000).ToString('D8')
}

# Size and SHA-256 of both files, once at start.
$Files = @{}
$entries = @()
foreach ($name in $Names) {
  $p = Join-Path $DataDir $name
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "missing file: $p" }
  Write-Log "hashing $p ..."
  $size = (Get-Item -LiteralPath $p).Length
  $hash = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
  $Files['/' + $name] = @{ path = $p; size = [int64]$size }
  $entries += '{"name":"' + $name + '","size":' + $size + ',"sha256":"' + $hash + '"}'
  Write-Log "  $name  $size bytes  sha256 $hash"
}
$Manifest = '{"files":[' + ($entries -join ',') + ']}'

# The request head (up to the blank line), or $null if it is too large, too slow or cut.
function Read-Head($stream) {
  $buf = New-Object byte[] $HeaderLimit
  $n = 0
  $deadline = [DateTime]::UtcNow.AddMilliseconds($HeaderTimeoutMs)
  while ($n -lt $HeaderLimit) {
    $left = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($left -le 0) { return $null }
    $stream.ReadTimeout = [int][Math]::Max(1, $left)
    try { $k = $stream.Read($buf, $n, $HeaderLimit - $n) } catch { return $null }
    if ($k -le 0) { return $null }
    $n += $k
    $text = [Text.Encoding]::ASCII.GetString($buf, 0, $n)
    $end = $text.IndexOf("`r`n`r`n")
    if ($end -ge 0) { return $text.Substring(0, $end) }
  }
  return $null
}

function Send-Head($stream, [int]$code, [string]$reason, [string]$type, [int64]$length) {
  $h = "HTTP/1.1 $code $reason`r`nContent-Type: $type`r`nContent-Length: $length`r`n" +
    "Cache-Control: no-store`r`nConnection: close`r`n`r`n"
  $b = [Text.Encoding]::ASCII.GetBytes($h)
  $stream.Write($b, 0, $b.Length)
}

function Send-Text($stream, [int]$code, [string]$reason, [string]$body, [string]$type) {
  if (-not $type) { $type = 'text/plain; charset=utf-8' }
  $b = [Text.Encoding]::UTF8.GetBytes($body)
  Send-Head $stream $code $reason $type $b.Length
  $stream.Write($b, 0, $b.Length)
}

# Returns the status code sent, for the log.
function Handle($client) {
  $client.SendTimeout = $SendTimeoutMs
  $stream = $client.GetStream()
  $head = Read-Head $stream
  if (-not $head) { Send-Text $stream 400 'Bad Request' "bad request`n"; return '- 400' }
  $parts = ($head -split "`r`n")[0] -split ' '
  if ($parts.Length -ne 3) { Send-Text $stream 400 'Bad Request' "bad request`n"; return '- 400' }
  $target = $parts[1]
  $q = $target.IndexOf('?')
  $route = $target; $query = ''
  if ($q -ge 0) { $route = $target.Substring(0, $q); $query = $target.Substring($q + 1) }
  if ($parts[0] -ne 'GET') { Send-Text $stream 405 'Method Not Allowed' "GET only`n"; return "$route 405" }
  if ($route -ne '/manifest.json' -and -not $Files.ContainsKey($route)) {
    Send-Text $stream 404 'Not Found' "not found`n"; return "$route 404"
  }
  $t = $null
  foreach ($pair in $query -split '&') {
    $kv = $pair -split '=', 2
    if ($kv.Length -eq 2 -and $kv[0] -ceq 't') { $t = [Uri]::UnescapeDataString($kv[1]) }
  }
  if ($t -cne $Token) { Send-Text $stream 403 'Forbidden' "wrong token`n"; return "$route 403" }
  if ($route -eq '/manifest.json') {
    Send-Text $stream 200 'OK' $Manifest 'application/json'; return "$route 200"
  }
  $f = $Files[$route]
  $fs = [System.IO.File]::Open($f.path, 'Open', 'Read', 'Read')
  try {
    if ($fs.Length -ne $f.size) {
      Send-Text $stream 500 'Internal Server Error' "file changed since start; restart the server`n"
      return "$route 500"
    }
    Send-Head $stream 200 'OK' 'application/octet-stream' $f.size
    $fs.CopyTo($stream, 65536)
    return "$route 200 ($($f.size) bytes)"
  } finally { $fs.Close() }
}

$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Parse($Address)), $Port
$listener.Start()
Write-Host ''
Write-Host "TH08 data server ready.  IP: $Address   Port: $Port   Token: $Token"
Write-Host 'Enter these on the TV. Ctrl+C stops the server.'
try {
  while ($true) {
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 100; continue }
    $client = $listener.AcceptTcpClient()
    $who = $client.Client.RemoteEndPoint.ToString()
    try { Write-Log ("$who " + (Handle $client)) }
    catch { Write-Log "$who error: $($_.Exception.Message)" }
    finally { $client.Close() }
  }
} finally {
  $listener.Stop()
  Write-Log 'stopped'
}
