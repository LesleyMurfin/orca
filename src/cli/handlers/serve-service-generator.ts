export function generateServiceManifest(flags: Map<string, string | boolean>): string {
  switch (process.platform) {
    case 'linux':
      return generateSystemdUnit(flags)
    case 'darwin':
      return generateLaunchdPlist(flags)
    case 'win32':
      return generateWindowsScheduledTask(flags)
    default:
      return generateSystemdUnit(flags)
  }
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '&':
        return '&amp;'
      case "'":
        return '&apos;'
      case '"':
        return '&quot;'
      default:
        return c
    }
  })
}

function buildServeProgramArgs(flags: Map<string, string | boolean>): string[] {
  const args = []
  const port = flags.get('port')
  if (port) {
    args.push('--port', String(port))
  }
  const pairing = flags.get('pairing-address')
  if (pairing) {
    args.push('--pairing-address', String(pairing))
  }
  return args
}

function generateSystemdUnit(flags: Map<string, string | boolean>): string {
  const isUserUnit = flags.get('user') === true
  const programArgs = buildServeProgramArgs(flags)
  const execPath = process.platform === 'linux' ? '/usr/bin/orca-ide' : process.execPath
  const execStart = [execPath, 'serve', ...programArgs].join(' ')
  const userBlock = isUserUnit
    ? ''
    : `User=orca\nGroup=orca\nWorkingDirectory=/home/orca\nEnvironment=HOME=/home/orca\nEnvironment=XDG_RUNTIME_DIR=/run/user/1001\n`
  const wantedBy = isUserUnit ? 'default.target' : 'multi-user.target'
  const description = isUserUnit ? 'Orca runtime server (user)' : 'Orca runtime server'
  const wants = isUserUnit ? '' : 'Wants=network-online.target\n'
  const after = isUserUnit ? 'After=network.target' : 'After=network-online.target'

  return `[Unit]
Description=${description}
${wants}${after}
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
${userBlock}ExecStart=${execStart}
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=3 78
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=45
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=${wantedBy}`
}

function generateLaunchdPlist(flags: Map<string, string | boolean>): string {
  const isUserUnit = flags.get('user') === true
  const execPath = escapeXml(process.platform === 'linux' ? '/usr/bin/orca-ide' : process.execPath)
  const programArgs = ['serve', ...buildServeProgramArgs(flags)]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join('\n')
  const identityBlock = isUserUnit
    ? ''
    : `  <key>UserName</key>\n  <string>orca</string>\n  <key>GroupName</key>\n  <string>orca</string>\n  <key>WorkingDirectory</key>\n  <string>/Users/orca</string>\n`

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.orca.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execPath}</string>
${programArgs}
  </array>
${identityBlock}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/orca-serve.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/orca-serve.err</string>
</dict>
</plist>`
}

function generateWindowsScheduledTask(flags: Map<string, string | boolean>): string {
  const isUserUnit = flags.get('user') === true
  const execPath = escapeXml(process.platform === 'linux' ? '/usr/bin/orca-ide' : process.execPath)
  const argumentsXml = escapeXml(['serve', ...buildServeProgramArgs(flags)].join(' '))
  const description = isUserUnit ? 'Orca runtime server (user)' : 'Orca runtime server'
  const trigger = isUserUnit
    ? `    <LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>`
    : `    <BootTrigger>\n      <Enabled>true</Enabled>\n    </BootTrigger>`
  const principal = isUserUnit
    ? `    <Principal id="Author">\n      <LogonType>InteractiveToken</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>\n    </Principal>`
    : `    <Principal id="Author">\n      <UserId>S-1-5-18</UserId>\n      <LogonType>ServiceAccount</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>\n    </Principal>`

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${description}</Description>
    <URI>\\OrcaServe</URI>
  </RegistrationInfo>
  <Triggers>
${trigger}
  </Triggers>
  <Principals>
${principal}
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>5</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${execPath}</Command>
      <Arguments>${argumentsXml}</Arguments>
    </Exec>
  </Actions>
</Task>`
}
