const { spawn } = require('node:child_process');
const child = spawn('python3', ['/opt/profile-archive.py', ...process.argv.slice(2)], { stdio: ['ignore', 'inherit', 'ignore'] });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', () => { process.exitCode = 1; });
