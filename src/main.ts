import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RobotManagerService } from './robot-core/robot-manager.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const origins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : true });

  await app.listen(
    process.env.PORT ? Number(process.env.PORT) : 3000,
    '0.0.0.0',
  );

  const manager = app.get(RobotManagerService);
  const shutdown = async () => {
    try {
      await manager.stopAll();
    } catch {}
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
bootstrap();
