'use strict';
/* 浏览器流程自检：node test/browser.js
 * 起一个静态服务器，用无头 Chrome/Edge 打开 map.html?selftest=1，页面内脚本按
 * "选点 → 切换六种算法 → 完成 → 重置 → 街道名选点 → 并排对比 → 四个引导案例" 跑一遍，
 * 结果写进 <title> 与 <pre id="selftest">；本脚本读 --dump-dom 判定。
 * 找不到浏览器时跳过（退出码 0，但会打印提示）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const browser = CANDIDATES.find(p => fs.existsSync(p));
if (!browser) { console.log('browser test: 未找到 Chrome/Edge（可设 CHROME_PATH），跳过'); process.exit(0); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
  res.setHeader('Content-Length', fs.statSync(p).size);
  fs.createReadStream(p).pipe(res);
});
server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/map.html?selftest=1`;
  const t0 = Date.now();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'maproute-chrome-'));
  /* 必须异步 spawn：同步等待会阻塞事件循环，本进程里的静态服务器就没法响应浏览器的请求 */
  const child = spawn(browser, [`--user-data-dir=${profile}`, '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--virtual-time-budget=8000', '--dump-dom', url]);
  let dom = '', err = '';
  child.stdout.on('data', d => { dom += d; });
  child.stderr.on('data', d => { err += d; });
  const killer = setTimeout(() => { console.error('browser test: 超时，终止浏览器'); child.kill(); }, 180000);
  child.on('close', () => {
    clearTimeout(killer); server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const title = (dom.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const m = dom.match(/<pre id="selftest"[^>]*>([\s\S]*?)<\/pre>/);
    let report = null;
    if (m) { try { report = JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); } catch (e) { /* ignore */ } }
    console.log(`browser test: ${path.basename(browser)}，${((Date.now() - t0) / 1000).toFixed(1)} s，title = "${title}"`);
    if (report) {
      for (const x of report.results) console.log(`  ${x.ok ? 'ok ' : 'FAIL'} ${x.m}`);
      if (report.perf) console.log('  perf:', JSON.stringify(report.perf));
    }
    if (title !== 'SELFTEST OK') {
      console.error('browser test FAILED');
      if (!m) console.error(err.split('\n').filter(l => !/ERROR:|TensorFlow/.test(l)).join('\n').slice(0, 2000));
      process.exit(1);
    }
    console.log('browser test 全部通过');
  });
});
