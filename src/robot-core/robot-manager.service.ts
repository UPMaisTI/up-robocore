import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Robot, RobotStatus, RobotContext } from '../robots/types';
import { DatabaseService } from 'src/database/database.service';

type RobotRecord = {
  module?: Robot;
  status: RobotStatus;
  lastError?: string;
  ctx?: RobotContext;
};

@Injectable()
export class RobotManagerService implements OnModuleInit {
  private readonly logger = new Logger(RobotManagerService.name);
  private robotsDirDev = path.join(process.cwd(), 'src', 'robots');
  private robotsDirProd = path.join(process.cwd(), 'dist', 'robots');
  private manifestDev = path.join(process.cwd(), 'src', 'robots.manifest.json');
  private manifestProd = path.join(
    process.cwd(),
    'dist',
    'robots.manifest.json',
  );
  private useProdLayout = false;
  private registry = new Map<string, RobotRecord>();
  private scanned = false;
  private tsNodeRegistered = false;

  constructor(private readonly db: DatabaseService) {}

  private resolveLayout() {
    const envProd = process.env.NODE_ENV === 'production';
    this.useProdLayout = envProd;
  }

  private manifestPath() {
    return this.useProdLayout ? this.manifestProd : this.manifestDev;
  }

  async onModuleInit() {
    this.resolveLayout();
    this.logger.log(
      `init (useProdLayout=${this.useProdLayout}, baseDir=${this.robotsBaseDir()}, manifest=${this.manifestPath()})`,
    );
    await this.waitDbReady();
    await this.scan();
    await this.autostart();
  }

  private isProd() {
    return process.env.NODE_ENV === 'production';
  }

  private robotsBaseDir() {
    return this.useProdLayout ? this.robotsDirProd : this.robotsDirDev;
  }

  private async fileExists(p: string) {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  private async safeImport(indexBase: string): Promise<any> {
    // ordem: .js → .mjs → .cjs → (se dev) .ts
    const jsPath = `${indexBase}.js`;
    const mjsPath = `${indexBase}.mjs`;
    const cjsPath = `${indexBase}.cjs`;
    const tsPath = `${indexBase}.ts`;

    const { existsSync } = require('fs');

    // Em produção/dist, nunca tente .ts
    const tryPaths = this.useProdLayout
      ? [jsPath, mjsPath, cjsPath]
      : [jsPath, mjsPath, cjsPath, tsPath];

    for (const p of tryPaths) {
      if (existsSync(p)) {
        if (p.endsWith('.mjs')) {
          const { pathToFileURL } = require('url');
          return import(pathToFileURL(p).href);
        } else if (p.endsWith('.ts')) {
          if (!this.tsNodeRegistered) {
            try {
              const tsnode = require('ts-node');
              tsnode.register({ transpileOnly: true });
              this.tsNodeRegistered = true;
            } catch {}
          }
          return require(p);
        } else {
          return require(p);
        }
      }
    }
    throw new Error(`Arquivo não encontrado (index): ${tryPaths.join(' | ')}`);
  }

  private validateRobot(mod: any): Robot {
    const r: Robot = mod?.default ?? mod;
    if (!r || typeof r !== 'object') throw new Error('Export inválido');
    if (typeof r.name !== 'string' || !r.name)
      throw new Error('Robot.name inválido');
    if (typeof r.start !== 'function') throw new Error('Robot.start ausente');
    if (typeof r.stop !== 'function') throw new Error('Robot.stop ausente');
    if (r.status && typeof r.status !== 'function')
      throw new Error('Robot.status inválido');
    return r;
  }

  private makeCtx(name: string): RobotContext {
    const log = (...args: any[]) =>
      this.logger.log(
        `[${name}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
      );
    return {
      log,
      env: process.env,
      db: this.db,
    };
  }
  private async waitDbReady() {
    const needDb = Boolean(
      process.env.DB_USER &&
        process.env.DB_PASSWORD &&
        (process.env.DB_CONNECT_STRING || process.env.DB_SERVICE_NAME),
    );
    if (!needDb) return;
    const maxMs = Number(process.env.DB_WAIT_READY_MS || 15000);
    const start = Date.now();
    while (!this.db.isReady() && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async scan() {
    const base = this.robotsBaseDir();
    this.logger.log(`scan in ${base}`);
    const exists = await this.fileExists(base);
    if (!exists) {
      this.logger.log(`Diretório de robôs não existe: ${base}`);
      this.scanned = true;
      return;
    }

    const entries = await fs.readdir(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const robotFolder = path.join(base, e.name);
      const indexBase = path.join(robotFolder, 'index');
      try {
        const mod = await this.safeImport(indexBase);
        const robot = this.validateRobot(mod);
        this.logger.log(`loaded robot module: ${robot.name}`);
        const rec = this.registry.get(robot.name);
        if (!rec) {
          this.registry.set(robot.name, { module: robot, status: 'stopped' });
        } else {
          rec.module = robot;
        }
      } catch (err: any) {
        this.logger.error(
          `Falha ao carregar robô "${e.name}": ${err?.message || err}`,
        );
        const name = e.name;
        this.registry.set(name, {
          status: 'error',
          lastError: String(err?.message || err),
        });
      }
    }
    this.scanned = true;
  }

  private async readManifest(): Promise<Record<string, { enabled: boolean }>> {
    const p = this.manifestPath();
    if (!(await this.fileExists(p))) return {};
    try {
      const raw = await fs.readFile(p, 'utf-8');
      const json = JSON.parse(raw);
      return json && typeof json === 'object' ? json : {};
    } catch {
      return {};
    }
  }

  async autostart() {
    const manifest = await this.readManifest();
    for (const [name] of Object.entries(manifest)) {
      try {
        await this.start(name);
      } catch (e: any) {
        this.logger.error(
          `Autostart falhou para "${name}": ${e?.message || e}`,
        );
      }
    }
  }

  list() {
    const out = [];
    for (const [name, rec] of this.registry.entries()) {
      out.push({ name, status: rec.status, lastError: rec.lastError });
    }
    return out;
  }

  async start(name: string) {
    const rec = this.registry.get(name);
    if (!rec) throw new Error(`Robô "${name}" não encontrado`);
    if (rec.status === 'running' || rec.status === 'starting') return;
    if (!rec.module) throw new Error(`Módulo do robô "${name}" não carregado`);
    rec.status = 'starting';
    rec.lastError = undefined;
    rec.ctx = this.makeCtx(name);
    try {
      this.logger.log(`starting: ${name}`);
      await rec.module.start(rec.ctx);
      rec.status = 'running';
      this.logger.log(`started: ${name}`);
    } catch (e: any) {
      rec.status = 'error';
      rec.lastError = String(e?.message || e);
      throw e;
    }
  }

  async stop(name: string) {
    const rec = this.registry.get(name);
    if (!rec) throw new Error(`Robô "${name}" não encontrado`);
    if (rec.status === 'stopped' || rec.status === 'stopping') return;
    if (!rec.module) {
      rec.status = 'stopped';
      return;
    }
    rec.status = 'stopping';
    try {
      await rec.module.stop();
      rec.status = 'stopped';
    } catch (e: any) {
      rec.status = 'error';
      rec.lastError = String(e?.message || e);
      throw e;
    }
  }

  async stopAll() {
    const names = Array.from(this.registry.keys());
    for (const name of names) {
      try {
        await this.stop(name);
      } catch {}
    }
  }

  async status(name: string) {
    const rec = this.registry.get(name);
    if (!rec) throw new Error(`Robô "${name}" não encontrado`);
    const base = { name, status: rec.status, lastError: rec.lastError };
    if (rec.module?.status) {
      try {
        const s = await rec.module.status();
        return { ...base, details: s };
      } catch (e: any) {
        return { ...base, details: null, statusError: String(e?.message || e) };
      }
    }
    return base;
  }

  async reload(name: string) {
    await this.stop(name);
    await this.start(name);
    return this.status(name);
  }

  isReady() {
    return this.scanned;
  }
}
