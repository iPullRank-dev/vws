; electron-builder NSIS hooks for VWS.
;
; Install: after the files are copied, run setup_runtime.py with the bundled
; Python. It detects an NVIDIA GPU (CUDA build of PyTorch) or falls back to the
; CPU build, installs the backend packages and Chromium, and downloads the models
; into %LOCALAPPDATA%\VWS. A console window shows the progress. If it can't finish
; (offline, no disk space), the app runs the same setup with a progress screen the
; next time it opens, resuming where it stopped.
;
; Uninstall: projects (database, uploads) are always kept. The downloaded runtime
; and models (~5-15 GB) are removed only if the user says yes, and never during an
; update.

!macro customInstall
  DetailPrint "Downloading PyTorch, packages and the AI models (this can take a while)..."
  ${If} ${Silent}
    nsExec::ExecToLog '"$INSTDIR\resources\python\python.exe" "$INSTDIR\resources\backend\setup_runtime.py"'
    Pop $0
  ${Else}
    ExecWait '"$INSTDIR\resources\python\python.exe" "$INSTDIR\resources\backend\setup_runtime.py" --pause-on-error' $0
  ${EndIf}
  ${If} $0 != 0
    DetailPrint "Setup didn't finish (code $0); VWS will finish it the first time it opens."
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete VWS's downloaded models and Python runtime (several GB)?$\r$\n$\r$\nYour projects are kept either way, in $LOCALAPPDATA\VWS." /SD IDNO IDNO vws_keep_runtime
      RMDir /r "$LOCALAPPDATA\VWS\runtime"
      RMDir /r "$LOCALAPPDATA\VWS\models"
      RMDir /r "$LOCALAPPDATA\VWS\pycache"
    vws_keep_runtime:
  ${EndIf}
!macroend
