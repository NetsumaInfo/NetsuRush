!include nsDialogs.nsh
!include LogicLib.nsh
!include WinMessages.nsh

Var NRRuntimeCheckbox
Var NRRuntimeState
Var NRUserDataCheckbox
Var NRUserDataState
Var NRAllCheckbox
Var NRAllState

LangString NRCleanupTitle 1036 "Désinstallation complète"
LangString NRCleanupTitle 1033 "Complete uninstall"
LangString NRCleanupSubtitle 1036 "Choisissez ce que NetsuRush doit supprimer de ce PC."
LangString NRCleanupSubtitle 1033 "Choose what NetsuRush should remove from this PC."
LangString NRAppLabel 1036 "Application NetsuRush"
LangString NRAppLabel 1033 "NetsuRush application"
LangString NRAppHint 1036 "Toujours supprimée"
LangString NRAppHint 1033 "Always removed"
LangString NRRuntimeLabel 1036 "Prérequis, modèles, réglages et caches"
LangString NRRuntimeLabel 1033 "Prerequisites, models, settings and caches"
LangString NRRuntimeHint 1036 "Environnement Python, poids téléchargés, ffmpeg, aperçus et intégrations."
LangString NRRuntimeHint 1033 "Python environment, downloaded weights, ffmpeg, previews and integrations."
LangString NRUserDataLabel 1036 "Créations et données personnelles"
LangString NRUserDataLabel 1033 "Personal creations and data"
LangString NRUserDataHint 1036 "Boards, carnets, scripts, collections et historique. Les rushs sources ne sont jamais supprimés."
LangString NRUserDataHint 1033 "Boards, notebooks, scripts, collections and history. Source media is never deleted."
LangString NRAllLabel 1036 "Tout supprimer"
LangString NRAllLabel 1033 "Remove everything"

UninstPage custom un.NetsuCleanupPage un.NetsuCleanupLeave

!macro NSIS_HOOK_PREINSTALL
  ; Une installation manuelle peut être lancée alors que NetsuRush est encore ouvert. On demande
  ; une fermeture NORMALE de sa seule fenêtre : RunEvent::Exit arrête alors son core node.exe.
  ; Aucun PowerShell, aucune énumération de processus et aucun arrêt forcé ne sont utilisés. La
  ; correspondance porte sur le TITRE exact de la fenêtre : une fenêtre NetsuBoard à côté n'est
  ; jamais visée.
  FindWindow $0 "" "NetsuRush"
  ${If} $0 <> 0
    SendMessage $0 ${WM_CLOSE} 0 0 /TIMEOUT=3000
    Sleep 1800
  ${EndIf}
  ; Les anciennes versions peuvent avoir laissé node.exe sans fenêtre après un crash. La copie
  ; temporaire de l'app passe par Restart Manager, qui ne ferme QUE le processus dont l'image est
  ; le fichier passé — un CHEMIN, jamais un nom d'image.
  ;
  ; Cette distinction est la raison d'être de cette étape à côté de celle de Tauri :
  ; `CheckIfAppIsRunning` compare le NOM de l'image, et tant que le binaire principal s'appelait
  ; `app.exe` — le nom du paquet Cargo, identique dans NetsuBoard — installer, mettre à jour ou
  ; désinstaller NetsuRush appelait TerminateProcess sur TOUS les `app.exe` de la session :
  ; NetsuBoard mourait avec, sans dialogue et sans pouvoir sauvegarder. `mainBinaryName` dans
  ; tauri.conf.json en fait `NetsuRush.exe` ; rien ici ne doit revenir à un nom d'image nu.
  ;
  ; ${MAINBINARYNAME} plutôt qu'un nom écrit en dur, pour suivre la configuration. `app.exe` est
  ; libéré APRÈS : une installation antérieure au renommage tourne sous l'ancien nom, et c'est
  ; cette image-là qui tient le verrou. Les deux sont des chemins DANS cette installation, donc
  ; l'homonyme de NetsuBoard reste hors de portée.
  File /oname=$PLUGINSDIR\netsurush-release-lock.exe "${MAINBINARYSRCPATH}"
  nsExec::ExecToLog '"$PLUGINSDIR\netsurush-release-lock.exe" --release-lock "$INSTDIR\${MAINBINARYNAME}.exe"'
  Pop $0
  nsExec::ExecToLog '"$PLUGINSDIR\netsurush-release-lock.exe" --release-lock "$INSTDIR\app.exe"'
  Pop $0
  ; Seul node.exe décide de l'abandon : le binaire principal peut très bien n'être tenu par
  ; personne, et une installation d'avant le renommage n'a même pas de `NetsuRush.exe` à libérer.
  nsExec::ExecToLog '"$PLUGINSDIR\netsurush-release-lock.exe" --release-lock "$INSTDIR\resources\bin\node.exe"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "NetsuRush n'a pas pu libérer son service de fond. Ferme NetsuRush puis réessaie."
    Abort
  ${EndIf}
  Delete "$PLUGINSDIR\netsurush-release-lock.exe"
!macroend

Function un.NetsuCleanupPage
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "$(NRCleanupTitle)" "$(NRCleanupSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 4u 100% 12u "$(NRAppLabel)"
  Pop $1
  CreateFont $2 "$(^Font)" "$(^FontSize)" "700"
  SendMessage $1 ${WM_SETFONT} $2 1
  ${NSD_CreateLabel} 18u 19u 90% 10u "$(NRAppHint)"
  Pop $1

  ${NSD_CreateCheckbox} 0 42u 100% 12u "$(NRRuntimeLabel)"
  Pop $NRRuntimeCheckbox
  ${NSD_CreateLabel} 18u 57u 90% 22u "$(NRRuntimeHint)"
  Pop $1

  ${NSD_CreateCheckbox} 0 88u 100% 12u "$(NRUserDataLabel)"
  Pop $NRUserDataCheckbox
  ${NSD_CreateLabel} 18u 103u 90% 28u "$(NRUserDataHint)"
  Pop $1

  ${NSD_CreateCheckbox} 0 142u 100% 12u "$(NRAllLabel)"
  Pop $NRAllCheckbox
  ${NSD_OnClick} $NRAllCheckbox un.NetsuAllChanged

  nsDialogs::Show
FunctionEnd

Function un.NetsuAllChanged
  ${NSD_GetState} $NRAllCheckbox $NRAllState
  ${NSD_SetState} $NRRuntimeCheckbox $NRAllState
  ${NSD_SetState} $NRUserDataCheckbox $NRAllState
FunctionEnd

Function un.NetsuCleanupLeave
  ${NSD_GetState} $NRRuntimeCheckbox $NRRuntimeState
  ${NSD_GetState} $NRUserDataCheckbox $NRUserDataState
  ${NSD_GetState} $NRAllCheckbox $NRAllState
  ${If} $NRAllState = ${BST_CHECKED}
    StrCpy $NRRuntimeState ${BST_CHECKED}
    StrCpy $NRUserDataState ${BST_CHECKED}
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREUNINSTALL
  CopyFiles /SILENT "$INSTDIR\resources\scripts\uninstall-cleanup.ps1" "$TEMP\netsurush-uninstall-cleanup.ps1"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    StrCpy $R8 ""
    ${If} $NRRuntimeState = ${BST_CHECKED}
      StrCpy $R8 "$R8 -Runtime"
    ${EndIf}
    ${If} $NRUserDataState = ${BST_CHECKED}
      StrCpy $R8 "$R8 -UserData"
    ${EndIf}
    ${If} $R8 != ""
      nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\netsurush-uninstall-cleanup.ps1" $R8'
    ${EndIf}
    Delete "$TEMP\netsurush-uninstall-cleanup.ps1"
  ${EndIf}
!macroend
