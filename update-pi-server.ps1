param(
	[string]$HostName = "127.0.0.1",
	[int]$Port = 4217,
	[string]$AuthToken = "18013908341",
	[string]$PublicUrl = "https://pi.yreva.asia",
	[switch]$SkipPublicCheck,
	[switch]$SkipTests
)

$ErrorActionPreference = "Stop"

function Invoke-Checked {
	param(
		[string]$FilePath,
		[string[]]$Arguments
	)

	& $FilePath @Arguments
	$exitCode = $LASTEXITCODE
	if ($exitCode -ne 0) {
		throw "Command failed with exit code ${exitCode}: $FilePath $($Arguments -join ' ')"
	}
}

function Require-Command {
	param([string]$Name)

	$command = Get-Command $Name -ErrorAction SilentlyContinue
	if (-not $command) {
		throw "Required command not found: $Name"
	}
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

Require-Command "git"
Require-Command "npm"
Require-Command "node"

$branch = (& git branch --show-current).Trim()
if (-not $branch) {
	throw "Not on a branch; refusing to update a detached checkout."
}

$status = & git status --porcelain -- . `
	":(exclude)update-pi-server.ps1" `
	":(exclude)packages/ai/src/models.generated.ts" `
	":(exclude)packages/ai/src/image-models.generated.ts"
if ($status) {
	throw "Working tree is not clean; commit, discard, or move local changes before running this script."
}

Invoke-Checked "git" @("fetch", "origin", $branch)

$local = (& git rev-parse HEAD).Trim()
$upstream = (& git rev-parse "@{u}").Trim()
$mergeBase = (& git merge-base HEAD "@{u}").Trim()

if ($local -ne $upstream) {
	if ($local -ne $mergeBase) {
		throw "Local branch has commits not in upstream; refusing non-fast-forward update."
	}
	Invoke-Checked "git" @("pull", "--ff-only")
} else {
	Write-Host "Already up to date at $local"
}

Invoke-Checked "npm" @("install", "--ignore-scripts")

if (-not $SkipTests) {
	Push-Location (Join-Path $repoRoot "packages/pi-server")
	try {
		Invoke-Checked "node" @("../../node_modules/vitest/dist/cli.js", "--run")
	} finally {
		Pop-Location
	}
}

Invoke-Checked "npm" @("run", "build")
Invoke-Checked "npm" @("run", "build", "-w", "packages/pi-client")
Invoke-Checked "npm" @("install", "-g", "--ignore-scripts", "./packages/pi-client")
Invoke-Checked "npm" @("run", "build", "-w", "packages/pi-server")
Invoke-Checked "npm" @("install", "-g", "--ignore-scripts", "./packages/pi-server")

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
	$process = Get-Process -Id $existing.OwningProcess -ErrorAction SilentlyContinue
	if (-not $process) {
		throw "Port $Port is in use by process $($existing.OwningProcess), but the process could not be inspected."
	}
	if ($process.ProcessName -ne "node") {
		throw "Port $Port is in use by non-node process $($process.ProcessName) ($($process.Id)); refusing to stop it."
	}
	Stop-Process -Id $process.Id -Force
	Start-Sleep -Seconds 1
}

$logPath = Join-Path $repoRoot "pi-server.log"
$errPath = Join-Path $repoRoot "pi-server.err.log"
Remove-Item -LiteralPath $logPath, $errPath -ErrorAction SilentlyContinue

$serverCommand = @"
`$env:PI_SERVER_HOST='$HostName'
`$env:PI_SERVER_PORT='$Port'
`$env:PI_SERVER_AUTH_TOKEN='$AuthToken'
`$env:Path=[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User') + ';' + (npm prefix -g)
pi-server
"@

Start-Process -FilePath "powershell.exe" `
	-ArgumentList @("-NoProfile", "-Command", $serverCommand) `
	-WindowStyle Hidden `
	-RedirectStandardOutput $logPath `
	-RedirectStandardError $errPath | Out-Null

Start-Sleep -Seconds 3

$listening = Get-NetTCPConnection -LocalAddress $HostName -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listening) {
	$serverError = if (Test-Path -LiteralPath $errPath) { Get-Content -LiteralPath $errPath -Raw } else { "" }
	throw "pi-server did not start on ${HostName}:$Port. $serverError"
}

$healthUrl = "http://${HostName}:$Port/health"
$health = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 10
if ($health.StatusCode -ne 200 -or $health.Content -notmatch '"ok"') {
	throw "pi-server health check failed: HTTP $($health.StatusCode) $($health.Content)"
}

$body = '{"sessionId":"update-script-auth-check","staticContext":{"systemPrompt":"health check","tools":[]}}'
$authCheck = Invoke-WebRequest `
	-Uri "http://${HostName}:$Port/api/session/init" `
	-Method Post `
	-Headers @{ Authorization = "Bearer $AuthToken" } `
	-ContentType "application/json" `
	-Body $body `
	-UseBasicParsing `
	-TimeoutSec 10
if ($authCheck.StatusCode -ne 200) {
	throw "pi-server auth check failed: HTTP $($authCheck.StatusCode) $($authCheck.Content)"
}

if (-not $SkipPublicCheck) {
	$publicHealthUrl = "$($PublicUrl.TrimEnd('/'))/health"
	$publicHealth = Invoke-WebRequest -Uri $publicHealthUrl -UseBasicParsing -TimeoutSec 20
	if ($publicHealth.StatusCode -ne 200 -or $publicHealth.Content -notmatch '"ok"') {
		throw "Public tunnel health check failed: HTTP $($publicHealth.StatusCode) $($publicHealth.Content)"
	}
	Write-Host "public tunnel verified at $publicHealthUrl"
}

Write-Host "pi-server updated and running on ${HostName}:$Port"
