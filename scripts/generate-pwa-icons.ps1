#requires -Version 5.1
<#
.SYNOPSIS
    Generates the PWA icons for the web app (warm paper, ink seal, paper "书").

.DESCRIPTION
    Draws four PNGs with System.Drawing:

      apps/web/public/icons/icon-192.png           192x192, purpose "any"
      apps/web/public/icons/icon-512.png           512x512, purpose "any"
      apps/web/public/icons/icon-maskable-512.png  512x512, purpose "maskable"
      apps/web/public/apple-touch-icon.png         180x180

    The maskable variant keeps the ink seal inside the central safe zone: its
    diameter is 66% of the canvas, under both the 70% brief limit and the 80%
    platform safe zone.

    The script is idempotent — rerunning it overwrites the four PNGs with the
    same bytes.

.EXAMPLE
    pwsh -File scripts/generate-pwa-icons.ps1
#>
[CmdletBinding()]
param(
    [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/web/public')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$PaperColor = [System.Drawing.ColorTranslator]::FromHtml('#F6F1E7')
$InkColor = [System.Drawing.ColorTranslator]::FromHtml('#2B2B2B')
$Glyph = [char]0x4E66  # 书

function Get-SerifFontFamily {
    # A serif CJK face keeps the seal looking like printed type; the list is
    # ordered from most to least preferred and the first installed one wins.
    $candidates = @('Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', 'NSimSun', 'Microsoft YaHei')
    foreach ($name in $candidates) {
        try {
            return New-Object System.Drawing.FontFamily($name)
        } catch {
            continue
        }
    }
    return [System.Drawing.FontFamily]::GenericSerif
}

function New-SealIcon {
    param(
        [Parameter(Mandatory)] [int]$Size,
        [Parameter(Mandatory)] [string]$Path,
        # Seal diameter as a fraction of the canvas edge.
        [Parameter(Mandatory)] [double]$SealScale
    )

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $inkBrush = New-Object System.Drawing.SolidBrush($InkColor)
    $paperBrush = New-Object System.Drawing.SolidBrush($PaperColor)
    $glyphFont = $null

    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.Clear($PaperColor)

        $diameter = [single]($Size * $SealScale)
        $offset = [single](($Size - $diameter) / 2)
        $graphics.FillEllipse($inkBrush, $offset, $offset, $diameter, $diameter)

        # The glyph must fit the circle's inscribed square (edge * sqrt(2) / 2),
        # so keep the em box a little below that.
        $fontSize = [single]($diameter * 0.62)
        $glyphFont = New-Object System.Drawing.Font((Get-SerifFontFamily), $fontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
        $format = New-Object System.Drawing.StringFormat
        $format.Alignment = [System.Drawing.StringAlignment]::Center
        $format.LineAlignment = [System.Drawing.StringAlignment]::Center
        $canvas = New-Object System.Drawing.RectangleF(0, 0, [single]$Size, [single]$Size)

        $graphics.DrawString([string]$Glyph, $glyphFont, $paperBrush, $canvas, $format)

        $directory = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $directory)) {
            New-Item -ItemType Directory -Force -Path $directory | Out-Null
        }
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        if ($null -ne $glyphFont) { $glyphFont.Dispose() }
        $paperBrush.Dispose()
        $inkBrush.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }

    Write-Host ("wrote {0} ({1}x{1})" -f $Path, $Size)
}

New-SealIcon -Size 192 -Path (Join-Path $OutputRoot 'icons/icon-192.png') -SealScale 0.72
New-SealIcon -Size 512 -Path (Join-Path $OutputRoot 'icons/icon-512.png') -SealScale 0.72
New-SealIcon -Size 512 -Path (Join-Path $OutputRoot 'icons/icon-maskable-512.png') -SealScale 0.66
New-SealIcon -Size 180 -Path (Join-Path $OutputRoot 'apple-touch-icon.png') -SealScale 0.72
