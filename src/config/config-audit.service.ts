import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface ConfigAuditFinding {
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  kind: 'DEAD_KEY' | 'MISSING_KEY' | 'SUSPECT_VALUE' | 'PLACEHOLDER';
  key: string;
  detail: string;
}

export interface ConfigAuditReport {
  envFile: string;
  keysInFile: number;
  findings: ConfigAuditFinding[];
  /** Ringkasan satu baris untuk log startup. */
  summary: string;
}

/**
 * Kunci yang pernah ada di versi lama bot dan kini TIDAK dibaca kode mana pun.
 *
 * Daftar ini sengaja eksplisit, bukan hasil pemindaian otomatis: memindai
 * sumber untuk mencari kunci "tidak terpakai" akan salah menuduh kunci yang
 * dibaca secara dinamis, dan diam-diam menganggap kunci penting sebagai mati
 * jauh lebih berbahaya daripada melewatkan satu kunci usang.
 */
const DEAD_KEYS: Record<string, string> = {
  POSITION_SIZE_PERCENT:
    'Ukuran posisi kini dihitung dari jarak ke stop loss. Pakai RISK_PER_TRADE_PERCENT.',
  STOP_LOSS_PERCENT:
    'Stop loss kini berbasis ATR. Pakai ATR_STOP_MULTIPLIER (dibatasi MIN_STOP_PERCENT/MAX_STOP_PERCENT).',
  TAKE_PROFIT_PERCENT: 'Target kini berbasis ATR. Pakai ATR_TARGET_MULTIPLIER.',
  TRAILING_STOP_TRIGGER_PERCENT:
    'Trailing kini dipicu pada kelipatan risiko. Pakai BREAK_EVEN_AT_R dan TRAILING_ATR_MULTIPLIER.',
};

/**
 * Kunci yang ketidakhadirannya mengubah perilaku bot secara berarti.
 *
 * Tidak semua kunci masuk sini — hanya yang defaultnya bisa mengejutkan
 * operator. Kunci dengan default yang jelas aman tidak perlu diteriakkan.
 */
const IMPORTANT_KEYS: Record<string, string> = {
  RISK_PER_TRADE_PERCENT: 'Menentukan berapa rupiah dipertaruhkan tiap trade',
  MAX_DRAWDOWN_PERCENT: 'Batas drawdown yang menghentikan bot',
  MAX_CONSECUTIVE_LOSSES: 'Batas kalah beruntun yang menghentikan bot',
  ATR_STOP_MULTIPLIER: 'Jarak stop loss',
  ATR_TARGET_MULTIPLIER: 'Jarak target',
  MAKER_ENTRY: 'Entry maker memangkas fee bolak-balik dari 0,4% ke 0,2%',
  ACTIVE_STRATEGY: 'Strategi yang dipakai',
  MI_ENABLED: 'Lapisan Market Intelligence',
  MI_ENFORCE: 'Apakah Market Intelligence benar-benar memblokir, atau hanya mencatat',
  CANDLE_TIMEFRAME: 'Timeframe utama — penentu besar apakah edge bisa menutup fee',
};

/**
 * Memeriksa `.env` terhadap apa yang benar-benar dibaca kode.
 *
 * Alasan keberadaannya: file `.env` bisa tertinggal berbulan-bulan di belakang
 * kode tanpa satu pun gejala. Bot tetap berjalan, tetapi memakai default kode,
 * bukan niat operator — dan tidak ada apa pun di log yang menyatakannya.
 * Persis itu yang ditemukan pada 2026-10-06: empat parameter risiko di `.env`
 * sudah lama tidak dibaca, sementara 60+ kunci yang kini dipakai tidak ada
 * di sana sama sekali.
 */
@Injectable()
export class ConfigAuditService {
  private readonly logger = new Logger(ConfigAuditService.name);

  audit(envPath = join(process.cwd(), '.env')): ConfigAuditReport {
    let raw = '';
    try {
      raw = readFileSync(envPath, 'utf8');
    } catch {
      return {
        envFile: envPath,
        keysInFile: 0,
        findings: [
          {
            severity: 'WARNING',
            kind: 'MISSING_KEY',
            key: '.env',
            detail: `Berkas ${envPath} tidak ditemukan — seluruh parameter memakai default kode.`,
          },
        ],
        summary: 'Berkas .env tidak ada; bot memakai default kode sepenuhnya.',
      };
    }

    const present = new Map<string, string>();
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m) present.set(m[1], m[2].trim());
    }

    const findings: ConfigAuditFinding[] = [];

    // 1. Kunci mati — nilainya tidak berpengaruh apa pun.
    for (const [key, replacement] of Object.entries(DEAD_KEYS)) {
      if (!present.has(key)) continue;
      findings.push({
        severity: 'WARNING',
        kind: 'DEAD_KEY',
        key,
        detail:
          `Disetel ke "${present.get(key)}" tetapi TIDAK dibaca kode mana pun — ` +
          `nilainya tidak berpengaruh. ${replacement}`,
      });
    }

    // 2. Kunci penting yang hilang.
    for (const [key, why] of Object.entries(IMPORTANT_KEYS)) {
      if (present.has(key)) continue;
      findings.push({
        severity: 'INFO',
        kind: 'MISSING_KEY',
        key,
        detail: `Tidak ada di .env, memakai default kode. ${why}.`,
      });
    }

    // 3. Placeholder yang tidak pernah diganti.
    for (const [key, value] of present) {
      if (/^your_|_here$/i.test(value)) {
        const critical = key.startsWith('INDODAX_');
        findings.push({
          severity: critical ? 'CRITICAL' : 'WARNING',
          kind: 'PLACEHOLDER',
          key,
          detail: critical
            ? 'Masih berisi placeholder — bot tidak bisa menghubungi exchange.'
            : 'Masih berisi placeholder — fitur ini tidak aktif.',
        });
      }
    }

    // 4. Nilai yang secara terukur bermasalah.
    const tf = Number(present.get('CANDLE_TIMEFRAME'));
    const miAtr = present.has('MI_MIN_ATR_PERCENT')
      ? Number(present.get('MI_MIN_ATR_PERCENT'))
      : 0.4;
    if (tf > 0 && tf <= 15 && miAtr >= 0.3) {
      findings.push({
        severity: 'WARNING',
        kind: 'SUSPECT_VALUE',
        key: 'CANDLE_TIMEFRAME',
        detail:
          `Timeframe ${tf} menit dengan MI_MIN_ATR_PERCENT=${miAtr}: pada timeframe ` +
          `sekecil itu ATR biasanya 0,1-0,4% sementara fee bolak-balik 0,2-0,4%, ` +
          `sehingga hampir semua sinyal akan ditolak karena pergerakannya tidak ` +
          `menutup biaya. Naikkan timeframe, jangan turunkan ambang ATR.`,
      });
    }

    const live = (present.get('TRADING_MODE') ?? '').toUpperCase() === 'LIVE';
    if (live && !present.get('LIVE_TRADING_CONFIRMED')) {
      findings.push({
        severity: 'CRITICAL',
        kind: 'MISSING_KEY',
        key: 'LIVE_TRADING_CONFIRMED',
        detail:
          'TRADING_MODE=LIVE tetapi frasa konfirmasi tidak ada — bot akan turun ke SIMULATION.',
      });
    }

    const counts = {
      CRITICAL: findings.filter((f) => f.severity === 'CRITICAL').length,
      WARNING: findings.filter((f) => f.severity === 'WARNING').length,
      INFO: findings.filter((f) => f.severity === 'INFO').length,
    };

    const summary = findings.length
      ? `${present.size} kunci di .env — ${counts.CRITICAL} kritis, ${counts.WARNING} peringatan, ${counts.INFO} info`
      : `${present.size} kunci di .env — tidak ada masalah`;

    return { envFile: envPath, keysInFile: present.size, findings, summary };
  }

  /** Tulis hasil audit ke log startup. Dipanggil sekali saat bot menyala. */
  logReport(report: ConfigAuditReport): void {
    this.logger.log(`Audit konfigurasi: ${report.summary}`);

    for (const f of report.findings) {
      const line = `[${f.kind}] ${f.key}: ${f.detail}`;
      if (f.severity === 'CRITICAL') this.logger.error(line);
      else if (f.severity === 'WARNING') this.logger.warn(line);
      else this.logger.log(line);
    }
  }
}
