import { Injectable } from '@nestjs/common';
import { DatabaseService } from 'src/database/database.service';

export type UpsertSessionDto = {
  sessionId: string;
  enabled?: boolean;
  numOrigem: number;
  mode?: 'simple' | 'fast' | 'medium' | 'slow';
  intervalMs?: number;
  maxPerDay?: number;
  sendNormal?: boolean;
};

@Injectable()
export class WhatsSpamService {
  constructor(private readonly db: DatabaseService) {}

  private ensureDb() {
    if (!this.db.isReady()) throw new Error('DB indisponível');
  }

  async listSessions() {
    this.ensureDb();
    const rs = await this.db.query(
      `SELECT SESSION_ID, ENABLED, NUM_ORIGEM, RUN_MODE, INTERVAL_MS, MAX_PER_DAY, SEND_NORMAL FROM UP_WHATS_SESSIONS ORDER BY SESSION_ID`,
    );
    const rows: any[] = rs.rows || rs;
    return rows.map((r) => ({
      sessionId: r.SESSION_ID,
      enabled: String(r.ENABLED || 'N') === 'Y',
      numOrigem: Number(r.NUM_ORIGEM),
      mode: r.RUN_MODE || 'simple',
      intervalMs: Number(r.INTERVAL_MS || 5000),
      maxPerDay: Number(r.MAX_PER_DAY || 250),
      sendNormal: String(r.SEND_NORMAL || 'Y') === 'Y',
    }));
  }

  async createSession(dto: UpsertSessionDto) {
    this.ensureDb();
    await this.db.execute(
      `INSERT INTO UP_WHATS_SESSIONS (SESSION_ID, ENABLED, NUM_ORIGEM, RUN_MODE, INTERVAL_MS, MAX_PER_DAY, SEND_NORMAL, UPDATED_AT)
       VALUES (:sessionId, :enabled, :numOrigem, :runMode, :intervalMs, :maxPerDay, :sendNormal, SYSTIMESTAMP)`,
      {
        sessionId: dto.sessionId,
        enabled: dto.enabled === false ? 'N' : 'Y',
        numOrigem: dto.numOrigem,
        runMode: dto.mode || 'simple',
        intervalMs: dto.intervalMs ?? 5000,
        maxPerDay: dto.maxPerDay ?? 250,
        sendNormal: dto.sendNormal === false ? 'N' : 'Y',
      },
    );
    return { ok: true };
  }

  async patchSession(id: string, dto: Partial<UpsertSessionDto>) {
    this.ensureDb();
    const set: string[] = [];
    const params: any = { id };
    if (dto.enabled !== undefined) {
      set.push('ENABLED=:enabled');
      params.enabled = dto.enabled ? 'Y' : 'N';
    }
    if (dto.numOrigem !== undefined) {
      set.push('NUM_ORIGEM=:numOrigem');
      params.numOrigem = dto.numOrigem;
    }
    if (dto.mode) {
      set.push('RUN_MODE=:runMode');
      params.runMode = dto.mode;
    }
    if (dto.intervalMs !== undefined) {
      set.push('INTERVAL_MS=:intervalMs');
      params.intervalMs = dto.intervalMs;
    }
    if (dto.maxPerDay !== undefined) {
      set.push('MAX_PER_DAY=:maxPerDay');
      params.maxPerDay = dto.maxPerDay;
    }
    if (dto.sendNormal !== undefined) {
      set.push('SEND_NORMAL=:sendNormal');
      params.sendNormal = dto.sendNormal ? 'Y' : 'N';
    }
    set.push('UPDATED_AT = SYSTIMESTAMP');
    if (set.length === 1) return { ok: true };
    await this.db.execute(
      `UPDATE UP_WHATS_SESSIONS SET ${set.join(', ')} WHERE SESSION_ID=:id`,
      params,
    );
    return { ok: true };
  }

  async deleteSession(id: string) {
    this.ensureDb();
    await this.db.execute(
      `DELETE FROM UP_WHATS_FARM_TARGETS WHERE SESSION_ID = :id`,
      { id },
    );
    await this.db.execute(
      `DELETE FROM UP_WHATS_SESSIONS WHERE SESSION_ID = :id`,
      { id },
    );
    return { ok: true };
  }

  async listTargets(id: string) {
    this.ensureDb();
    const rs = await this.db.query(
      `SELECT CHAT_ID, INTERVAL_MS FROM UP_WHATS_FARM_TARGETS WHERE SESSION_ID=:id ORDER BY CHAT_ID`,
      { id },
    );
    const rows: any[] = rs.rows || rs;
    return rows.map((r) => ({
      chatId: r.CHAT_ID,
      intervalMs: Number(r.INTERVAL_MS || 600000),
    }));
  }

  async upsertTarget(id: string, chatId: string, intervalMs?: number) {
    this.ensureDb();
    await this.db.execute(
      `MERGE INTO UP_WHATS_FARM_TARGETS t
       USING (SELECT :id SESSION_ID, :chat CHAT_ID FROM dual) s
       ON (t.SESSION_ID=s.SESSION_ID AND t.CHAT_ID=s.CHAT_ID)
       WHEN MATCHED THEN UPDATE SET INTERVAL_MS=:ms
       WHEN NOT MATCHED THEN INSERT (SESSION_ID, CHAT_ID, INTERVAL_MS) VALUES (:id, :chat, :ms)`,
      { id, chat: chatId, ms: intervalMs ?? 600000 },
    );
    return { ok: true };
  }

  async deleteTarget(id: string, chatId: string) {
    this.ensureDb();
    await this.db.execute(
      `DELETE FROM UP_WHATS_FARM_TARGETS WHERE SESSION_ID=:id AND CHAT_ID=:chat`,
      { id, chat: chatId },
    );
    return { ok: true };
  }
}
