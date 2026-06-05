param(
    [string] $Uri = "ws://localhost:8081/ws/run"
)

$code = @'
public class Main {
    public static void main(String[] args) throws Exception {
        for (int i = 1; i <= 3; i++) {
            System.out.println("Hello from POC2 " + i);
            Thread.sleep(1000);
        }
    }
}
'@

function New-WebSocketMask {
    $mask = New-Object byte[] 4
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($mask)
    } finally {
        $rng.Dispose()
    }
    return $mask
}

function Send-WebSocketText {
    param(
        [System.IO.Stream] $Stream,
        [string] $Text
    )

    $payload = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $mask = New-WebSocketMask
    $header = New-Object System.Collections.Generic.List[byte]
    $header.Add(0x81)

    if ($payload.Length -lt 126) {
        $header.Add([byte](0x80 -bor $payload.Length))
    } elseif ($payload.Length -le 65535) {
        $header.Add(0xFE)
        $header.Add([byte](($payload.Length -shr 8) -band 0xFF))
        $header.Add([byte]($payload.Length -band 0xFF))
    } else {
        throw "Payload too large for this POC client"
    }

    foreach ($byte in $mask) {
        $header.Add($byte)
    }

    for ($i = 0; $i -lt $payload.Length; $i++) {
        $payload[$i] = $payload[$i] -bxor $mask[$i % 4]
    }

    $Stream.Write($header.ToArray(), 0, $header.Count)
    $Stream.Write($payload, 0, $payload.Length)
    $Stream.Flush()
}

function Read-Exact {
    param(
        [System.IO.Stream] $Stream,
        [int] $Length
    )

    $buffer = New-Object byte[] $Length
    $offset = 0
    while ($offset -lt $Length) {
        $read = $Stream.Read($buffer, $offset, $Length - $offset)
        if ($read -le 0) {
            throw "WebSocket connection closed"
        }
        $offset += $read
    }
    return $buffer
}

function Read-WebSocketText {
    param(
        [System.IO.Stream] $Stream
    )

    $messageBytes = New-Object System.Collections.Generic.List[byte]

    while ($true) {
        $first = Read-Exact $Stream 2
        $fin = ($first[0] -band 0x80) -ne 0
        $opcode = $first[0] -band 0x0F
        $length = $first[1] -band 0x7F

        if ($length -eq 126) {
            $extended = Read-Exact $Stream 2
            $length = ($extended[0] -shl 8) -bor $extended[1]
        } elseif ($length -eq 127) {
            throw "Large WebSocket frames are not supported by this POC client"
        }

        if ($opcode -eq 8) {
            return $null
        }

        if ($length -gt 0) {
            $payload = Read-Exact $Stream $length
            foreach ($byte in $payload) {
                $messageBytes.Add($byte)
            }
        }

        if ($fin) {
            return [System.Text.Encoding]::UTF8.GetString($messageBytes.ToArray())
        }
    }
}

function Read-HttpHandshake {
    param(
        [System.IO.Stream] $Stream
    )

    $bytes = New-Object System.Collections.Generic.List[byte]
    while ($true) {
        $byte = $Stream.ReadByte()
        if ($byte -lt 0) {
            throw "WebSocket handshake closed"
        }
        $bytes.Add([byte]$byte)
        $count = $bytes.Count
        if ($count -ge 4 -and
            $bytes[$count - 4] -eq 13 -and
            $bytes[$count - 3] -eq 10 -and
            $bytes[$count - 2] -eq 13 -and
            $bytes[$count - 1] -eq 10) {
            return [System.Text.Encoding]::ASCII.GetString($bytes.ToArray())
        }
    }
}

$target = [Uri]$Uri
if ($target.Scheme -ne "ws") {
    throw "Only ws:// URLs are supported"
}

$path = if ([string]::IsNullOrEmpty($target.PathAndQuery)) { "/" } else { $target.PathAndQuery }
$port = if ($target.Port -gt 0) { $target.Port } else { 80 }
$client = [System.Net.Sockets.TcpClient]::new($target.Host, $port)

try {
    $stream = $client.GetStream()
    $keyBytes = New-Object byte[] 16
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($keyBytes)
    } finally {
        $rng.Dispose()
    }
    $key = [Convert]::ToBase64String($keyBytes)
    $request = "GET $path HTTP/1.1`r`nHost: $($target.Host):$port`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Key: $key`r`nSec-WebSocket-Version: 13`r`n`r`n"
    $requestBytes = [System.Text.Encoding]::ASCII.GetBytes($request)
    $stream.Write($requestBytes, 0, $requestBytes.Length)

    $handshake = Read-HttpHandshake $stream
    $status = ($handshake -split "`r`n")[0]
    if ($status -notmatch "101") {
        throw "WebSocket handshake failed: $status"
    }

    $payload = @{ code = $code } | ConvertTo-Json -Compress
    Send-WebSocketText $stream $payload

    $pending = [System.Text.StringBuilder]::new()
    while ($true) {
        $fragment = Read-WebSocketText $stream
        if ($null -eq $fragment) {
            break
        }

        [void] $pending.Append($fragment)
        try {
            $message = $pending.ToString()
            $event = $message | ConvertFrom-Json -ErrorAction Stop
            $pending.Clear() | Out-Null
        } catch {
            continue
        }

        Write-Output $message
        if ($event.type -eq "exit" -or $event.type -eq "error") {
            break
        }
    }
} finally {
    $client.Dispose()
}
