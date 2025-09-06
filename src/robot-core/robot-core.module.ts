import { Module, Global } from '@nestjs/common';
import { RobotManagerService } from './robot-manager.service';
import { DatabaseModule } from '../database/database.module';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [RobotManagerService],
  exports: [RobotManagerService],
})
export class RobotCoreModule {}
