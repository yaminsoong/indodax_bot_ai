import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Melindungi seluruh API bot dengan kunci bersama.
 *
 * Kunci dibaca dari DASHBOARD_API_KEY. Bila tidak diisi, hanya permintaan dari
 * localhost yang diterima, sehingga bot tetap bisa dipakai lokal tanpa setup
 * tambahan tetapi tidak pernah terbuka ke jaringan tanpa disadari.
 *
 * DUA PENGERASAN PENTING dibanding versi sebelumnya:
 *
 *  1. Deteksi localhost tidak bisa lagi ditembus lewat reverse proxy.
 *     Bila permintaan membawa header X-Forwarded-For / X-Real-IP / Forwarded,
 *     ia jelas datang melalui perantara - dan alamat soket yang terlihat
 *     127.0.0.1 hanyalah alamat proxy-nya, bukan alamat penggunanya. Dalam
 *     keadaan itu jalur localhost DITOLAK, kecuali operator secara eksplisit
 *     menyatakan proxy-nya tepercaya lewat TRUST_PROXY.
 *
 *  2. Mode LIVE tidak pernah menerima jalur localhost tanpa kunci. Uang
 *     sungguhan menuntut autentikasi yang nyata, bukan asumsi topologi jaringan.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private warned = false;

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const configured = this.config.get<string>('DASHBOARD_API_KEY', '');

    if (!configured || configured.startsWith('your_')) {
      return this.allowLocalOnly(req);
    }

    const provided =
      req.headers['x-api-key'] ??
      (typeof req.headers.authorization === 'string'
        ? req.headers.authorization.replace(/^Bearer\s+/i, '')
        : undefined) ??
      req.query?.api_key;

    if (!provided || !safeEqual(String(provided), configured)) {
      throw new UnauthorizedException('API key tidak valid');
    }
    return true;
  }

  // --- Jalur tanpa kunci ---------------------------------------------------

  private allowLocalOnly(req: any): boolean {
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        'DASHBOARD_API_KEY belum diisi — API hanya menerima permintaan dari localhost ' +
          'tanpa perantara. Isi kunci ini bila dashboard perlu diakses dari perangkat lain.',
      );
    }

    // Mode LIVE: tidak ada pengecualian.
    if (this.isLive()) {
      throw new UnauthorizedException(
        'Mode LIVE membutuhkan DASHBOARD_API_KEY. Jalur localhost tanpa kunci dinonaktifkan ' +
          'karena alamat koneksi saja bukan bukti identitas.',
      );
    }

    if (this.isDirectLocal(req)) return true;

    throw new UnauthorizedException(
      'Akses ini membutuhkan DASHBOARD_API_KEY (kirim lewat header x-api-key)',
    );
  }

  private isLive(): boolean {
    return this.config.get<string>('TRADING_MODE', 'SIMULATION').toUpperCase() === 'LIVE';
  }

  /**
   * Benar-benar dari localhost, tanpa perantara.
   *
   * Header forwarding apa pun membatalkan status "lokal": di balik nginx atau
   * Cloudflare, SETIAP permintaan tampak berasal dari 127.0.0.1. Versi
   * sebelumnya hanya memeriksa alamat soket, sehingga memasang bot di balik
   * reverse proxy diam-diam membuka saldo dan tombol tutup posisi ke internet.
   */
  private isDirectLocal(req: any): boolean {
    const forwardedHeaders = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host'];
    const hasForwarding = forwardedHeaders.some((h) => req.headers?.[h] !== undefined);

    if (hasForwarding && !this.trustsProxy()) {
      this.logger.warn(
        'Permintaan membawa header proxy tetapi TRUST_PROXY belum disetel — ' +
          'jalur localhost ditolak. Setel DASHBOARD_API_KEY, atau TRUST_PROXY=true ' +
          'bila proxy di depan bot memang milik Anda dan menyaring header palsu.',
      );
      return false;
    }

    const ip = String(req.ip ?? req.socket?.remoteAddress ?? '');
    return ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');
  }

  private trustsProxy(): boolean {
    const value = this.config.get<string>('TRUST_PROXY', '');
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  }
}

/** Perbandingan waktu-tetap agar kunci tidak bisa ditebak lewat pengukuran waktu. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
