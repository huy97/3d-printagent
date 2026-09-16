import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { run, tryRun } from '../util/exec.js';
import { PATHS } from '../core/paths.js';
import { badRequest } from '../util/errors.js';

const LABEL = 'com.3dprintagent.agent';
const TASK_NAME = '3DPrintAgent';
const UNIT_NAME = '3d-printagent.service';

export function entryScript() {
  return path.resolve(fileURLToPath(new URL('../../bin/3d-printagent.js', import.meta.url)));
}

function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function unitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME);
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPlist() {
  const args = [process.execPath, entryScript(), 'start']
    .map((item) => `    <string>${escapeXml(item)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(path.join(PATHS.logs, 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(PATHS.logs, 'service.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function buildUnit() {
  return `[Unit]
Description=3D PrintAgent - 3D printer agent
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${entryScript()} start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function installDarwin() {
  const target = plistPath();
  mkdirSync(path.dirname(target), { recursive: true });
  mkdirSync(PATHS.logs, { recursive: true });
  writeFileSync(target, buildPlist());
  await tryRun('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
  const result = await tryRun('launchctl', ['bootstrap', `gui/${process.getuid()}`, target]);
  if (result.failed) {
    const legacy = await tryRun('launchctl', ['load', '-w', target]);
    if (legacy.failed) throw badRequest('error.service_launchd', { message: result.stderr || legacy.stderr });
  }
  return { manager: 'launchd', unit: target };
}

async function uninstallDarwin() {
  const target = plistPath();
  await tryRun('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
  await tryRun('launchctl', ['unload', '-w', target]);
  if (existsSync(target)) rmSync(target);
  return { manager: 'launchd', unit: target };
}

async function statusDarwin() {
  const target = plistPath();
  if (!existsSync(target)) return { installed: false, running: false, manager: 'launchd', unit: target };
  const result = await tryRun('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]);
  return {
    installed: true,
    running: !result.failed && /state = running/.test(result.stdout),
    manager: 'launchd',
    unit: target,
  };
}

async function installLinux() {
  const target = unitPath();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, buildUnit());
  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
  await tryRun('loginctl', ['enable-linger', os.userInfo().username]);
  return { manager: 'systemd', unit: target };
}

async function uninstallLinux() {
  const target = unitPath();
  await tryRun('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  if (existsSync(target)) rmSync(target);
  await tryRun('systemctl', ['--user', 'daemon-reload']);
  return { manager: 'systemd', unit: target };
}

async function statusLinux() {
  const target = unitPath();
  if (!existsSync(target)) return { installed: false, running: false, manager: 'systemd', unit: target };
  const result = await tryRun('systemctl', ['--user', 'is-active', UNIT_NAME]);
  return {
    installed: true,
    running: result.stdout.trim() === 'active',
    manager: 'systemd',
    unit: target,
  };
}

function shimPath() {
  return path.join(PATHS.data, '3d-printagent-service.vbs');
}

function taskXmlPath() {
  return path.join(PATHS.data, '3d-printagent-task.xml');
}

/**
 * Task Scheduler chạy thẳng node.exe sẽ bật cửa sổ console đen mỗi lần đăng
 * nhập, nên đi vòng qua wscript để tiến trình chạy hoàn toàn ẩn.
 */
export function buildVbsShim(nodeBinary = process.execPath, script = entryScript()) {
  const command = `""${nodeBinary}"" ""${script}"" start`;
  return `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "${command}", 0, False\r\n`;
}

function taskUser() {
  const name = process.env.USERNAME || os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
}

/**
 * Dùng XML thay cho /TR để khỏi phụ thuộc cách schtasks tách chuỗi lệnh có dấu
 * cách và dấu ngoặc kép.
 */
export function buildTaskXml({ user = taskUser(), command = 'wscript.exe', args = `//B "${shimPath()}"` } = {}) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>3D PrintAgent - 3D printer agent</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

async function registerTask(xml, fallbackCommand) {
  // schtasks chỉ đọc được XML dạng UTF-16 có BOM.
  writeFileSync(taskXmlPath(), `﻿${xml}`, 'utf16le');
  const result = await tryRun('schtasks.exe', ['/Create', '/TN', TASK_NAME, '/XML', taskXmlPath(), '/F']);
  if (result.failed) {
    await run('schtasks.exe', ['/Create', '/SC', 'ONLOGON', '/TN', TASK_NAME, '/TR', fallbackCommand, '/RL', 'LIMITED', '/F']);
  }
  await tryRun('schtasks.exe', ['/Run', '/TN', TASK_NAME]);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return statusWindows();
}

async function installWindows() {
  mkdirSync(PATHS.data, { recursive: true });
  mkdirSync(PATHS.logs, { recursive: true });
  writeFileSync(shimPath(), buildVbsShim());

  let status = await registerTask(buildTaskXml(), `wscript.exe //B "${shimPath()}"`);
  if (!status.running) {
    // Máy tắt Windows Script Host thì shim không chạy được, quay về gọi thẳng node.
    const args = `"${entryScript()}" start`;
    status = await registerTask(
      buildTaskXml({ command: process.execPath, args }),
      `"${process.execPath}" ${args}`,
    );
  }
  return { manager: 'schtasks', unit: TASK_NAME };
}

async function uninstallWindows() {
  const current = await statusWindows();
  await tryRun('schtasks.exe', ['/End', '/TN', TASK_NAME]);
  if (current.installed) {
    const result = await tryRun('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F']);
    if (result.failed && (await statusWindows()).installed) {
      throw badRequest('error.service_task_delete', { message: result.stderr });
    }
  }
  for (const file of [shimPath(), taskXmlPath()]) {
    if (existsSync(file)) rmSync(file);
  }
  return { manager: 'schtasks', unit: TASK_NAME };
}

async function statusWindows() {
  // Get-ScheduledTask trả trạng thái không đổi theo ngôn ngữ Windows.
  const viaPowershell = await tryRun('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$task = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; if ($task) { $task.State } else { 'missing' }`,
  ]);
  if (!viaPowershell.failed) {
    const state = viaPowershell.stdout.trim();
    if (state === 'missing') return { installed: false, running: false, manager: 'schtasks', unit: TASK_NAME };
    return { installed: true, running: state === 'Running', manager: 'schtasks', unit: TASK_NAME };
  }

  const result = await tryRun('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST']);
  return {
    installed: !result.failed,
    running: !result.failed && /Running/i.test(result.stdout),
    manager: 'schtasks',
    unit: TASK_NAME,
  };
}

const IMPL = {
  darwin: { install: installDarwin, uninstall: uninstallDarwin, status: statusDarwin },
  linux: { install: installLinux, uninstall: uninstallLinux, status: statusLinux },
  win32: { install: installWindows, uninstall: uninstallWindows, status: statusWindows },
};

function impl() {
  const found = IMPL[process.platform];
  if (!found) throw badRequest('error.service_unsupported', { platform: process.platform });
  return found;
}

export function installService() {
  return impl().install();
}

export function uninstallService() {
  return impl().uninstall();
}

export async function serviceStatus() {
  const found = IMPL[process.platform];
  if (!found) return { installed: false, running: false, manager: null, unit: null, supported: false };
  return { ...(await found.status()), supported: true };
}

export function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? [process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
