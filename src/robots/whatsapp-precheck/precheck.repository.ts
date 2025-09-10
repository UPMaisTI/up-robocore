import { DatabaseService } from '../../database/database.service';

export type PrecheckItem = {
  cod: number;
  destino: string;
};

export class WhatsPrecheckRepository {
  constructor(private readonly db: DatabaseService) {}

  private rows(rs: any): any[] {
    return rs?.rows ?? rs ?? [];
  }

  async fetchBatch(limit: number): Promise<PrecheckItem[]> {
    const lim = Math.max(1, Math.min(5000, Number(limit) || 500));
    const sql = `SELECT COD_ENVIA_WHATS, DESTINO
                   FROM sankhya.envia_whats w
                  WHERE w.data_envio IS NULL
                    AND w.erro IS NULL
                  ORDER BY w.data_criacao ASC
                  FETCH FIRST ${lim} ROWS ONLY`;
    const rs = await this.db.query(sql);
    return this.rows(rs).map((r) => ({
      cod: Number(r.COD_ENVIA_WHATS),
      destino: String(r.DESTINO || ''),
    }));
  }

  async markInvalidNumber(cod: number) {
    await this.db.execute(
      `UPDATE sankhya.envia_whats
          SET DATA_ENVIO = TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI'),
              ERRO = 'INVALID_NUMBER'
        WHERE COD_ENVIA_WHATS = :cod AND DATA_ENVIO IS NULL AND ERRO IS NULL`,
      { cod },
    );
  }

  async markNoChatId(cod: number) {
    await this.db.execute(
      `UPDATE sankhya.envia_whats
          SET DATA_ENVIO = TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI'),
              ERRO = 'NO_CHAT_ID'
        WHERE COD_ENVIA_WHATS = :cod AND DATA_ENVIO IS NULL AND ERRO IS NULL`,
      { cod },
    );
  }
}

