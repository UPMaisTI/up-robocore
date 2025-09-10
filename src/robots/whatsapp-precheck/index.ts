import type { Robot, RobotContext } from '../types';
import { WhatsPrecheckRepository } from './precheck.repository';
import { WhatsSpamRepository, SessionCfg } from '../whatsapp-spam/whatsapp-spam.repository';

type Runtime = {
  repo?: WhatsPrecheckRepository;
  spamRepo?: WhatsSpamRepository;
  ctx?: RobotContext;
  loop?: NodeJS.Timeout;
  state: 'idle' | 'running' | 'error' | 'stopped' | 'starting';
  lastError?: string;
  lastEvent?: string;
};

let runtime: Runtime | undefined;

function baseUrl() {
  const raw = process.env.WHATS_API_BASE || 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}
async function apiGet(path: string) {
  const url = `${baseUrl()}${path}`;
  const key = process.env.WHATS_API_KEY;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (key) headers['x-api-key'] = key;
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  try {
    const json = text ? JSON.parse(text) : {};
    if (!res.ok)
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    return json;
  } catch {
    if (!res.ok)
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    return { raw: text };
  }
}

async function isSessionReady(sessionId: string, ctx: RobotContext) {
  try {
    const s = await apiGet(`/sessions/${encodeURIComponent(sessionId)}/status`);
    const ready =
      s && (s.status === 'READY' || (s.message === 'ok' && s.state === 'READY'));
    if (!ready) ctx.log(`[whatsapp-precheck] nao READY: ${sessionId}`);
    return !!ready;
  } catch (e: any) {
    ctx.log(`[whatsapp-precheck] erro status ${sessionId}: ${String(e?.message || e)}`);
    return false;
  }
}

async function resolveChatId(
  sessionId: string,
  phone: string,
  ctx: RobotContext,
): Promise<string | null> {
  try {
    const r = await apiGet(
      `/messages/${encodeURIComponent(sessionId)}/resolve?phone=${encodeURIComponent(phone)}`,
    );
    const id = r?.chatId || r?.result?._serialized || r?.data?.id || null;
    if (!id) ctx.log(`[whatsapp-precheck] sem chatId: ${phone} (sess=${sessionId})`);
    return id;
  } catch (e: any) {
    ctx.log(
      `[whatsapp-precheck] erro resolve ${phone} (sess=${sessionId}): ${String(
        e?.message || e,
      )}`,
    );
    return null;
  }
}

function allSame(s: string): boolean {
  if (!s) return false;
  return /^(\d)\1+$/.test(s);
}

function normalizePhone(raw: string): string | null {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.replace(/^0+/, '');
  if (d.length === 11 || d.length === 10) d = '55' + d;
  if ((d.length === 11 && d.startsWith('55')) || (d.length === 12 && !d.startsWith('55')))
    d = '55' + d;
  if (!(d.startsWith('55') && (d.length === 12 || d.length === 13))) return null;
  const local = d.slice(2);
  if (allSame(local)) return null;
  return d;
}

async function tick(ctx: RobotContext) {
  if (!runtime?.repo || !runtime?.spamRepo) return;
  runtime.state = 'running';

  const batchSize = Number(process.env.WHATS_PRECHECK_BATCH || 500);
  const concurrency = Math.max(
    1,
    Math.min(100, Number(process.env.WHATS_PRECHECK_CONCURRENCY || 20)),
  );

  const items = await runtime.repo.fetchBatch(batchSize);
  if (!items.length) {
    runtime.lastEvent = 'fila vazia';
    return;
  }

  const sessions: SessionCfg[] = await runtime.spamRepo.listSessions();
  const readySessions: string[] = [];
  for (const s of sessions) {
    if (!s.enabled) continue;
    const ready = await isSessionReady(s.sessionId, ctx);
    if (ready) readySessions.push(s.sessionId);
  }

  let invalidCount = 0;
  let noChatCount = 0;
  let okCount = 0;

  const processOne = async (item: { cod: number; destino: string }) => {
    const cod = item.cod;
    const normalized = normalizePhone(item.destino);
    if (!normalized) {
      await runtime!.repo!.markInvalidNumber(cod);
      invalidCount++;
      return;
    }
    if (!readySessions.length) {
      // Sem sessões READY no momento: só validamos formato; deixa para depois resolver chatId
      okCount++;
      return;
    }
    let resolved = false;
    for (const sid of readySessions) {
      const id = await resolveChatId(sid, normalized, ctx);
      if (id) {
        resolved = true;
        break;
      }
    }
    if (resolved) okCount++;
    else {
      await runtime!.repo!.markNoChatId(cod);
      noChatCount++;
    }
  };

  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    await Promise.all(chunk.map((it) => processOne(it)));
  }

  runtime.lastEvent = `batch=${items.length} ok=${okCount} invalid=${invalidCount} noChat=${noChatCount}`;
}

function scheduleLoop(ctx: RobotContext) {
  if (!runtime) return;
  const interval = Number(process.env.WHATS_PRECHECK_MS || 5000);
  const run = async () => {
    try {
      await tick(ctx);
    } catch (e: any) {
      runtime!.state = 'error';
      runtime!.lastError = String(e?.message || e);
      ctx.log(`[whatsapp-precheck] erro:`, runtime!.lastError);
    } finally {
      runtime!.loop = setTimeout(run, interval);
    }
  };
  runtime.loop = setTimeout(run, 1000);
}

const robot: Robot = {
  name: 'whatsapp-precheck',
  async start(ctx: RobotContext) {
    runtime = {
      repo: new WhatsPrecheckRepository(ctx.db!),
      spamRepo: new WhatsSpamRepository(ctx.db!),
      ctx,
      state: 'starting',
    };
    scheduleLoop(ctx);
  },
  async stop() {
    if (!runtime) return;
    if (runtime.loop) clearTimeout(runtime.loop);
    runtime.state = 'stopped';
    runtime = undefined;
  },
  async status() {
    if (!runtime) return { running: false };
    return {
      running: runtime.state === 'running' || runtime.state === 'starting',
      state: runtime.state,
      lastEvent: runtime.lastEvent || null,
      lastError: runtime.lastError || null,
    };
  },
};

export default robot;
