import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync } from 'fs';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/security/http-exception.filter';
import { LIVE_CONFIRMATION_PHRASE, resolveTradingMode } from './common/live-mode';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });

  /**
   * CORS dibatasi ke origin yang disebut eksplisit.
   * Sebelumnya `enableCors()` tanpa argumen mengizinkan semua origin, sementara
   * seluruh endpoint — termasuk saldo dan penutupan posisi — tanpa autentikasi.
   */
  const origins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origins.length ? origins : [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/],
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  /**
   * Detail galat internal tidak pernah dikirim ke klien — hanya id penelusuran.
   * Pesan galat mentah sering memuat potongan SQL, jalur berkas, atau respons
   * exchange yang tidak perlu diketahui siapa pun di luar server ini.
   */
  app.useGlobalFilters(new HttpExceptionFilter());

  /**
   * Express dibiarkan TIDAK memercayai proxy secara bawaan.
   *
   * `trust proxy` membuat req.ip diambil dari header X-Forwarded-For, yang bisa
   * dipalsukan siapa pun bila tidak ada proxy sungguhan di depan. Aktifkan
   * hanya bila memang ada reverse proxy milik sendiri yang menimpa header itu.
   */
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRUST_PROXY).toLowerCase())) {
    app.set('trust proxy', 1);
    logger.warn(
      'TRUST_PROXY aktif — req.ip diambil dari header X-Forwarded-For. ' +
        'Pastikan hanya proxy tepercaya yang bisa menjangkau port bot.',
    );
  }

  // Dashboard statis. Saat dijalankan dari dist/, berkas ada di dist/dashboard/public.
  for (const dir of [join(__dirname, 'dashboard', 'public'), join(process.cwd(), 'src', 'dashboard', 'public')]) {
    if (existsSync(dir)) {
      app.useStaticAssets(dir, { prefix: '/' });
      break;
    }
  }

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Indodax Crypto Trading Bot')
    .setDescription(
      'Bot trading Indodax dengan manajemen risiko berbasis ATR, backtest, dan rekonsiliasi order.',
    )
    .setVersion('2.0')
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'x-api-key')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  // Pastikan onModuleDestroy dipanggil (polling Telegram dihentikan dengan rapi).
  app.enableShutdownHooks();

  const port = Number(process.env.PORT) || 3099;
  await app.listen(port);

  const resolution = resolveTradingMode((key) => process.env[key]);
  const mode = resolution.mode;
  const hasDashboardKey = !!process.env.DASHBOARD_API_KEY && !process.env.DASHBOARD_API_KEY.startsWith('your_');

  logger.log(`
╔══════════════════════════════════════════════════╗
║        INDODAX CRYPTO TRADING BOT v2.0           ║
╠══════════════════════════════════════════════════╣
║  Mode      : ${mode.padEnd(36)}║
║  Dashboard : http://localhost:${port}/${' '.repeat(Math.max(0, 18 - String(port).length))}║
║  API Docs  : http://localhost:${port}/docs${' '.repeat(Math.max(0, 13 - String(port).length))}║
║  Auth      : ${(hasDashboardKey ? 'API key aktif' : 'localhost saja').padEnd(36)}║
╚══════════════════════════════════════════════════╝`);

  if (resolution.blockedReason) {
    logger.error(
      `╔══════════════════════════════════════════════════╗\n` +
        `║  MODE LIVE DITOLAK — BOT BERJALAN SIMULASI       ║\n` +
        `╚══════════════════════════════════════════════════╝\n` +
        `${resolution.blockedReason}\n` +
        `Tambahkan baris berikut ke .env bila memang disengaja:\n` +
        `  LIVE_TRADING_CONFIRMED=${LIVE_CONFIRMATION_PHRASE}`,
    );
  }

  if (mode === 'LIVE') {
    logger.warn(
      'MODE LIVE AKTIF — bot akan menempatkan order dengan uang sungguhan. ' +
        'Pastikan hasil backtest dan walk-forward sudah diperiksa, dan API key Indodax ' +
        'dibuat tanpa izin penarikan dana.',
    );

    if (!hasDashboardKey) {
      logger.error(
        'MODE LIVE TANPA DASHBOARD_API_KEY. API hanya menolak berdasarkan alamat koneksi ' +
          'langsung. Bila bot berada di balik reverse proxy (nginx, Cloudflare), setiap ' +
          'permintaan tampak berasal dari localhost dan akan DITERIMA — siapa pun yang ' +
          'menjangkau alamatnya bisa membaca saldo dan menutup posisi Anda. ' +
          'Isi DASHBOARD_API_KEY sebelum bot diekspos ke jaringan.',
      );
    }
  }

  // Matikan dengan rapi pada Ctrl+C / SIGTERM agar posisi tidak ditinggalkan
  // di tengah operasi.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.log(`Menerima ${signal}, mematikan bot dengan rapi...`);
      void app.close().then(() => process.exit(0));
    });
  }
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error(`Bot gagal dijalankan: ${err.message}`, err.stack);
  process.exit(1);
});
