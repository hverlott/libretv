#!/usr/bin/env node
// Merge tested Android additions without reordering existing env_N source keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const envFile=path.join(root,'.env');
const additions=JSON.parse(fs.readFileSync(path.join(root,'public/android-sources.json'),'utf8'));
let text=fs.readFileSync(envFile,'utf8');
for(const [key,items]of [['DEFAULT_SOURCES',additions.sources],['DEFAULT_LIVE_SOURCES',additions.liveSources]]){
  const pattern=new RegExp('^'+key+'=(.*)$','m');
  const found=text.match(pattern);
  let raw=found?.[1]?.trim()||'[]';
  if((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"')))raw=raw.slice(1,-1);
  const existing=JSON.parse(raw);
  if(!Array.isArray(existing))throw Error(key+' must be an array; no files changed');
  const seen=new Set(existing.map(x=>x.url.replace(/\/+$/,'')));
  let added=0;
  for(const item of items){const url=item.url.replace(/\/+$/,'');if(!seen.has(url)){existing.push(item);seen.add(url);added++;}}
  const line=key+'='+JSON.stringify(existing);
  text=found?text.replace(pattern,()=>line):text.replace(/\s*$/,'')+'\n'+line+'\n';
  console.log(`${key}: +${added}, total ${existing.length}`);
}
if(process.argv.includes('--write')){
  const backup=envFile+`.before-android-${Date.now()}`;
  fs.copyFileSync(envFile,backup);fs.chmodSync(backup,0o600);
  const temp=envFile+'.android-tmp';fs.writeFileSync(temp,text,{mode:0o600});fs.renameSync(temp,envFile);
  console.log('Saved. Restart LibreTV to apply.');
}else console.log('Preview only. Add --write to save.');
