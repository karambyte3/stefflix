; Extra steps for the NSIS installer (electron-builder.yml -> nsis.include).
;
; The TV reaches the server over the home network, so Windows Firewall has to let Stefflix in.
; Without this rule Windows asks on the first start, and a "Cancel" there silently breaks the TV.
; Private networks only: the server isn't opened up on public Wi-Fi.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Stefflix"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Stefflix" dir=in action=allow program="$INSTDIR\Stefflix.exe" enable=yes profile=private'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Stefflix"'
!macroend
