// Termux service supervisor. The launcher holds flock for this process tree.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime');
fs.mkdirSync(runtime, {recursive: true});
const logPath = path.join(runtime, 'termux-server.log');
const maxLogBytes = 2 * 1024 * 1024;
let bytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
function log(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes + buffer.length > maxLogBytes) {
    for (let i=2;i>=1;i--) {
      const from = i===1 ? logPath : `${logPath}.${i-1}`;
      const to = `${logPath}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from,to);
    }
    bytes=0;
  }
  fs.appendFileSync(logPath,buffer); bytes+=buffer.length;
}
let child, timer, stopping=false, delay=3000, stopTimer;
function stop(signal) {
  if (stopping) return;
  stopping=true; clearTimeout(timer);
  if (!child) return process.exit(0);
  child.kill(signal);
  stopTimer=setTimeout(()=>child?.kill('SIGKILL'),10000);
}
process.on('SIGINT',()=>stop('SIGINT'));
process.on('SIGTERM',()=>stop('SIGTERM'));
function start() {
  const since=Date.now();
  log(`\n[${new Date().toISOString()}] Starting LibreTV\n`);
  child=spawn(process.execPath,['server.js'],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',log); child.stderr.on('data',log);
  child.on('error',e=>log(`Spawn error: ${e.message}\n`));
  child.on('close',(code,signal)=>{
    child=null; clearTimeout(stopTimer);
    log(`Exited: code=${code}, signal=${signal}\n`);
    if(stopping || code===0 || code===130) return process.exit(0);
    if(Date.now()-since>60000)delay=3000;
    log(`Retry in ${delay/1000}s\n`);
    timer=setTimeout(start,delay); delay=Math.min(delay*2,60000);
  });
}
start();
