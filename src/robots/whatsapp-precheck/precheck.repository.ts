import { DatabaseService } from '../../database/database.service';

export type PrecheckItem = {
  cod: number;
  destino: string;
  token: string;
};

export class WhatsPrecheckRepository {
  constructor(private readonly db: DatabaseService) {}

  private rows(rs: any): any[] {
    return rs?.rows ?? rs ?? [];
  }

  async claimOne(): Promise<PrecheckItem | null> {
    const token = `PRECHECK:${process.pid}:${Date.now()}:$${Math.random()
      .toString(16)
      .slice(2)}`;
    // Tenta marcar 1 registro pendente como PRECHECK para processar com segurança
    const upd = await this.db.execute(
      `UPDATE sankhya.envia_whats w
          SET w.erro = :token
        WHERE w.COD_ENVIA_WHATS = (
                SELECT COD_ENVIA_WHATS
                  FROM sankhya.envia_whats
                 WHERE data_envio IS NULL
                   AND erro IS NULL
                   AND numorigem IS NULL
                 ORDER BY data_criacao ASC
                 FETCH FIRST 1 ROW ONLY
              )
          AND w.data_envio IS NULL
          AND w.erro IS NULL
          AND w.numorigem IS NULL`,
      { token },
    );
    const rowsAffected = upd?.rowsAffected ?? upd?.rows?.length ?? 0;
    if (!rowsAffected) return null;

    const sel = await this.db.query(
      `SELECT COD_ENVIA_WHATS, DESTINO
         FROM sankhya.envia_whats
        WHERE erro = :token`,
      { token },
    );
    const row = this.rows(sel)[0];
    if (!row) return null;
    return {
      cod: Number(row.COD_ENVIA_WHATS),
      destino: String(row.DESTINO || ''),
      token,
    };
  }

  async finalizeInvalidNumber(cod: number, token: string) {
    await this.db.execute(
      `UPDATE sankhya.envia_whats
          SET DATA_ENVIO = TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI'),
              ERRO = 'INVALID_NUMBER'
        WHERE COD_ENVIA_WHATS = :cod AND ERRO = :token`,
      { cod, token },
    );
  }

  async finalizeNoChatId(cod: number, token: string) {
    await this.db.execute(
      `UPDATE sankhya.envia_whats
          SET DATA_ENVIO = TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI'),
              ERRO = 'NO_CHAT_ID'
        WHERE COD_ENVIA_WHATS = :cod AND ERRO = :token`,
      { cod, token },
    );
  }

  async release(cod: number, token: string) {
    // Libera o registro para o spam continuar processando normalmente
    await this.db.execute(
      `UPDATE sankhya.envia_whats
          SET ERRO = NULL
        WHERE COD_ENVIA_WHATS = :cod AND ERRO = :token`,
      { cod, token },
    );
  }
}

