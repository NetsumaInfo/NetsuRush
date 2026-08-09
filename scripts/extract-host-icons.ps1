<#
  extract-host-icons.ps1 — extrait l'icône d'application ORIGINALE des logiciels pilotés
  (DaVinci Resolve, Premiere Pro, After Effects) vers src/assets/hosts/*.png.

  Pourquoi lire la ressource PE plutôt que passer par GDI : depuis Vista, la variante 256×256 d'une
  icône Windows est stockée telle quelle en PNG dans l'exécutable. On la recopie donc octet pour
  octet — transparence intacte, aucun rééchantillonnage, aucun tracé redessiné à la main.

  À relancer quand un éditeur change son icône. Les logos restent la propriété de leurs éditeurs
  (Blackmagic Design, Adobe) et ne servent qu'à désigner l'application dans l'interface.

  Usage : powershell -ExecutionPolicy Bypass -File scripts/extract-host-icons.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'src\assets\hosts'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Add-Type -Namespace NR -Name Res -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool FreeLibrary(IntPtr hModule);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr FindResource(IntPtr hModule, IntPtr name, IntPtr type);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr LoadResource(IntPtr hModule, IntPtr hResInfo);
[DllImport("kernel32.dll")]
public static extern IntPtr LockResource(IntPtr hResData);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SizeofResource(IntPtr hModule, IntPtr hResInfo);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool EnumResourceNames(IntPtr hModule, IntPtr type, EnumResNameProc callback, IntPtr param);
public delegate bool EnumResNameProc(IntPtr hModule, IntPtr type, IntPtr name, IntPtr param);
'@

$RT_ICON = [IntPtr]3
$RT_GROUP_ICON = [IntPtr]14
$LOAD_LIBRARY_AS_DATAFILE = 0x2

function Read-Resource {
  param([IntPtr]$Module, [IntPtr]$Type, [IntPtr]$Name)
  $info = [NR.Res]::FindResource($Module, $Name, $Type)
  if ($info -eq [IntPtr]::Zero) { return $null }
  $size = [NR.Res]::SizeofResource($Module, $info)
  $data = [NR.Res]::LockResource([NR.Res]::LoadResource($Module, $info))
  if ($data -eq [IntPtr]::Zero -or $size -eq 0) { return $null }
  $bytes = New-Object byte[] $size
  [System.Runtime.InteropServices.Marshal]::Copy($data, $bytes, 0, $size)
  return $bytes
}

# Une variante non compressée est un DIB : BITMAPINFOHEADER, puis les pixels BGRA de bas en haut,
# puis le masque AND 1 bit. On décode nous-mêmes plutôt que de passer par System.Drawing.Icon, qui
# refuse un .ico reconstruit autour d'une image 256×256.
function Save-DibAsPng {
  param([byte[]]$Dib, [string]$OutFile)
  Add-Type -AssemblyName System.Drawing

  $headerSize = [BitConverter]::ToUInt32($Dib, 0)
  $width = [BitConverter]::ToInt32($Dib, 4)
  $height = [BitConverter]::ToInt32($Dib, 8) / 2   # la hauteur compte l'image ET son masque
  $bits = [BitConverter]::ToUInt16($Dib, 14)
  if ($bits -ne 32) { throw "variante $bits bits non gérée (32 attendus)" }

  $pixels = [int]$headerSize
  $stride = $width * 4
  $maskStart = $pixels + ($stride * $height)
  $maskStride = [Math]::Floor(($width + 31) / 32) * 4   # lignes du masque alignées sur 4 octets

  # Certaines icônes 32 bits laissent le canal alpha à zéro et s'en remettent au masque AND.
  $hasAlpha = $false
  for ($i = $pixels + 3; $i -lt $maskStart -and -not $hasAlpha; $i += 4) {
    if ($Dib[$i] -ne 0) { $hasAlpha = $true }
  }

  $bmp = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)
  try {
    $row = New-Object byte[] $stride
    for ($y = 0; $y -lt $height; $y++) {
      $src = $pixels + (($height - 1 - $y) * $stride)   # le DIB est stocké de bas en haut
      [Array]::Copy($Dib, $src, $row, 0, $stride)
      if (-not $hasAlpha) {
        $maskRow = $maskStart + (($height - 1 - $y) * $maskStride)
        for ($x = 0; $x -lt $width; $x++) {
          $bit = ($Dib[$maskRow + [Math]::Floor($x / 8)] -shr (7 - ($x % 8))) -band 1
          $row[($x * 4) + 3] = if ($bit -eq 0) { 255 } else { 0 }   # 1 dans le masque = transparent
        }
      }
      [System.Runtime.InteropServices.Marshal]::Copy($row, 0, [IntPtr]($data.Scan0.ToInt64() + ($y * $data.Stride)), $stride)
    }
  } finally {
    $bmp.UnlockBits($data)
  }
  $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Export-AppIcon {
  param([string]$ExePath, [string]$OutFile)

  $module = [NR.Res]::LoadLibraryEx($ExePath, [IntPtr]::Zero, $LOAD_LIBRARY_AS_DATAFILE)
  if ($module -eq [IntPtr]::Zero) { throw "chargement impossible : $ExePath" }
  try {
    # Premier groupe d'icônes = icône principale de l'application.
    $groupName = [IntPtr]::Zero
    $callback = [NR.Res+EnumResNameProc] {
      param($h, $t, $n, $p)
      $script:firstGroup = $n
      return $false   # on s'arrête au premier
    }
    $script:firstGroup = [IntPtr]::Zero
    [void][NR.Res]::EnumResourceNames($module, $RT_GROUP_ICON, $callback, [IntPtr]::Zero)
    $groupName = $script:firstGroup
    if ($groupName -eq [IntPtr]::Zero) { throw "aucun groupe d'icônes dans $ExePath" }

    $group = Read-Resource $module $RT_GROUP_ICON $groupName
    if (-not $group) { throw "groupe d'icônes illisible dans $ExePath" }

    # GRPICONDIR : 6 octets d'entête, puis une entrée GRPICONDIRENTRY de 14 octets par variante.
    $count = [BitConverter]::ToUInt16($group, 4)
    $best = $null
    for ($i = 0; $i -lt $count; $i++) {
      $o = 6 + ($i * 14)
      $w = $group[$o]        # 0 = 256 px (le champ ne tient pas la valeur)
      $px = if ($w -eq 0) { 256 } else { [int]$w }
      $id = [BitConverter]::ToUInt16($group, $o + 12)
      if (-not $best -or $px -gt $best.Px) { $best = [pscustomobject]@{ Px = $px; Id = $id } }
    }
    if (-not $best) { throw "aucune variante d'icône dans $ExePath" }

    $icon = Read-Resource $module $RT_ICON ([IntPtr][int]$best.Id)
    if (-not $icon) { throw "variante $($best.Px)px illisible dans $ExePath" }

    # Signature PNG : la variante est déjà un PNG complet, on la recopie sans y toucher.
    $isPng = $icon.Length -gt 8 -and $icon[0] -eq 0x89 -and $icon[1] -eq 0x50 -and $icon[2] -eq 0x4E -and $icon[3] -eq 0x47
    if ($isPng) {
      [System.IO.File]::WriteAllBytes($OutFile, $icon)
      $format = 'PNG embarqué'
    } else {
      Save-DibAsPng -Dib $icon -OutFile $OutFile
      $format = 'DIB 32 bits'
    }
    Write-Host ("  {0,-26} {1}px ({2}) -> {3}" -f (Split-Path -Leaf $ExePath), $best.Px, $format, (Split-Path -Leaf $OutFile))
  } finally {
    [void][NR.Res]::FreeLibrary($module)
  }
}

# Chemin le plus RÉCENT pour chaque application (Adobe installe une version par dossier).
function Find-Exe {
  param([string]$DirPattern, [string]$Relative)
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  foreach ($root in $roots) {
    $adobe = Join-Path $root 'Adobe'
    if (-not (Test-Path $adobe)) { continue }
    $dirs = Get-ChildItem $adobe -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match $DirPattern } | Sort-Object Name -Descending
    foreach ($d in $dirs) {
      $exe = Join-Path $d.FullName $Relative
      if (Test-Path $exe) { return $exe }
    }
  }
  return $null
}

$targets = @(
  @{ Name = 'premiere-pro.png';    Exe = (Find-Exe 'Premiere Pro' 'Adobe Premiere Pro.exe') }
  @{ Name = 'after-effects.png';   Exe = (Find-Exe 'After Effects' 'Support Files\AfterFX.exe') }
  @{ Name = 'davinci-resolve.png'; Exe = 'C:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe' }
)

Write-Host 'Extraction des icônes des logiciels pilotés :'
foreach ($t in $targets) {
  if (-not $t.Exe -or -not (Test-Path $t.Exe)) {
    Write-Host ("  {0,-24} application absente, icône conservée" -f $t.Name)
    continue
  }
  Export-AppIcon -ExePath $t.Exe -OutFile (Join-Path $outDir $t.Name)
}
