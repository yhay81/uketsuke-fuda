[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkerPath = Join-Path $RepoRoot "src\worker.tsx"
$DomainPath = Join-Path $RepoRoot "src\domain\events.ts"
$MigrationPath = Join-Path $RepoRoot "migrations\0001_events.sql"
$AppPath = Join-Path $RepoRoot "public\app.js"
$EventPath = Join-Path $RepoRoot "public\event.js"
$StylesPath = Join-Path $RepoRoot "public\styles.css"
$WranglerPath = Join-Path $RepoRoot "wrangler.jsonc"
$PublicDirectory = Join-Path $RepoRoot "public"

$RequiredFiles = @(
    "DECISIONS.md", "EXPERIMENT.md", "METRICS.md", "PRIVACY.md", "README.md", "SECURITY.md", "STACK.md",
    ".github\workflows\ci.yml", "migrations\0001_events.sql", "public\app.js", "public\event.js",
    "public\favicon.svg", "public\manifest.webmanifest", "public\styles.css", "public\og.svg",
    "public\robots.txt", "src\domain\events.ts", "src\worker.tsx"
)
foreach ($RelativePath in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $RelativePath))) { throw "Missing required release file: $RelativePath" }
}

$Worker = Get-Content -Raw -LiteralPath $WorkerPath
$Domain = Get-Content -Raw -LiteralPath $DomainPath
$Migration = Get-Content -Raw -LiteralPath $MigrationPath
$App = Get-Content -Raw -LiteralPath $AppPath
$Event = Get-Content -Raw -LiteralPath $EventPath
$Styles = Get-Content -Raw -LiteralPath $StylesPath
$Wrangler = Get-Content -Raw -LiteralPath $WranglerPath
$ProductSurface = @($Worker, $App, $Event) -join "`n"

if (-not $Worker.Contains('class="ticket-visual"') -or -not $Worker.Contains('class="ticket-stub"') -or -not $Worker.Contains('class="roster-preview"') -or -not $Event.Contains('roster-row')) { throw "Expected the ticket-to-roster visual system" }
if ($ProductSurface -match '(?i)public validation|success criteria|experiment|仮説|成功条件|市場スコア|移行候補|収益性') { throw "Research copy must not appear on the product surface" }
if ($Styles -match '(?s)h1\s*\{[^}]*font-size:\s*(?:[4-9]\d|[1-9]\d{2})px') { throw "Primary heading is too large" }
if ($Styles -match '(?i)gradient') { throw "Product CSS must not use gradients" }
if (@($App, $Event) -join "`n" -match '(?i)innerHTML|eval\(|new Function') { throw "User content must not be interpreted as markup or code" }
if (-not $Event.Contains("location.hash")) { throw "Capability keys must be read from URL fragments" }
if (-not $Worker.Contains("manager_token_hash") -or -not $Worker.Contains("await sha256(token)")) { throw "Capability URLs must store only key hashes" }
if (-not $Worker.Contains("constantTimeEqual") -or -not $Worker.Contains("enforceSameOrigin") -or -not $Worker.Contains("create_rate_limited") -or -not $Worker.Contains("reservation_rate_limited")) { throw "Expected capability, origin, and rate boundaries" }
if (-not $Worker.Contains("current - 35 * 86400") -or -not $Domain.Contains("startsAt + 7 * 86400") -or -not $Migration.Contains("ON DELETE CASCADE")) { throw "Expected bounded event, reservation, report, and telemetry retention" }
if ($Migration -match '(?i)email|phone_number|telephone|address|photo|gender|birthday|payment|password') { throw "Contact, identity, payment, and authentication data do not belong in this release" }
if (-not $Migration.Contains("PRIMARY KEY(event_id, session_id)") -or -not $Migration.Contains("CREATE TABLE content_reports")) { throw "Expected duplicate-report constraints" }
if (-not $Worker.Contains("reportReasons") -or -not $Worker.Contains("(count?.count ?? 0) >= 3")) { throw "Expected bounded reporting" }
if (-not $Worker.Contains("event.capacity > 0") -or -not $Worker.Contains("reservationCount")) { throw "Expected server-side capacity enforcement" }
if ($ProductSurface -match '(?i)better-auth|betterAuth') { throw "Account authentication is not needed for the capability-based release" }
if ($Wrangler.Contains("00000000-0000-0000-0000-000000000000")) { throw "The production D1 database ID has not been configured" }
if ((Get-Item -LiteralPath (Join-Path $PublicDirectory "og.svg")).Length -lt 1500) { throw "Expected a product-specific OG SVG larger than 1.5 KB" }

$KeyFiles = @(Get-ChildItem -LiteralPath $PublicDirectory -File | Where-Object { $_.Name -match "^[a-zA-Z0-9-]{8,128}\.txt$" })
if ($KeyFiles.Count -ne 1) { throw "Expected exactly one generated IndexNow key file, found $($KeyFiles.Count)" }
$Key = (Get-Content -Raw -LiteralPath $KeyFiles[0].FullName).Trim()
if ($Key -ne $KeyFiles[0].BaseName) { throw "IndexNow key file name and content do not match" }

Write-Output "Product release contract is satisfied"
