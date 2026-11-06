# Installs the CUDA build of PyTorch into this project's venv so VWS embeds on your NVIDIA GPU.
#
# Why: `pip install torch` from PyPI gives Windows a CPU-only build, even on a machine with a GPU.
# Run from the vws-backend folder:
#     powershell -ExecutionPolicy Bypass -File setup_gpu.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$py = Join-Path $PSScriptRoot "venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "Couldn't find $py. Create the venv first (python -m venv venv)." -ForegroundColor Red
    exit 1
}

$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $smi) {
    $candidate = Join-Path $env:SystemRoot "System32\nvidia-smi.exe"
    if (Test-Path $candidate) { $smi = $candidate } else {
        Write-Host "nvidia-smi not found: no NVIDIA driver is installed, so there's no GPU for PyTorch to use." -ForegroundColor Red
        exit 1
    }
}

$out = (& $smi) -join "`n"
$m = [regex]::Match($out, "CUDA Version:\s*([0-9]+)\.([0-9]+)")
if (-not $m.Success) {
    Write-Host "Couldn't read the driver's CUDA version from nvidia-smi." -ForegroundColor Red
    exit 1
}
$major = [int]$m.Groups[1].Value
$minor = [int]$m.Groups[2].Value
$gpu = (& $smi --query-gpu=name --format=csv,noheader | Select-Object -First 1)

if ($major -ge 13) { $cu = "cu130" }
elseif ($major -eq 12 -and $minor -ge 6) { $cu = "cu126" }
else {
    Write-Host "Your driver supports CUDA $major.$minor; current PyTorch needs 12.6 or newer. Update the NVIDIA driver, then re-run." -ForegroundColor Yellow
    exit 1
}

Write-Host "GPU: $gpu (driver supports CUDA $major.$minor) -> installing the $cu build of torch + torchvision" -ForegroundColor Cyan
& $py -m pip uninstall -y torch torchvision
& $py -m pip install torch torchvision --index-url "https://download.pytorch.org/whl/$cu"

& $py -c "import torch; ok = torch.cuda.is_available(); print('torch', torch.__version__, '| CUDA available:', ok); print('GPU:', torch.cuda.get_device_name(0) if ok else 'not visible'); print('bf16:', torch.cuda.is_bf16_supported() if ok else '-')"
Write-Host "Done. Restart the backend (python main.py); the sidebar should show 'cuda'." -ForegroundColor Green
