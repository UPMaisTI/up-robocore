import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { WhatsSpamService, UpsertSessionDto } from './whatsapp-spam.service';

@Controller('whatsapp-spam')
export class WhatsSpamController {
  constructor(private readonly service: WhatsSpamService) {}

  @Get('sessions')
  list() {
    return this.service.listSessions();
  }

  @Post('sessions')
  create(@Body() dto: UpsertSessionDto) {
    return this.service.createSession(dto);
  }

  @Patch('sessions/:id')
  patch(@Param('id') id: string, @Body() dto: Partial<UpsertSessionDto>) {
    return this.service.patchSession(id, dto);
  }

  @Delete('sessions/:id')
  del(@Param('id') id: string) {
    return this.service.deleteSession(id);
  }

  @Get('sessions/:id/targets')
  listTargets(@Param('id') id: string) {
    return this.service.listTargets(id);
  }

  @Post('sessions/:id/targets')
  upsertTarget(
    @Param('id') id: string,
    @Body() body: { chatId: string; intervalMs?: number },
  ) {
    return this.service.upsertTarget(id, body.chatId, body.intervalMs);
  }

  @Delete('sessions/:id/targets/:chatId')
  delTarget(@Param('id') id: string, @Param('chatId') chatId: string) {
    return this.service.deleteTarget(id, chatId);
  }
}
