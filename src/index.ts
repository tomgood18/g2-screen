import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer
} from '@evenrealities/even_hub_sdk';

type AppState = 'setup' | 'connecting' | 'ready' | 'listening' | 'processing' | 'result' | 'error';

let bridge: any = null;
let ws: WebSocket | null = null;
let isFirstRender = true;
let appState: AppState = 'setup';
let lastAnswer = '';
let errorMsg = '';

function loadConfig(): { ip: string; key: string } {
  return {
    ip: localStorage.getItem('desktop_ip') || '',
    key: localStorage.getItem('claude_api_key') || ''
  };
}

// ================= WEBSOCKET =================

function connectWebSocket(ip: string) {
  appState = 'connecting';
  renderWebUI();
  updateGlassesUI(true);

  ws = new WebSocket(`ws://${ip}:8765`);

  ws.onopen = () => {
    appState = 'ready';
    renderWebUI();
    updateGlassesUI(true);
  };

  ws.onclose = () => {
    if (appState !== 'setup') {
      appState = 'connecting';
      renderWebUI();
      updateGlassesUI(true);
      setTimeout(() => connectWebSocket(ip), 3000);
    }
  };

  ws.onerror = () => {
    errorMsg = 'Cannot reach desktop server';
    appState = 'error';
    renderWebUI();
    updateGlassesUI(true);
  };
}

function captureScreen(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WebSocket not connected'));
      return;
    }
    const handler = (event: MessageEvent) => {
      ws!.removeEventListener('message', handler);
      try {
        resolve(JSON.parse(event.data).screenshot);
      } catch {
        reject(new Error('Invalid screenshot response'));
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ type: 'capture' }));
  });
}

// ================= VOICE =================

function startListening(): Promise<string> {
  return new Promise((resolve, reject) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { reject(new Error('Speech recognition not supported in this browser')); return; }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = 'en-AU';
    rec.onresult = (e: any) => resolve(e.results[0][0].transcript);
    rec.onerror = (e: any) => reject(new Error(e.error));
    rec.start();
  });
}

// ================= CLAUDE =================

async function askClaude(screenshot: string, question: string): Promise<string> {
  const { key } = loadConfig();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 80,
      system: 'You are answering questions about a computer screen. Reply in plain text, max 2 short lines, no markdown, no punctuation beyond periods. Be direct.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot } },
          { type: 'text', text: question }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

// ================= FLOW =================

async function handleAsk() {
  try {
    appState = 'listening';
    updateGlassesUI(true);

    const question = await startListening();

    appState = 'processing';
    updateGlassesUI(true);

    const [screenshot] = await Promise.all([captureScreen()]);
    const answer = await askClaude(screenshot, question);

    lastAnswer = answer.replace(/\n+/g, ' ');
    appState = 'result';
    updateGlassesUI(true);
  } catch (e: any) {
    errorMsg = e.message || 'Something went wrong';
    appState = 'error';
    updateGlassesUI(true);
  }
}

// ================= GLASSES UI =================

function getDisplayContent(): string {
  switch (appState) {
    case 'connecting':  return '   G2 SCREEN\n   Connecting to desktop...';
    case 'ready':       return '   G2 SCREEN\n   Ready';
    case 'listening':   return '   LISTENING\n   Speak your question';
    case 'processing':  return '   THINKING\n   ';
    case 'result':      return `   ${lastAnswer}`;
    case 'error':       return `   ERROR\n   ${errorMsg.substring(0, 40)}`;
    default:            return '   G2 SCREEN\n   Setup required in app';
  }
}

function getListItems(): string[] {
  switch (appState) {
    case 'ready':      return ['ASK'];
    case 'result':     return ['ASK AGAIN', 'DONE'];
    case 'error':      return ['RETRY'];
    default:           return ['WAIT'];
  }
}

async function updateGlassesUI(forceRefresh = false) {
  if (!bridge) return;
  const content = getDisplayContent();
  const items = getListItems();

  try {
    const textObj = TextContainerProperty.fromJson({
      xPosition: 10, yPosition: 10, width: 550, height: 85,
      containerID: 1, containerName: 'text_box',
      content, isEventCapture: 0, borderWidth: 1, borderColor: 7
    });
    const listObj = ListContainerProperty.fromJson({
      xPosition: 10, yPosition: 100, width: 550, height: 175,
      containerID: 2, containerName: 'list_box',
      itemContainer: ListItemContainerProperty.fromJson({
        itemCount: items.length, itemName: items, isItemSelectBorderEn: 1
      }),
      isEventCapture: 1
    });

    if (isFirstRender) {
      const container = CreateStartUpPageContainer.fromJson({
        containerTotalNum: 2, textObject: [textObj], listObject: [listObj]
      });
      const res = await bridge.createStartUpPageContainer(container);
      if (res === 0) isFirstRender = false;
    } else if (forceRefresh) {
      const container = RebuildPageContainer.fromJson({
        containerTotalNum: 2, textObject: [textObj], listObject: [listObj]
      });
      await bridge.rebuildPageContainer(container);
    } else {
      await bridge.textContainerUpgrade({
        containerID: 1, containerName: 'text_box', content
      });
    }
  } catch (e) { console.error(e); }
}

// ================= WEB UI =================

function renderWebUI() {
  const { ip, key } = loadConfig();
  document.body.style.cssText = 'margin:0;padding:0;background:#0a0a0a;color:white;font-family:monospace;display:flex;flex-direction:column;min-height:100vh;';

  if (!ip || !key) {
    document.body.innerHTML = `
      <div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:20px;gap:16px;">
        <h1 style="margin:0;font-size:1.5rem;letter-spacing:2px;">G2 SCREEN</h1>
        <p style="color:#666;margin:0;font-size:0.85rem;">Enter your desktop IP and Claude API key to begin</p>
        <input id="ip" placeholder="Desktop IP (e.g. 192.168.1.100)" value="${ip}"
          style="width:280px;padding:12px;background:#1a1a1a;border:1px solid #333;color:white;font-family:monospace;border-radius:4px;"/>
        <input id="key" type="password" placeholder="Claude API key (sk-ant-...)" value="${key}"
          style="width:280px;padding:12px;background:#1a1a1a;border:1px solid #333;color:white;font-family:monospace;border-radius:4px;"/>
        <button id="save-btn"
          style="padding:12px 32px;background:white;color:black;border:none;font-family:monospace;font-weight:bold;cursor:pointer;border-radius:4px;letter-spacing:1px;">
          CONNECT
        </button>
      </div>`;
    document.getElementById('save-btn')?.addEventListener('click', () => {
      const ipVal = (document.getElementById('ip') as HTMLInputElement).value.trim();
      const keyVal = (document.getElementById('key') as HTMLInputElement).value.trim();
      if (!ipVal || !keyVal) return;
      localStorage.setItem('desktop_ip', ipVal);
      localStorage.setItem('claude_api_key', keyVal);
      startApp();
    });
    return;
  }

  const statusColor: Record<AppState, string> = {
    setup: '#666', connecting: '#f0a500', ready: '#00cc66',
    listening: '#4da6ff', processing: '#f0a500', result: '#00cc66', error: '#cc3300'
  };
  const statusLabel: Record<AppState, string> = {
    setup: 'SETUP', connecting: 'CONNECTING', ready: 'READY',
    listening: 'LISTENING', processing: 'THINKING', result: 'ANSWER', error: 'ERROR'
  };

  document.body.innerHTML = `
    <div style="padding:20px 32px;background:#111;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:bold;letter-spacing:2px;">G2 SCREEN</span>
      <div style="display:flex;gap:12px;align-items:center;">
        <span style="color:${statusColor[appState]};font-size:0.75rem;letter-spacing:1px;">${statusLabel[appState]}</span>
        <button id="reset-btn" style="background:transparent;color:#555;border:1px solid #333;padding:6px 14px;font-family:monospace;font-size:0.75rem;cursor:pointer;border-radius:4px;">RESET</button>
      </div>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:20px;gap:8px;">
      ${appState === 'result'
        ? `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:24px;max-width:480px;width:100%;">
             <div style="color:#555;font-size:0.7rem;letter-spacing:2px;margin-bottom:12px;">ANSWER</div>
             <p style="margin:0;line-height:1.6;">${lastAnswer}</p>
           </div>`
        : `<p style="color:#555;">${statusLabel[appState]}...</p>`
      }
    </div>`;

  document.getElementById('reset-btn')?.addEventListener('click', () => {
    localStorage.removeItem('desktop_ip');
    localStorage.removeItem('claude_api_key');
    appState = 'setup';
    ws?.close();
    ws = null;
    renderWebUI();
  });
}

// ================= BRIDGE EVENTS =================

function handleEvent(e: any) {
  const idx = (e.listEvent || e.jsonData)?.currentSelectItemIndex ?? 0;

  switch (appState) {
    case 'ready':
      handleAsk();
      break;
    case 'result':
      if (idx === 0) handleAsk();       // ASK AGAIN
      else { appState = 'ready'; updateGlassesUI(true); }  // DONE
      break;
    case 'error':
      appState = 'ready';
      updateGlassesUI(true);
      break;
  }
}

// ================= ENTRY =================

async function startApp() {
  const { ip, key } = loadConfig();
  renderWebUI();

  if (!ip || !key) return;

  bridge = await waitForEvenAppBridge();
  connectWebSocket(ip);

  bridge.onEvenHubEvent((e: any) => handleEvent(e));
}

window.addEventListener('load', startApp);
