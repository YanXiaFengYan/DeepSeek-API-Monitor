const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const projectDir = __dirname;
const electronExe = path.join(projectDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const desktopDir = path.join(os.homedir(), 'Desktop');
const shortcutPath = path.join(desktopDir, 'DeepSeek Monitor.lnk');

if (!fs.existsSync(electronExe)) {
  console.error('❌ 未找到 electron.exe，请先运行 npm install');
  process.exit(1);
}

const psContent = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
$sc.TargetPath = '${electronExe.replace(/'/g, "''")}'
$sc.Arguments = '${projectDir.replace(/'/g, "''")}'
$sc.WorkingDirectory = '${projectDir.replace(/'/g, "''")}'
$sc.Description = 'DeepSeek Monitor'
$sc.WindowStyle = 7
$sc.Save()
Write-Host 'Shortcut created successfully'
`;

const psPath = path.join(__dirname, '_temp_shortcut.ps1');
fs.writeFileSync(psPath, psContent, 'utf-8');

try {
  execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`,
    { stdio: 'inherit' }
  );
} catch (err) {
  console.error('❌ 创建失败:', err.message);
} finally {
  try { fs.unlinkSync(psPath); } catch (_) {}
}
