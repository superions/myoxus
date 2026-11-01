; SPDX-License-Identifier: AGPL-3.0-or-later
Unicode true
ManifestDPIAware true
!include "${IDENTITY_HEADER}"
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!define INSTALL_KEY "Software\${APP_GUID}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
!define MULTIUSER_EXECUTIONLEVEL Highest
!define MULTIUSER_MUI
!define MULTIUSER_USE_PROGRAMFILES64
!define MULTIUSER_INSTALLMODE_COMMANDLINE
!define MULTIUSER_INSTALLMODE_DEFAULT_CURRENTUSER
!define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCT_NAME}"
!define MULTIUSER_INSTALLMODE_INSTDIR_REGISTRY_KEY "${INSTALL_KEY}"
!define MULTIUSER_INSTALLMODE_INSTDIR_REGISTRY_VALUENAME "InstallLocation"
!define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${INSTALL_KEY}"
!define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "InstallLocation"
!include "MultiUser.nsh"
!ifdef BOOTSTRAP
; Installer-side library functions are intentionally unused by the generator.
!pragma warning disable 6010
!else
; The signed uninstaller is generated separately and embedded with File.
!pragma warning disable 6020
!endif

Name "${PRODUCT_NAME}"
VIProductVersion "${WINDOWS_VERSION}"
VIFileVersion "${WINDOWS_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1033 "CompanyName" "Myoxus Contributors"
VIAddVersionKey /LANG=1033 "FileDescription" "${PRODUCT_NAME} Installer"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright Myoxus Contributors"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
!ifdef BOOTSTRAP
OutFile "${BOOTSTRAP_EXE}"
SilentInstall silent
!else
OutFile "${ARTIFACT}"
!endif
SetCompressor /SOLID lzma
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBAR}"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${SIDEBAR}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApplication
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
!insertmacro MULTIUSER_PAGE_INSTALLMODE
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "German"
!insertmacro MUI_LANGUAGE "French"
!insertmacro MUI_LANGUAGE "SpanishInternational"
!include "${LANGUAGE_HEADER}"
!ifndef BOOTSTRAP
!include "${TRANSLATION_HEADER}"
!endif
!ifndef BOOTSTRAP
Var parameters
Var updating
Var oldUninstaller
Var previousDirectory
Var rawCommandLine
!endif

Function .onInit
!ifdef BOOTSTRAP
  WriteUninstaller "${UNINSTALLER}"
  IfErrors generator_failed
  SetErrorLevel 0
  Quit
generator_failed:
  SetErrorLevel 1
  Quit
!else
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "$(UnsupportedArchitecture)" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetRegView 64
  ; NSIS strips the special /D= argument from $CMDLINE. Read Windows' original
  ; command line before MultiUser resets the default/registered directory.
  System::Call 'kernel32::GetCommandLineW() w .r0'
  StrCpy $rawCommandLine $0
  !insertmacro MULTIUSER_INIT
  ClearErrors
  ${GetOptions} $rawCommandLine "/D=" $0
  ${IfNot} ${Errors}
    StrCpy $INSTDIR $0
  ${EndIf}
  ${GetParameters} $parameters
  StrCpy $updating ""
  ClearErrors
  ${GetOptions} $parameters "--updated" $0
  ${IfNot} ${Errors}
    StrCpy $updating "--updated"
  ${EndIf}
  ; The updater has already stopped the application. An existing installation's
  ; registered location wins over the default, unless NSIS received /D=.
!endif
FunctionEnd

Section "Install"
!ifndef BOOTSTRAP
  ReadRegStr $previousDirectory SHCTX "${INSTALL_KEY}" "InstallLocation"
  ReadRegStr $oldUninstaller SHCTX "${UNINSTALL_KEY}" "UninstallString"
  ${If} $previousDirectory != ""
  ${AndIf} $oldUninstaller != ""
    ; Preserve application data and ask the previous installer to clean its own
    ; files. This also supports upgrades from deployed electron-builder output.
    ; A failed launch has no defined exit code, so inspect its error flag too.
    ClearErrors
    ExecWait '$oldUninstaller /S --updated _?=$previousDirectory' $0
    ${If} ${Errors}
    ${OrIf} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "$(PreviousUninstallFailed)" /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
  SetOutPath "$INSTDIR"
  ClearErrors
  File /r "${APPLICATION}\*"
  File /oname=Uninstall.exe "${UNINSTALLER}"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "$(WriteFailed)" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  FileOpen $0 "$INSTDIR\resources\package-type" w
  FileWrite $0 "nsis$\r$\n"
  FileClose $0
  WriteRegStr SHCTX "${INSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr SHCTX "${INSTALL_KEY}" "KeepShortcuts" "true"
  WriteRegStr SHCTX "${INSTALL_KEY}" "ShortcutName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME} ${VERSION}"
  WriteRegStr SHCTX "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_NAME}.exe,0"
  WriteRegStr SHCTX "${UNINSTALL_KEY}" "Publisher" "Myoxus Contributors"
  WriteRegStr SHCTX "${UNINSTALL_KEY}" "URLInfoAbout" "${PROJECT_URL}"
  WriteRegStr SHCTX "${UNINSTALL_KEY}" "HelpLink" "${PROJECT_URL}"
  StrCpy $1 "/CurrentUser"
  ${If} $MultiUser.InstallMode == "AllUsers"
    StrCpy $1 "/AllUsers"
  ${EndIf}
  WriteRegStr SHCTX "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\" $1'
  WriteRegStr SHCTX "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" $1 /S'
  WriteRegDWORD SHCTX "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD SHCTX "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD SHCTX "${UNINSTALL_KEY}" "EstimatedSize" $0
  WriteRegStr SHCTX "Software\Classes\${PACKAGE_NAME}" "" "URL:${PRODUCT_NAME}"
  WriteRegStr SHCTX "Software\Classes\${PACKAGE_NAME}" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\${PACKAGE_NAME}\DefaultIcon" "" "$INSTDIR\${PRODUCT_NAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${PACKAGE_NAME}\shell\open\command" "" '$\"$INSTDIR\${PRODUCT_NAME}.exe$\" $\"%1$\"'
  CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
  ${If} ${Silent}
    ClearErrors
    ${GetOptions} $parameters "--force-run" $0
    ${IfNot} ${Errors}
      Call LaunchApplication
    ${EndIf}
  ${EndIf}
!endif
SectionEnd

Function LaunchApplication
!ifndef BOOTSTRAP
  StrCpy $0 '$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$INSTDIR\resources\windows-launch.ps1$\" -Application $\"$INSTDIR\${PRODUCT_NAME}.exe$\"'
  ${If} $updating == "--updated"
    StrCpy $0 "$0 -Updated"
  ${EndIf}
  Exec '$0'
!endif
FunctionEnd

Function un.onInit
  SetRegView 64
  !insertmacro MULTIUSER_UNINIT
  ReadRegStr $0 SHCTX "${INSTALL_KEY}" "InstallLocation"
  ; Refuse removal outside this channel's registered application directory.
  ${If} $0 != $INSTDIR
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd

Section "Uninstall"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  DeleteRegKey SHCTX "${UNINSTALL_KEY}"
  DeleteRegKey SHCTX "${INSTALL_KEY}"
  DeleteRegKey SHCTX "Software\Classes\${PACKAGE_NAME}"
  RMDir /r "$INSTDIR"
  ; User data is retained for upgrades and ordinary uninstall alike.
SectionEnd
