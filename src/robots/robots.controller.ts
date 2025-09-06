import {
  Controller,
  Get,
  Param,
  Post,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { RobotManagerService } from '../robot-core/robot-manager.service';

@Controller('robots')
export class RobotsController {
  constructor(private readonly manager: RobotManagerService) {}

  @Get() list() {
    return this.manager.list();
  }

  @Post('scan')
  @HttpCode(HttpStatus.OK)
  async scan() {
    await this.manager.scan();
    return this.manager.list();
  }

  @Post(':name/start')
  @HttpCode(HttpStatus.OK)
  async start(@Param('name') name: string) {
    await this.manager.start(name);
    return this.manager.status(name);
  }

  @Post(':name/stop')
  @HttpCode(HttpStatus.OK)
  async stop(@Param('name') name: string) {
    await this.manager.stop(name);
    return this.manager.status(name);
  }

  @Get(':name/status')
  status(@Param('name') name: string) {
    return this.manager.status(name);
  }

  @Post(':name/reload')
  @HttpCode(HttpStatus.OK)
  async reload(@Param('name') name: string) {
    return this.manager.reload(name);
  }
}
