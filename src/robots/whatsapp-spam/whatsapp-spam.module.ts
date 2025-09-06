import { Module } from '@nestjs/common';
import { DatabaseModule } from 'src/database/database.module';
import { WhatsSpamController } from './whatsapp-spam.controller';
import { WhatsSpamService } from './whatsapp-spam.service';

@Module({
  imports: [DatabaseModule],
  controllers: [WhatsSpamController],
  providers: [WhatsSpamService],
})
export class WhatsSpamModule {}
