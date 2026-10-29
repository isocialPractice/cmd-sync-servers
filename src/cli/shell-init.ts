export const SHELLS = ['bash', 'zsh', 'fish', 'pwsh', 'cmd'] as const;
export type Shell = (typeof SHELLS)[number];

const POSIX = `ssv() {
  local f rc
  f="$(mktemp)" || return
  command sync-servers --cd-file "$f" "$@"; rc=$?
  if [ -s "$f" ]; then cd -- "$(cat -- "$f")" || rc=$?; fi
  rm -f -- "$f"
  return "$rc"
}
`;

const SCRIPTS: Readonly<Record<Shell, string>> = {
  bash: `# sync-servers shell integration for bash.
# Add this line to ~/.bashrc:
#   eval "$(sync-servers shell-init bash)"
# Then "ssv" runs sync-servers and changes to the folder of the site you choose.
${POSIX}`,
  zsh: `# sync-servers shell integration for zsh.
# Add this line to ~/.zshrc:
#   eval "$(sync-servers shell-init zsh)"
# Then "ssv" runs sync-servers and changes to the folder of the site you choose.
${POSIX}`,
  fish: `# sync-servers shell integration for fish.
# Save it as a function file:
#   sync-servers shell-init fish > ~/.config/fish/functions/ssv.fish
# Then "ssv" runs sync-servers and changes to the folder of the site you choose.
function ssv --description 'Run sync-servers and change to the chosen site folder'
    set -l f (mktemp); or return
    command sync-servers --cd-file $f $argv
    set -l rc $status
    if test -s $f
        cd (cat $f); or set rc $status
    end
    rm -f $f
    return $rc
end
`,
  pwsh: `# sync-servers shell integration for PowerShell.
# Add this line to your profile ($PROFILE):
#   Invoke-Expression (& sync-servers shell-init pwsh | Out-String)
# Then "ssv" runs sync-servers and changes to the folder of the site you choose.
function ssv {
  $f = [System.IO.Path]::GetTempFileName()
  try {
    & sync-servers --cd-file $f @args
    $rc = $LASTEXITCODE
    $target = Get-Content -LiteralPath $f -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($target) { Set-Location -LiteralPath $target }
  } finally {
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
  }
  $global:LASTEXITCODE = $rc
}
`,
  cmd: `@echo off
rem sync-servers shell integration for cmd.exe.
rem Save it as ssv.cmd in a folder on PATH:
rem   sync-servers shell-init cmd > "%USERPROFILE%\\bin\\ssv.cmd"
rem Then "ssv" runs sync-servers and changes to the folder of the site you choose.
setlocal
set "SSV_FILE=%TEMP%\\sync-servers-cd-%RANDOM%%RANDOM%.txt"
type nul > "%SSV_FILE%"
call sync-servers --cd-file "%SSV_FILE%" %*
set "SSV_RC=%ERRORLEVEL%"
set "SSV_DIR="
set /p SSV_DIR=<"%SSV_FILE%"
del "%SSV_FILE%" 2>nul
endlocal & set "SSV_DIR=%SSV_DIR%" & set "SSV_RC=%SSV_RC%"
if defined SSV_DIR cd /d "%SSV_DIR%"
set "SSV_DIR=" & set "SSV_RC=" & exit /b %SSV_RC%
`,
};

/** The shell function (or batch file, for cmd) that wraps `sync-servers --cd-file`. */
export function shellInitScript(shell: Shell): string {
  const script = SCRIPTS[shell];
  return shell === 'cmd' ? script.replace(/\n/g, '\r\n') : script;
}

export function isShell(name: string): name is Shell {
  return (SHELLS as readonly string[]).includes(name);
}
