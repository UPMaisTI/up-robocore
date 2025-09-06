import { Controller, Get } from '@nestjs/common';
import { RobotManagerService } from '../robot-core/robot-manager.service';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly manager: RobotManagerService,
    private readonly db: DatabaseService,
  ) {}

  @Get('live')
  live() {
    return { ok: true, ts: new Date().toISOString() };
  }

  @Get('ready')
  ready() {
    return {
      ok: true,
      robotsScanned: this.manager.isReady(),
      dbReady: this.db.isReady(),
      ts: new Date().toISOString(),
    };
  }
}
