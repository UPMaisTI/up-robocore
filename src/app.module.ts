import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RobotCoreModule } from './robot-core/robot-core.module';
import { DatabaseModule } from './database/database.module';
import { RobotsController } from './robots/robots.controller';
import { HealthController } from './health/health.controller';
import { DatabaseService } from './database/database.service';
import { ConfigModule } from '@nestjs/config';
import { WhatsSpamModule } from './robots/whatsapp-spam/whatsapp-spam.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RobotCoreModule,
    DatabaseModule,
    WhatsSpamModule,
  ],
  controllers: [AppController, RobotsController, HealthController],
  providers: [AppService],
})
export class AppModule {}
