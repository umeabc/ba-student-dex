// Minimal Chrome DevTools Protocol driver: precise iPhone-sized screenshots
// and scripted interaction.  Usage: node tools/shot.js <plan.json>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333 + Math.floor(Math.random() * 300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  const r = await fetch(url);
  return r.json();
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const subs = this.events.get(msg.method) || [];
        subs.forEach((fn) => fn(msg.params));
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  on(method, fn) {
    const subs = this.events.get(method) || [];
    subs.push(fn);
    this.events.set(method, subs);
  }
}

async function main() {
  const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const tabs = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      target = tabs.find((t) => t.type === 'page');
      if (target) break;
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  if (!target) throw new Error('no chrome target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: plan.width || 390,
    height: plan.height || 844,
    deviceScaleFactor: plan.dpr || 3,
    mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });

  if (plan.preScript) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: plan.preScript });
  }

  const outDir = plan.outDir || 'shots';
  fs.mkdirSync(outDir, { recursive: true });

  let first = true;
  for (const shot of plan.shots) {
    if (shot.media) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: shot.media }] });
    } else {
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    }
    if (first || shot.url) {
      const loaded = new Promise((r) => cdp.on('Page.loadEventFired', r));
      await cdp.send('Page.navigate', { url: shot.url || plan.url });
      await loaded.catch(() => {});
      await sleep(shot.wait || 900);
    } else {
      await sleep(120);
    }
    first = false;
    if (shot.js) {
      const res = await cdp.send('Runtime.evaluate', { expression: shot.js, awaitPromise: true, returnByValue: true });
      if (res && res.exceptionDetails) console.log('JS ERROR', shot.name, JSON.stringify(res.exceptionDetails).slice(0, 500));
      else if (res && res.result && res.result.value !== undefined) console.log('JS', shot.name, JSON.stringify(res.result.value).slice(0, 600));
      await sleep(shot.after || 700);
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(outDir, shot.name + '.png');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('shot', file);
  }

  ws.close();
  child.kill();
  await sleep(200);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
