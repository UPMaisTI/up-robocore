import { DatabaseService } from "src/database/database.service";


export type RobotStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error';

export interface RobotContext {
  log: (...args: any[]) => void;
  env: Record<string, string | undefined>;
  db?: DatabaseService;
}

export interface Robot {
  name: string;
  start(ctx: RobotContext): Promise<void>;
  stop(): Promise<void>;
  status?(): Promise<Record<string, any>>;
}
