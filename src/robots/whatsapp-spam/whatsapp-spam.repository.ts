import { DatabaseService } from 'src/database/database.service';

export type SessionCfg = {
  sessionId: string;
  enabled: boolean;
  numOrigem: number;
  mode: 'simple' | 'fast' | 'medium' | 'slow';
  intervalMs: number;
  maxPerDay: number;
  sendNormal: boolean;
  useAssigned: boolean;
};

type DbRow = Record<string, unknown>;

export class WhatsSpamRepository {
  constructor(private readonly db: DatabaseService) {}

  private rows<T extends DbRow = DbRow>(rs: unknown): T[] {
    if (!rs) return [];
    if (Array.isArray(rs)) return rs as T[];
    if (typeof rs === 'object') {
      const withRows = rs as { rows?: unknown };
      if (Array.isArray(withRows.rows)) return withRows.rows as T[];
    }
    return [];
  }

  private getRowsAffected(result: unknown): number {
    if (result && typeof result === 'object') {
      const rowsAffected = (result as { rowsAffected?: unknown }).rowsAffected;
      if (typeof rowsAffected === 'number') return rowsAffected;
      const rows = (result as { rows?: unknown }).rows;
      if (Array.isArray(rows)) return rows.length;
    }
    return 0;
  }

  private parseMode(value: unknown): SessionCfg['mode'] {
    if (typeof value !== 'string') return 'simple';
    const allowed: SessionCfg['mode'][] = ['simple', 'fast', 'medium', 'slow'];
    const normalized = value.trim().toLowerCase() as SessionCfg['mode'];
    return allowed.includes(normalized) ? normalized : 'simple';
  }

  async listSessions(): Promise<SessionCfg[]> {
    const rs: unknown = await this.db.query(
      `SELECT SESSION_ID, ENABLED, NUM_ORIGEM, NVL(RUN_MODE,'simple') RUN_MODE,
              NVL(INTERVAL_MS,5000) INTERVAL_MS, NVL(MAX_PER_DAY,250) MAX_PER_DAY,
              NVL(SEND_NORMAL,'Y') SEND_NORMAL
         FROM UP_WHATS_SESSIONS`,
    );
    const rows = this.rows<{
      SESSION_ID: string | number;
      ENABLED?: string | null;
      NUM_ORIGEM: string | number;
      RUN_MODE?: string | null;
      INTERVAL_MS?: string | number | null;
      MAX_PER_DAY?: string | number | null;
      SEND_NORMAL?: string | null;
    }>(rs);

    return rows.map((r) => ({
      sessionId: String(r.SESSION_ID),
      enabled: String(r.ENABLED || 'Y') === 'Y',
      numOrigem: Number(r.NUM_ORIGEM),
      mode: this.parseMode(r.RUN_MODE),
      intervalMs: Number(r.INTERVAL_MS || 5000),
      maxPerDay: Number(r.MAX_PER_DAY || 250),
      sendNormal: String(r.SEND_NORMAL || 'Y') === 'Y',
      useAssigned: this.useAssignedFor(
        String(r.SESSION_ID),
        Number(r.NUM_ORIGEM),
      ),
    }));
  }

  async listFarmTargets(
    sessionId: string,
  ): Promise<{ chatId: string; intervalMs: number }[]> {
    const rs: unknown = await this.db.query(
      `SELECT CHAT_ID, NVL(INTERVAL_MS,600000) INTERVAL_MS
         FROM UP_WHATS_FARM_TARGETS
        WHERE SESSION_ID = :id
        ORDER BY CHAT_ID`,
      { id: sessionId },
    );
    const rows = this.rows<{
      CHAT_ID: string | number;
      INTERVAL_MS?: string | number | null;
    }>(rs);

    return rows.map((r) => ({
      chatId: String(r.CHAT_ID),
      intervalMs: Number(r.INTERVAL_MS || 600000),
    }));
  }

  async claimOneFromQueue(
    numOrigem: number,
    useAssigned?: boolean,
  ): Promise<{
    cod: number;
    destino: string;
    mensagem: string;
    anexo: string | null;
    prioridade: number | null;
  } | null> {
    const assigned = !!useAssigned;
    const maxAttempts = 30;
    if (assigned) {
      for (let i = 0; i < maxAttempts; i++) {
        const token = `CLAIMED:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
        const upd: unknown = await this.db.execute(
          `UPDATE sankhya.envia_whats w
              SET w.erro = :token
            WHERE w.COD_ENVIA_WHATS = (
                    SELECT COD_ENVIA_WHATS
                      FROM sankhya.envia_whats
                     WHERE data_envio IS NULL
                       AND erro IS NULL
                       AND numorigem = :num
                     ORDER BY data_criacao ASC
                     FETCH FIRST 1 ROW ONLY
                  )
              AND w.data_envio IS NULL
              AND w.erro IS NULL`,
          { token, num: numOrigem },
        );
        const rowsAffected = this.getRowsAffected(upd);
        if (!rowsAffected) return null;

        const sel2: unknown = await this.db.query(
          `SELECT COD_ENVIA_WHATS, DESTINO, MENSAGEM, ANEXO, PRIORIDADE
             FROM sankhya.envia_whats
            WHERE erro = :token`,
          { token },
        );
        const row2 = this.rows<{
          COD_ENVIA_WHATS: string | number;
          DESTINO: string | null;
          MENSAGEM: string | null;
          ANEXO?: string | null;
          PRIORIDADE?: string | number | null;
        }>(sel2)[0];
        if (!row2) continue;

        const normalized = this.normalizeDestino(String(row2.DESTINO));
        if (!normalized) {
          await this.db.execute(
            `UPDATE sankhya.envia_whats
                SET DATA_ENVIO = TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI'),
                    ERRO = 'INVALID_NUMBER'
              WHERE COD_ENVIA_WHATS = :cod AND erro = :token`,
            { cod: row2.COD_ENVIA_WHATS, token },
          );
          continue;
        }

        return {
          cod: Number(row2.COD_ENVIA_WHATS),
          destino: normalized,
          mensagem: String(row2.MENSAGEM || ''),
          anexo: row2.ANEXO ? String(row2.ANEXO) : null,
          prioridade: row2.PRIORIDADE != null ? Number(row2.PRIORIDADE) : null,
        };
      }
      return null;
    } else {
      for (let i = 0; i < maxAttempts; i++) {
        const sel: unknown = await this.db.query(
          `SELECT COD_ENVIA_WHATS, DESTINO, MENSAGEM, ANEXO, PRIORIDADE
             FROM sankhya.envia_whats w
            WHERE w.data_envio IS NULL
              AND w.erro IS NULL
              AND w.numorigem IS NULL
            ORDER BY w.data_criacao ASC
            FETCH FIRST 30 ROWS ONLY`,
        );
        const rows = this.rows<{
          COD_ENVIA_WHATS: string | number;
          DESTINO: string | null;
          MENSAGEM: string | null;
          ANEXO?: string | null;
          PRIORIDADE?: string | number | null;
        }>(sel);
        if (!rows.length) return null;

        let chosen: {
          COD_ENVIA_WHATS: string | number;
          DESTINO: string | null;
          MENSAGEM: string | null;
          ANEXO?: string | null;
          PRIORIDADE?: string | number | null;
        } | null = null;
        let normalized: string | null = null;

        for (const r of rows) {
          const n = this.normalizeDestino(String(r.DESTINO));
          if (!n) {
            await this.db.execute(
              `UPDATE sankhya.envia_whats
                  SET DATA_ENVIO = TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI'),
                      ERRO = 'INVALID_NUMBER'
                WHERE COD_ENVIA_WHATS = :cod AND DATA_ENVIO IS NULL AND ERRO IS NULL`,
              { cod: r.COD_ENVIA_WHATS },
            );
            continue;
          }
          const claim: unknown = await this.db.execute(
            `UPDATE sankhya.envia_whats
                SET NUMORIGEM = :num
              WHERE COD_ENVIA_WHATS = :cod AND NUMORIGEM IS NULL AND DATA_ENVIO IS NULL AND ERRO IS NULL`,
            { num: numOrigem, cod: r.COD_ENVIA_WHATS },
          );
          const ok = this.getRowsAffected(claim);
          if (ok) {
            chosen = r;
            normalized = n;
            break;
          }
        }

        if (chosen && normalized) {
          const prioridade =
            chosen.PRIORIDADE != null ? Number(chosen.PRIORIDADE) : null;
          return {
            cod: Number(chosen.COD_ENVIA_WHATS),
            destino: normalized,
            mensagem: String(chosen.MENSAGEM || ''),
            anexo: chosen.ANEXO ? String(chosen.ANEXO) : null,
            prioridade,
          };
        }
      }
      return null;
    }
  }

  async finalizeQueueItem(
    cod: number,
    erro: string,
    numOrigem: number,
  ): Promise<void> {
    await this.db.execute(
      `UPDATE sankhya.envia_whats
          SET DATA_ENVIO = TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI'),
              ERRO = :erro,
              NUMORIGEM = :num
        WHERE COD_ENVIA_WHATS = :cod`,
      { erro: erro || '', num: numOrigem, cod },
    );
  }

  async setPrioridade(cod: number, prioridade: number): Promise<void> {
    await this.db.execute(
      `UPDATE sankhya.envia_whats SET prioridade = :p WHERE COD_ENVIA_WHATS = :cod`,
      { p: prioridade, cod },
    );
  }

  private useAssignedFor(sessionId: string, numOrigem: number): boolean {
    const bySession = String(process.env.WHATS_USE_ASSIGNED_SESSIONS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const byNums = String(process.env.WHATS_USE_ASSIGNED_NUMS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (bySession.length && bySession.includes(sessionId)) return true;
    if (byNums.length && byNums.includes(String(numOrigem))) return true;
    return false;
  }

  async randomVerse(): Promise<string> {
    const rs: unknown = await this.db.query(
      `SELECT texto FROM (SELECT texto FROM sankhya.UP_MENSAGENS_BIBLIA_WHATS ORDER BY DBMS_RANDOM.VALUE) WHERE ROWNUM = 1`,
    );
    const row = this.rows<{ TEXTO?: string | null }>(rs)[0];
    return typeof row?.TEXTO === 'string' ? row.TEXTO : 'Deus te abençoe!';
  }

  private normalizeDestino(raw: string): string | null {
    const countryCode =
      String(process.env.COUNTRY_CODE_DEFAULT || '55').replace(/\D/g, '') ||
      '55';
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;

    // Already formatted JID for user or group
    if (/@(s\.whatsapp\.net|g\.us)$/.test(trimmed)) return trimmed;
    // Legacy puppeteer JID -> convert to MD
    if (trimmed.endsWith('@c.us'))
      return trimmed.replace(/@c\.us$/, '@s.whatsapp.net');
    // Group id without suffix (keeps hyphen)
    if (/^\d{6,}-\d{6,}$/.test(trimmed)) return `${trimmed}@g.us`;

    // Plain number: clean, apply DDI default and validate
    let digits = trimmed.replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('00')) digits = digits.replace(/^0+/, '');
    if (!digits.startsWith(countryCode)) digits = countryCode + digits;

    const national = digits.slice(countryCode.length);
    if (!national || this.allSame(national)) return null;
    // Guard against obviously wrong sizes (keeps compatibility with BR 10/11 digits)
    if (national.length < 8 || national.length > 13) return null;

    return `${digits}@s.whatsapp.net`;
  }

  private allSame(s: string): boolean {
    if (!s) return false;
    return /^(\d)\1+$/.test(s);
  }

  // Insere um e-mail para envio assíncrono (espelha mensagem do WhatsApp)
  async inserirEmailParaEnvio(
    usuario_destino: string,
    descricao: string,
    corpo_email: string,
    copia: string = '',
  ): Promise<{ success: boolean; message?: string }> {
    const sql = `
      INSERT INTO envia_email (usuario_origem, usuario_destino, copia, descricao, corpo_email)
      VALUES (:usuario_origem, :usuario_destino, :copia, :descricao, :corpo_email)
    `;

    try {
      await this.db.query(sql, {
        usuario_origem: 'ad@upmais.com.br',
        usuario_destino,
        copia,
        descricao,
        corpo_email,
      });
      return { success: true };
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : error
              ? JSON.stringify(error)
              : 'Unknown error';
      return {
        success: false,
        message: `Erro ao inserir e-mail para envio: ${message}`,
      };
    }
  }
}
