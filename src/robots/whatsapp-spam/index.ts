import type { Robot, RobotContext } from '../types';
import { WhatsSpamRepository, SessionCfg } from './whatsapp-spam.repository';
import { promises as fs } from 'fs';

type SessionRuntime = {
  cfg: SessionCfg;
  timer?: NodeJS.Timeout;
  sentToday: number;
  lastReset: number;
  state: 'idle' | 'ready' | 'error' | 'stopped' | 'starting';
  lastError?: string;
  farmSchedule?: Map<string, number>;
  lastTickAt?: number;
  lastEvent?: string;
};

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
async function apiPost(path: string, body: any) {
  const url = `${baseUrl()}${path}`;
  const key = process.env.WHATS_API_KEY;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (key) headers['x-api-key'] = key;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
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

let runtime:
  | {
      sessions: Map<string, SessionRuntime>;
      loop?: NodeJS.Timeout;
      repo?: WhatsSpamRepository;
      ctx?: RobotContext;
    }
  | undefined;

let startRetryTimer: NodeJS.Timeout | null = null;

const robot: Robot = {
  name: 'whatsapp-spam',
  async start(ctx: RobotContext) {
    if (!ctx.db?.isReady()) {
      ctx.log('[whatsapp-spam] DB indisponível; aguardando');
      if (!startRetryTimer) {
        startRetryTimer = setTimeout(() => {
          startRetryTimer = null;
          robot
            .start(ctx)
            .catch((e) => ctx.log('[whatsapp-spam] retry falhou', String(e)));
        }, 2000);
      }
      return;
    }
    runtime = {
      sessions: new Map(),
      repo: new WhatsSpamRepository(ctx.db),
      ctx,
    };
    await loadAndReconcile();
    const rescan = Number(process.env.WHATS_RESCAN_MS || 15000);
    runtime.loop = setInterval(
      () =>
        loadAndReconcile().catch((e) =>
          ctx.log('[whatsapp-spam] rescan erro', String(e)),
        ),
      rescan,
    );
  },
  async stop() {
    if (!runtime) return;
    for (const r of runtime.sessions.values()) {
      if (r.timer) clearInterval(r.timer);
      r.state = 'stopped';
    }
    if (runtime.loop) clearInterval(runtime.loop);
    runtime = undefined;
  },
  async status() {
    if (!runtime) return { running: false };
    const out: any[] = [];
    for (const r of runtime.sessions.values()) {
      out.push({
        sessionId: r.cfg.sessionId,
        enabled: r.cfg.enabled,
        state: r.state,
        sentToday: r.sentToday,
        intervalMs: r.cfg.intervalMs,
        lastTickAt: r.lastTickAt || null,
        lastEvent: r.lastEvent || null,
        lastError: r.lastError || null,
      });
    }
    return { running: true, sessions: out };
  },
};

export default robot;

async function loadAndReconcile() {
  if (!runtime?.repo || !runtime?.ctx) return;
  const ctx = runtime.ctx;
  const cfgs = await runtime.repo.listSessions();
  const byId = new Map(cfgs.map((c) => [c.sessionId, c]));
  for (const [sid, r] of runtime.sessions.entries()) {
    if (!byId.has(sid)) {
      if (r.timer) clearInterval(r.timer);
      runtime.sessions.delete(sid);
      ctx.log(`[whatsapp-spam] sessão removida: ${sid}`);
    }
  }
  for (const cfg of cfgs) {
    let r = runtime.sessions.get(cfg.sessionId);
    if (!r) {
      r = {
        cfg,
        sentToday: 0,
        lastReset: todayKey(),
        state: 'starting',
        farmSchedule: new Map(),
      };
      runtime.sessions.set(cfg.sessionId, r);
      ctx.log(
        `[whatsapp-spam] sessão adicionada: ${cfg.sessionId} (enabled=${cfg.enabled}, sendNormal=${cfg.sendNormal})`,
      );
      startSendingLoop(r, ctx);
    } else {
      const changed = JSON.stringify(r.cfg) !== JSON.stringify(cfg);
      r.cfg = cfg;
      if (changed) {
        if (r.timer) clearInterval(r.timer);
        ctx.log(
          `[whatsapp-spam] sessão atualizada: ${cfg.sessionId} (enabled=${cfg.enabled}, sendNormal=${cfg.sendNormal})`,
        );
        startSendingLoop(r, ctx);
      }
    }
  }
}

function todayKey() {
  const d = new Date();
  return Number(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
}
function computeTickMs(r: SessionRuntime) {
  switch (r.cfg.mode) {
    case 'fast':
      return Math.max(1000, r.cfg.intervalMs);
    case 'medium':
      return Math.max(3000, r.cfg.intervalMs);
    case 'slow':
      return Math.max(7000, r.cfg.intervalMs);
    default:
      return Math.max(2000, r.cfg.intervalMs);
  }
}
function startSendingLoop(r: SessionRuntime, ctx: RobotContext) {
  if (r.timer) clearInterval(r.timer);
  const tickMs = computeTickMs(r);
  const scheduleNext = () => {
    r.timer = setTimeout(async () => {
      try {
        await tick(r, ctx);
      } catch (e) {
        r.state = 'error';
        r.lastError = String(e);
        ctx.log(`[${r.cfg.sessionId}] erro no tick`, String(e));
      } finally {
        // agenda o próximo somente após concluir este tick
        scheduleNext();
      }
    }, tickMs);
  };
  scheduleNext();
  ctx.log(`[${r.cfg.sessionId}] loop iniciado a cada ${tickMs}ms`);
}

function decodeUnicodeLiterals(s: string): string {
  if (!s) return '';
  // Converte \uXXXX em caracteres reais (inclui pares surrogates para emoji)
  let out = s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, g1) =>
    String.fromCharCode(parseInt(g1, 16)),
  );
  // Converte sequências comuns de escape (caso venham literais)
  out = out.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
  return out;
}

function normalizeText(t: any): string {
  if (t === null || t === undefined) return '';
  let s: string;
  if (typeof t === 'string') s = t;
  else if (typeof t === 'number' || typeof t === 'boolean') s = String(t);
  else if (typeof t === 'object') {
    if (typeof (t as any).text === 'string') s = (t as any).text;
    else if (typeof (t as any).message === 'string') s = (t as any).message;
    else {
      try {
        s = JSON.stringify(t);
      } catch {
        s = String(t);
      }
    }
  } else s = String(t);
  return decodeUnicodeLiterals(s);
}

async function isSessionReady(
  sessionId: string,
  ctx: RobotContext,
): Promise<boolean> {
  try {
    const s = await apiGet(`/sessions/${encodeURIComponent(sessionId)}/status`);
    const ready =
      s &&
      (s.status === 'READY' || (s.message === 'ok' && s.state === 'READY'));
    if (!ready) ctx.log(`[${sessionId}] não READY: ${JSON.stringify(s)}`);
    return !!ready;
  } catch (e: any) {
    ctx.log(`[${sessionId}] erro status: ${String(e.message || e)}`);
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
    if (!id) ctx.log(`[${sessionId}] número sem chatId: ${phone}`);
    return id;
  } catch (e: any) {
    ctx.log(
      `[${sessionId}] erro ao resolver número ${phone}: ${String(e.message || e)}`,
    );
    return null;
  }
}

function onlyDigits(x: string) {
  return (x || '').replace(/\D+/g, '');
}
function isHttpUrl(s: string) {
  return /^https?:\/\//i.test(s);
}
function guessMime(name: string) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'pdf':
      return 'application/pdf';
    case 'csv':
      return 'text/csv';
    default:
      return 'application/octet-stream';
  }
}

function isImageMime(m: string) {
  return /^image\//i.test(m || '');
}

function toPosix(p: string) {
  return (p || '').replace(/[\\]+/g, '/');
}

// Mapeia caminhos do Windows (C:\\SistemasUP\\...) para Linux (/mnt/whats/...) ou compartilhamento SMB (//host/c$/SistemasUP/...)
function mapWinPath(raw: string): string {
  let s = toPosix((raw || '').trim());
  if (!s) return s;
  // Se já for uma URL http(s), retorna como está
  if (isHttpUrl(s)) return s;
  // Normaliza prefixo de drive
  if (/^c:\/\//i.test(s)) s = s.replace(/^c:\/\//i, 'C:/');
  if (/^c:\//i.test(s)) s = s.replace(/^c:\//i, 'C:/');
  // Atalho: se for UNC/SMB já
  if (/^\/\//.test(s)) return s;

  // Preferência por compartilhamento de rede se variável estiver definida
  const smbPrefix = String(process.env.WHATS_WIN_SHARE_PREFIX || '').trim();
  if (smbPrefix) {
    // Extrai sufixo após C:/SistemasUP/
    const m = s.match(/^C:\/SistemasUP\/(.*)$/i);
    if (m && m[1]) return `${toPosix(smbPrefix).replace(/\/$/, '')}/${m[1]}`;
  }

  // Mapeamento fixo para bind-mount em Linux
  const low = s.toLowerCase();
  const mappings: Array<{ from: string; to: string }> = [
    {
      from: 'c:/sistemasup/gestaoupmais/files/campanhas',
      to: '/mnt/whats/gestao/campanhas',
    },
    { from: 'c:/sistemasup/gestaoupmais/temp', to: '/mnt/whats/gestao/temp' },
    { from: 'c:/sistemasup/boletosup/boletos', to: '/mnt/whats/boletos' },
    { from: 'c:/sistemasup/whatscampanha', to: '/mnt/whats/campanhas' },
    {
      from: 'c:/sistemasup/processosautomaticosup',
      to: '/mnt/whats/processos',
    },
  ];
  for (const m of mappings) {
    if (low.startsWith(m.from)) {
      return m.to + s.slice(m.from.length);
    }
  }
  // Caso não bata com nada, retorna como veio (deixa decisao para fs)
  return s;
}

async function fileToBase64(
  filePath: string,
): Promise<{ filename: string; mime: string; dataUrl: string } | null> {
  try {
    const p = mapWinPath(filePath);
    const filename = (toPosix(p).split('/').pop() || 'file').trim();
    const mime = guessMime(filename);
    // Em HTTP, tenta baixar e converter
    if (isHttpUrl(p)) {
      const res = await fetch(p);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const arr = await res.arrayBuffer();
      const buf = Buffer.from(arr);
      const base64 = buf.toString('base64');
      return { filename, mime, dataUrl: `data:${mime};base64,${base64}` };
    }
    // Arquivo local
    const buf = await fs.readFile(p);
    const base64 = Buffer.from(buf).toString('base64');
    return { filename, mime, dataUrl: `data:${mime};base64,${base64}` };
  } catch (e) {
    return null;
  }
}

async function sendMessageViaApi(
  sessionId: string,
  toOrChatId: string,
  text: any,
  anexos: any,
  treatAsChatId: boolean,
  ctx: RobotContext,
) {
  try {
    let chatId = treatAsChatId ? toOrChatId : null;
    if (!chatId) {
      const phone = onlyDigits(toOrChatId);
      const resolved = await resolveChatId(sessionId, phone, ctx);
      if (!resolved) return false;
      chatId = resolved;
    }
    const body = normalizeText(text);

    const annexStr = typeof anexos === 'string' ? anexos : '';
    const annexList = annexStr
      ? annexStr
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // Converte anexos para base64 (um a um)
    const mediaList: { filename: string; mime: string; dataUrl: string }[] = [];
    for (const raw of annexList) {
      const m = await fileToBase64(raw);
      if (!m) {
        ctx.log(`[${sessionId}] anexo ignorado (inacessível): ${raw}`);
        continue;
      }
      mediaList.push(m);
    }

    if (!mediaList.length) {
      // Sem anexos: envia apenas texto (se houver)
      if (body.trim()) {
        await apiPost('/messages/send', {
          sessionId,
          chatId,
          type: 'text',
          body,
        });
        ctx.log(
          `[${sessionId}] texto enviado para ${chatId} (len=${body.length})`,
        );
      } else {
        ctx.log(`[${sessionId}] texto vazio; nada a enviar para ${chatId}`);
      }
    } else {
      // Com anexos: envia o primeiro com a legenda (body) e os demais sem legenda
      const [first, ...rest] = mediaList;
      const firstPayload: any = {
        sessionId,
        chatId,
        type: 'document',
        caption: body?.trim() ? body : undefined,
        media: { base64: first.dataUrl, filename: first.filename },
      };
      await apiPost('/messages/send', firstPayload);
      ctx.log(
        `[${sessionId}] anexo enviado para ${chatId}: ${first.filename} (com legenda=${!!(body && body.trim())})`,
      );
      for (const m of rest) {
        const payload: any = {
          sessionId,
          chatId,
          type: 'document',
          media: { base64: m.dataUrl, filename: m.filename },
        };
        await apiPost('/messages/send', payload);
        ctx.log(`[${sessionId}] anexo enviado para ${chatId}: ${m.filename}`);
      }
    }
    return true;
  } catch (e: any) {
    ctx.log(`[${sessionId}] falha ao enviar: ${String(e.message || e)}`);
    return false;
  }
}

async function pickDueFarmTarget(r: SessionRuntime, ctx: RobotContext) {
  if (!runtime?.repo) return null;
  const targets = await runtime.repo.listFarmTargets(r.cfg.sessionId);
  if (!targets.length) {
    ctx.log(`[${r.cfg.sessionId}] sem targets cadastrados`);
    return null;
  }
  if (!r.farmSchedule) r.farmSchedule = new Map();
  const now = Date.now();
  for (const t of targets)
    if (!r.farmSchedule.has(t.chatId)) r.farmSchedule.set(t.chatId, 0);
  const due = targets.find((t) => (r.farmSchedule!.get(t.chatId) || 0) <= now);
  if (!due) return null;
  return due;
}

async function tick(r: SessionRuntime, ctx: RobotContext) {
  r.lastTickAt = Date.now();
  if (!r.cfg.enabled) {
    r.state = 'idle';
    r.lastEvent = 'desativada';
    return;
  }
  const k = todayKey();
  if (r.lastReset !== k) {
    r.lastReset = k;
    r.sentToday = 0;
    ctx.log(`[${r.cfg.sessionId}] contador diário resetado`);
  }
  if (r.sentToday >= r.cfg.maxPerDay) {
    r.state = 'idle';
    r.lastEvent = 'limite diário atingido';
    return;
  }
  const ready = await isSessionReady(r.cfg.sessionId, ctx);
  if (!ready) {
    r.state = 'starting';
    r.lastEvent = 'aguardando READY';
    return;
  }
  r.state = 'ready';
  if (!runtime?.repo) return;
  // Sempre tenta fazendinha (targets) para todas as sessões
  {
    const t = await pickDueFarmTarget(r, ctx);
    if (t) {
      const verseDb = await runtime.repo.randomVerse();
      const farmText = process.env.WHATS_FARM_TEXT
        ? String(process.env.WHATS_FARM_TEXT)
        : verseDb;
      ctx.log(
        `[${r.cfg.sessionId}] fazendinha para ${t.chatId} (len=${normalizeText(farmText).length})`,
      );
      const ok = await sendMessageViaApi(
        r.cfg.sessionId,
        t.chatId,
        farmText,
        null,
        true,
        ctx,
      );
      r.lastEvent = ok
        ? `fazendinha ok -> ${t.chatId}`
        : `fazendinha falha -> ${t.chatId}`;
      if (ok) {
        r.sentToday++;
        const nextAt = Date.now() + Number(t.intervalMs || 600000);
        if (!r.farmSchedule) r.farmSchedule = new Map();
        r.farmSchedule.set(t.chatId, nextAt);
        ctx.log(
          `[${r.cfg.sessionId}] pr��ximo envio para ${t.chatId} em ${t.intervalMs || 600000}ms`,
        );
      }
      return;
    }
  }
  if (r.cfg.sendNormal) {
    const msg = await runtime.repo.claimOneFromQueue(
      r.cfg.numOrigem,
      r.cfg.useAssigned,
    );
    if (!msg) {
      r.lastEvent = 'fila vazia';
      return;
    }
    ctx.log(
      `[${r.cfg.sessionId}] enviando fila cod=${msg.cod} destino=${msg.destino}`,
    );
    const ok = await sendMessageViaApi(
      r.cfg.sessionId,
      msg.destino,
      msg.mensagem,
      msg.anexo || null,
      false,
      ctx,
    );
    await runtime.repo.finalizeQueueItem(
      msg.cod,
      ok ? '' : 'FALHA DE ENVIO',
      r.cfg.numOrigem,
    );
    r.lastEvent = ok ? `enviado cod=${msg.cod}` : `falha cod=${msg.cod}`;
    if (ok) r.sentToday++;
  } else {
    const t = await pickDueFarmTarget(r, ctx);
    if (!t) {
      r.lastEvent = 'aguardando próximo target';
      return;
    }
    const verseDb = await runtime.repo.randomVerse();
    const farmText = process.env.WHATS_FARM_TEXT
      ? String(process.env.WHATS_FARM_TEXT)
      : verseDb;
    ctx.log(
      `[${r.cfg.sessionId}] fazendinha para ${t.chatId} (len=${normalizeText(farmText).length})`,
    );
    const ok = await sendMessageViaApi(
      r.cfg.sessionId,
      t.chatId,
      farmText,
      null,
      true,
      ctx,
    );
    r.lastEvent = ok
      ? `fazendinha ok -> ${t.chatId}`
      : `fazendinha falha -> ${t.chatId}`;
    if (ok) {
      r.sentToday++;
      const nextAt = Date.now() + Number(t.intervalMs || 600000);
      if (!r.farmSchedule) r.farmSchedule = new Map();
      r.farmSchedule.set(t.chatId, nextAt);
      ctx.log(
        `[${r.cfg.sessionId}] próximo envio para ${t.chatId} em ${t.intervalMs || 600000}ms`,
      );
    }
  }
}
