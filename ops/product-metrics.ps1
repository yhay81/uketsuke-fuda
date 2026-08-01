[CmdletBinding()]
param([switch]$Local)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SqlPath = Join-Path $PSScriptRoot "product-metrics.sql"
$Wrangler = Join-Path $RepoRoot "node_modules\.bin\wrangler.cmd"
$Target = if ($Local) { "--local" } else { "--remote" }
$Sql = (Get-Content $SqlPath) -join " "

$Output = & $Wrangler d1 execute uketsuke-fuda $Target --json --command $Sql
if ($LASTEXITCODE -ne 0) { throw "D1 metrics query failed with exit code $LASTEXITCODE" }
$Payload = ($Output -join [Environment]::NewLine) | ConvertFrom-Json
$Row = $Payload[0].results[0]
if (-not $Row) { throw "D1 metrics query returned no result" }

function Get-Percent {
    param([int]$Numerator, [int]$Denominator)
    if ($Denominator -eq 0) { return $null }
    return [Math]::Round(($Numerator / $Denominator) * 100, 1)
}

$Users = [int]$Row.users
$Creators = [int]$Row.creators
$Reservers = [int]$Row.reservers

[ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    service = "uketsuke-fuda"
    environment = if ($Local) { "local" } else { "production" }
    funnel = [ordered]@{
        users = $Users
        creators = $Creators
        events_created = [int]$Row.events_created
        reservers = $Reservers
        events_reserved = [int]$Row.events_reserved
        event_managers = [int]$Row.event_managers
        reservation_managers = [int]$Row.reservation_managers
        exporters = [int]$Row.exporters
        returned = [int]$Row.returned
        created_7d = [int]$Row.created_7d
        reservers_7d = [int]$Row.reservers_7d
        qa_rows = [int]$Row.qa_rows
    }
    live_state = [ordered]@{
        open_events = [int]$Row.open_events
        closed_events = [int]$Row.closed_events
        hidden_events = [int]$Row.hidden_events
        reserved_rows = [int]$Row.reserved_rows
        checked_in_rows = [int]$Row.checked_in_rows
        cancelled_rows = [int]$Row.cancelled_rows
        reserved_seats = [int]$Row.reserved_seats
        reports = [int]$Row.reports
    }
    rates = [ordered]@{
        creator_percent = Get-Percent $Creators $Users
        reserver_percent = Get-Percent $Reservers $Users
        return_percent = Get-Percent ([int]$Row.returned) $Users
    }
} | ConvertTo-Json -Depth 4
