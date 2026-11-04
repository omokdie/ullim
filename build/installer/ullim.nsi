; 울림 (Ullim) — 윈도우 설치 프로그램 (NSIS, 사용자별 설치 · 관리자 권한 불필요)
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!define APPNAME   "울림"
!define VERSION   "1.2.1"
!define PUBLISHER "Ullim"
!define EXE       "Ullim.exe"
!define AUMID     "kr.ullim.player"
!define REGAPP    "Software\Ullim"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ullim"
!define PROGID    "Ullim.Audio"
!ifndef SRC
  !define SRC "../win/Ullim"
!endif
!ifndef OUTFILE
  !define OUTFILE "Ullim-Setup-${VERSION}.exe"
!endif

!addplugindir /x86-unicode "${PLUGINS}"

Name "${APPNAME}"
Caption "${APPNAME} ${VERSION} 설치"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Ullim"
InstallDirRegKey HKCU "${REGAPP}" "InstallDir"
RequestExecutionLevel user
BrandingText "${APPNAME} ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

VIProductVersion "1.2.1.0"
VIAddVersionKey /LANG=1042 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=1042 "FileDescription" "${APPNAME} 설치 프로그램"
VIAddVersionKey /LANG=1042 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=1042 "LegalCopyright" "${APPNAME}"
VIAddVersionKey /LANG=1042 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1042 "ProductVersion" "${VERSION}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "wizard.bmp"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "${APPNAME} 설치를 시작합니다"
!define MUI_WELCOMEPAGE_TEXT "무료 음장 효과 40가지와 10밴드 이퀄라이저를 담은 음악 플레이어 '${APPNAME}'을(를) 이 컴퓨터에 설치합니다.$\r$\n$\r$\n관리자 권한 없이 지금 사용자에게만 설치되며, 시작 메뉴와 바탕 화면에 바로 가기가 만들어집니다.$\r$\n$\r$\n[다음]을 눌러 계속하세요."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "설치가 끝났습니다"
!define MUI_FINISHPAGE_TEXT "'${APPNAME}'이(가) 설치되었습니다.$\r$\n시작 메뉴나 바탕 화면의 '${APPNAME}'으로 실행할 수 있고, 음악 파일을 오른쪽 클릭한 뒤 [연결 프로그램]에서도 고를 수 있어요."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "지금 ${APPNAME} 실행하기"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Korean"

; 실행 중인 울림 닫기
;  - 조용한 설치(/S, 앱의 자동 업데이트)는 앱이 스스로 닫힐 때까지(설정 · 재생목록 저장) 최대 10초 기다린 뒤에만 강제로 닫는다
!macro CloseApp UN
  nsProcess::_FindProcess "${EXE}"
  Pop $R0
  ${If} $R0 == 0
    ${If} ${Silent}
      StrCpy $R1 0
      ${DoWhile} $R1 < 40
        Sleep 250
        nsProcess::_FindProcess "${EXE}"
        Pop $R0
        ${If} $R0 != 0
          ${ExitDo}
        ${EndIf}
        IntOp $R1 $R1 + 1
      ${Loop}
    ${Else}
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "${APPNAME}이(가) 실행 중이에요. [확인]을 누르면 닫고 계속합니다." IDOK +2
      Abort
    ${EndIf}
    ${If} $R0 == 0
      nsProcess::_KillProcess "${EXE}"
      Pop $R0
      Sleep 800
    ${EndIf}
  ${EndIf}
!macroend

!macro Assoc EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}\SupportedTypes" ".${EXT}" ""
  WriteRegStr HKCU "${REGAPP}\Capabilities\FileAssociations" ".${EXT}" "${PROGID}"
!macroend
!macro UnAssoc EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}"
!macroend

Section "install"
  !insertmacro CloseApp ""
  SetOutPath "$INSTDIR"
  ; 이전 버전의 앱 파일은 지우고 새로 복사 (설정 · 재생목록은 사용자 폴더라 그대로 남음)
  RMDir /r "$INSTDIR\resources\app"
  File /r /x "README.txt" "${SRC}/*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 바로 가기 (작업 표시줄 · 미디어 컨트롤이 같은 앱으로 묶이도록 AUMID 지정)
  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0 SW_SHOWNORMAL "" "음장 효과 음악 플레이어"
  WinShell::SetLnkAUMI "$SMPROGRAMS\${APPNAME}.lnk" "${AUMID}"
  ; 바탕 화면 바로 가기: 자동 업데이트(/S) 때는 사용자가 지웠다면 다시 만들지 않음
  ${IfNot} ${Silent}
  ${OrIf} ${FileExists} "$DESKTOP\${APPNAME}.lnk"
    CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0 SW_SHOWNORMAL "" "음장 효과 음악 플레이어"
    WinShell::SetLnkAUMI "$DESKTOP\${APPNAME}.lnk" "${AUMID}"
  ${EndIf}

  ; 연결 프로그램 · 기본 앱 목록에 등록 (기본 앱을 몰래 바꾸지는 않음)
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "음악 파일"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}" "FriendlyAppName" "${APPNAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "${REGAPP}\Capabilities" "ApplicationName" "${APPNAME}"
  WriteRegStr HKCU "${REGAPP}\Capabilities" "ApplicationDescription" "무료 음장 효과를 담은 음악 플레이어"
  WriteRegStr HKCU "${REGAPP}\Capabilities" "ApplicationIcon" "$INSTDIR\${EXE},0"
  !insertmacro Assoc "mp3"
  !insertmacro Assoc "m4a"
  !insertmacro Assoc "m4b"
  !insertmacro Assoc "aac"
  !insertmacro Assoc "flac"
  !insertmacro Assoc "ogg"
  !insertmacro Assoc "oga"
  !insertmacro Assoc "opus"
  !insertmacro Assoc "wav"
  !insertmacro Assoc "weba"
  WriteRegStr HKCU "Software\RegisteredApplications" "Ullim" "${REGAPP}\Capabilities"

  ; 프로그램 추가/제거 (설정 > 앱)
  WriteRegStr HKCU "${REGAPP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; 앱의 '지금 다시 시작'(자동 업데이트): 설치가 끝나면 새 버전을 다시 연다
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/RELAUNCH" $R1
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\${EXE}"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  !insertmacro CloseApp "un."
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "Software\Classes\${PROGID}"
  DeleteRegKey HKCU "Software\Classes\Applications\${EXE}"
  !insertmacro UnAssoc "mp3"
  !insertmacro UnAssoc "m4a"
  !insertmacro UnAssoc "m4b"
  !insertmacro UnAssoc "aac"
  !insertmacro UnAssoc "flac"
  !insertmacro UnAssoc "ogg"
  !insertmacro UnAssoc "oga"
  !insertmacro UnAssoc "opus"
  !insertmacro UnAssoc "wav"
  !insertmacro UnAssoc "weba"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Ullim"
  DeleteRegKey HKCU "${REGAPP}"
  DeleteRegKey HKCU "${UNINSTKEY}"

  ; 설정 · 재생목록 (사용자 데이터) 은 물어보고 지움
  IfSilent done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "재생목록과 음장 설정도 함께 지울까요?$\r$\n(다시 설치할 때 이어서 쓰려면 [아니요])" IDNO done
  RMDir /r "$APPDATA\Ullim"
  done:
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd
