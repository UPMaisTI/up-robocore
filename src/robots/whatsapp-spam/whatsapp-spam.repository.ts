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

export class WhatsSpamRepository {
  constructor(private readonly db: DatabaseService) {}

  private rows(rs: any): any[] {
    return rs?.rows ?? rs ?? [];
  }

  async listSessions(): Promise<SessionCfg[]> {
    const rs = await this.db.query(
      `SELECT SESSION_ID, ENABLED, NUM_ORIGEM, NVL(RUN_MODE,'simple') RUN_MODE,
              NVL(INTERVAL_MS,5000) INTERVAL_MS, NVL(MAX_PER_DAY,250) MAX_PER_DAY,
              NVL(SEND_NORMAL,'Y') SEND_NORMAL
         FROM UP_WHATS_SESSIONS`,
    );
    return this.rows(rs).map((r) => ({
      sessionId: String(r.SESSION_ID),
      enabled: String(r.ENABLED || 'Y') === 'Y',
      numOrigem: Number(r.NUM_ORIGEM),
      mode: (String(r.RUN_MODE) as any) || 'simple',
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
    const rs = await this.db.query(
      `SELECT CHAT_ID, NVL(INTERVAL_MS,600000) INTERVAL_MS
         FROM UP_WHATS_FARM_TARGETS
        WHERE SESSION_ID = :id
        ORDER BY CHAT_ID`,
      { id: sessionId },
    );
    return this.rows(rs).map((r) => ({
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
        const upd = await this.db.execute(
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
        const rowsAffected = upd?.rowsAffected ?? upd?.rows?.length ?? 0;
        if (!rowsAffected) return null;

        const sel2 = await this.db.query(
          `SELECT COD_ENVIA_WHATS, DESTINO, MENSAGEM, ANEXO, PRIORIDADE
             FROM sankhya.envia_whats
            WHERE erro = :token`,
          { token },
        );
        const row2 = this.rows(sel2)[0];
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
        const sel = await this.db.query(
          `SELECT COD_ENVIA_WHATS, DESTINO, MENSAGEM, ANEXO, PRIORIDADE
             FROM sankhya.envia_whats w
            WHERE w.data_envio IS NULL
              AND w.erro IS NULL
              AND w.numorigem IS NULL
            ORDER BY w.data_criacao ASC
            FETCH FIRST 30 ROWS ONLY`,
        );
        const rows = this.rows(sel) as Array<any>;
        if (!rows.length) return null;

        let chosen: any | null = null;
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
          const claim = await this.db.execute(
            `UPDATE sankhya.envia_whats
                SET NUMORIGEM = :num
              WHERE COD_ENVIA_WHATS = :cod AND NUMORIGEM IS NULL AND DATA_ENVIO IS NULL AND ERRO IS NULL`,
            { num: numOrigem, cod: r.COD_ENVIA_WHATS },
          );
          const ok = claim?.rowsAffected ?? claim?.rows?.length ?? 0;
          if (ok) {
            chosen = r;
            normalized = n;
            break;
          }
        }

        if (chosen && normalized) {
          return {
            cod: Number(chosen.COD_ENVIA_WHATS),
            destino: normalized,
            mensagem: String(chosen.MENSAGEM || ''),
            anexo: chosen.ANEXO ? String(chosen.ANEXO) : null,
            prioridade: chosen.PRIORIDADE != null ? Number(chosen.PRIORIDADE) : null,
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
    const rs = await this.db.query(
      `SELECT texto FROM (SELECT texto FROM sankhya.UP_MENSAGENS_BIBLIA_WHATS ORDER BY DBMS_RANDOM.VALUE) WHERE ROWNUM = 1`,
    );
    const row = this.rows(rs)[0];
    return row?.TEXTO || 'Deus te abençoe!';
  }

  private normalizeDestino(raw: string): string | null {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.startsWith('00')) d = d.replace(/^0+/, '');
    if (d.length === 11 || d.length === 10) d = '55' + d;
    if (
      (d.length === 11 && d.startsWith('55')) ||
      (d.length === 12 && !d.startsWith('55'))
    )
      d = '55' + d;
    if (!(d.startsWith('55') && (d.length === 12 || d.length === 13)))
      return null;
    const local = d.slice(2);
    if (this.allSame(local)) return null;
    return d;
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
    } catch (error: any) {
      return {
        success: false,
        message: `Erro ao inserir e-mail para envio: ${error?.message || error}`,
      };
    }
  }
}
