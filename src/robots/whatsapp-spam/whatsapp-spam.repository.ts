import { DatabaseService } from "src/database/database.service";


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
      useAssigned: this.useAssignedFor(String(r.SESSION_ID), Number(r.NUM_ORIGEM)),
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
  } | null> {
    const assigned = !!useAssigned;
    if (assigned) {
      const token = `CLAIMED:${process.pid}:${Date.now()}:${Math.random()
        .toString(16)
        .slice(2)}`;
      const upd = await this.db.execute(
        `UPDATE sankhya.envia_whats w
            SET w.erro = :token
          WHERE w.COD_ENVIA_WHATS = (
                  SELECT COD_ENVIA_WHATS
                    FROM sankhya.envia_whats
                   WHERE LENGTH(DESTINO) in (12,13)
                     AND data_envio IS NULL
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
        `SELECT COD_ENVIA_WHATS, DESTINO, MENSAGEM, ANEXO
           FROM sankhya.envia_whats
          WHERE erro = :token`,
        { token },
      );
      const row2 = this.rows(sel2)[0];
      if (!row2) return null;
      return {
        cod: Number(row2.COD_ENVIA_WHATS),
        destino: String(row2.DESTINO),
        mensagem: String(row2.MENSAGEM || ''),
        anexo: row2.ANEXO ? String(row2.ANEXO) : null,
      };
    } else {
      const sel = await this.db.query(
        `SELECT COD_ENVIA_WHATS, DESTINO, MENSAGEM, ANEXO
           FROM sankhya.envia_whats w
          WHERE LENGTH(DESTINO) in (12,13)
            AND w.data_envio IS NULL
            AND w.erro IS NULL
            AND w.numorigem IS NULL
          ORDER BY w.data_criacao ASC
          FETCH FIRST 1 ROW ONLY`,
      );
      const row = this.rows(sel)[0];
      if (!row) return null;
      const upd = await this.db.execute(
        `UPDATE sankhya.envia_whats
            SET NUMORIGEM = :num
          WHERE COD_ENVIA_WHATS = :cod AND NUMORIGEM IS NULL`,
        { num: numOrigem, cod: row.COD_ENVIA_WHATS },
      );
      const rowsAffected = upd?.rowsAffected ?? upd?.rows?.length ?? 0;
      if (!rowsAffected) return null;
      return {
        cod: Number(row.COD_ENVIA_WHATS),
        destino: String(row.DESTINO),
        mensagem: String(row.MENSAGEM || ''),
        anexo: row.ANEXO ? String(row.ANEXO) : null,
      };
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
}
