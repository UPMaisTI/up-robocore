import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

type OraclePkg = typeof import('oracledb');

@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);
  private oracledb: OraclePkg | null = null;
  private pool: import('oracledb').Pool | null = null;
  private ready = false;

  constructor() {
    this.bootstrap().catch((err) => {
      this.logger.warn(`Oracle desabilitado: ${err?.message || err}`);
    });
  }

  private hasEnv() {
    return Boolean(
      process.env.DB_USER &&
        process.env.DB_PASSWORD &&
        (process.env.DB_CONNECT_STRING || process.env.DB_SERVICE_NAME),
    );
  }

  private resolveConnectString() {
    const raw =
      process.env.DB_CONNECT_STRING || process.env.DB_SERVICE_NAME || 'UPMAIS';
    // Se já for um Easy Connect ou um descriptor, retorna direto
    if (raw.includes('(') || raw.includes(':') || raw.includes('/')) return raw;
    // Caso seja um alias (ex: UPMAIS), tenta resolver via tnsnames.ora
    try {
      const desc = this.lookupTnsDescriptor(raw);
      if (desc) {
        this.logger.log(`Alias TNS '${raw}' resolvido via tnsnames.ora`);
        return desc;
      }
    } catch (e: any) {
      this.logger.warn(`Falha ao resolver alias TNS '${raw}': ${e?.message || e}`);
    }
    return raw;
  }

  private async bootstrap() {
    if (!this.hasEnv()) {
      this.logger.log(
        'Variáveis Oracle ausentes (DB_*). Serviço seguirá sem DB.',
      );
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const oracledb = require('oracledb') as OraclePkg;
      // Retornar CLOB como string para evitar "[object Object]"
      try {
        (oracledb as any).fetchAsString = [(oracledb as any).CLOB];
      } catch {}
      this.oracledb = oracledb;
    } catch (e: any) {
      throw new Error(`Pacote "oracledb" indisponível (${e?.message || e})`);
    }

    // Tenta aplicar o client config (tnsnames.ora) se existir
    if (process.env.TNS_ADMIN) {
      try {
        this.oracledb!.initOracleClient({ configDir: process.env.TNS_ADMIN });
      } catch (e: any) {
        this.logger.warn(
          `initOracleClient falhou (TNS_ADMIN=${process.env.TNS_ADMIN}): ${e?.message || e}`,
        );
      }
    }

    // Cria o pool
    try {
      this.pool = await this.oracledb!.createPool({
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        connectString: this.resolveConnectString(),
        poolMin: Number(process.env.DB_POOL_MIN || 0),
        poolMax: Number(process.env.DB_POOL_MAX || 4),
        poolIncrement: Number(process.env.DB_POOL_INC || 1),
        poolTimeout: Number(process.env.DB_POOL_TIMEOUT || 60),
        queueTimeout: Number(process.env.DB_QUEUE_TIMEOUT || 120000),
      });
      this.ready = true;
      this.logger.log('Pool Oracle inicializado');
    } catch (e: any) {
      this.logger.warn(`Falha ao criar pool Oracle: ${e?.message || e}`);
      this.ready = false;
    }
  }

  isReady() {
    return this.ready;
  }

  async getConnection() {
    if (!this.pool) throw new Error('Pool Oracle indisponível');
    return this.pool.getConnection();
  }

  async execute(sql: string, params?: Record<string, any>) {
    let conn: any;
    try {
      conn = await this.getConnection();
      const result = await conn.execute(sql, params || {}, {
        outFormat: this.oracledb!.OUT_FORMAT_OBJECT,
        autoCommit: true,
      });
      return result;
    } finally {
      if (conn) {
        try {
          await conn.close();
        } catch {}
      }
    }
  }

  async query(sql: string, params?: any) {
    return this.execute(sql, params);
  }

  async close() {
    if (this.pool) {
      try {
        await this.pool.close(10);
      } catch {}
      this.pool = null;
    }
    this.ready = false;
  }

  // Resolve um alias (ex: UPMAIS) para o descriptor completo do tnsnames.ora
  private lookupTnsDescriptor(alias: string): string | null {
    const dir = process.env.TNS_ADMIN || '/app/tns';
    const file = path.join(dir, 'tnsnames.ora');
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8');
    const re = new RegExp(`^\n?|\r?\n`, 'g');
    // Procura início do bloco do alias, no começo de linha, ignorando espaços
    const aliasRegex = new RegExp(`^\s*${this.escapeRegExp(alias)}\s*=`, 'mi');
    const m = content.match(aliasRegex);
    if (!m) return null;
    const idx = m.index ?? -1;
    if (idx < 0) return null;
    // Achar o '=' após o alias
    const eq = content.indexOf('=', idx);
    if (eq < 0) return null;
    // Achar o primeiro '(' após '=' e extrair o bloco balanceado
    const open = content.indexOf('(', eq);
    if (open < 0) return null;
    const end = this.findBalancedParenEnd(content, open);
    if (end < 0) return null;
    const descriptor = content.substring(open, end + 1).trim();
    return descriptor || null;
  }

  private findBalancedParenEnd(s: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  private escapeRegExp(x: string) {
    return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
