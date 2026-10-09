import { IndodaxV2Client, IndodaxV2Error } from './indodax-v2.client';
import * as crypto from 'crypto';

/**
 * Perbedaan TAPIv2 dengan TAPI lama bukan soal kenyamanan — kunci yang dibuat
 * untuk satu versi DITOLAK versi lain, dengan galat yang tidak menyebut versi
 * sama sekali. Test di sini mengunci dua hal yang paling mudah salah:
 * algoritma tanda tangan, dan koreksi jam.
 */
describe('IndodaxV2Client', () => {
  const SECRET = 'rahasia-uji';
  const KEY = 'kunci-uji';

  const makeConfig = (over: Record<string, string> = {}) => ({
    get: (k: string, d?: string) =>
      ({ INDODAX_API_KEY: KEY, INDODAX_SECRET_KEY: SECRET, ...over })[k] ?? d,
  });

  let client: IndodaxV2Client;

  beforeEach(() => {
    client = new IndodaxV2Client(makeConfig() as any);
  });

  // ─── Kredensial ─────────────────────────────────────────────────────────

  describe('hasCredentials', () => {
    it('menerima kunci sungguhan', () => {
      expect(client.hasCredentials()).toBe(true);
    });

    it('menolak placeholder', () => {
      const c = new IndodaxV2Client(
        makeConfig({ INDODAX_API_KEY: 'your_api_key_here' }) as any,
      );
      expect(c.hasCredentials()).toBe(false);
    });

    it('menolak kunci kosong', () => {
      const c = new IndodaxV2Client(makeConfig({ INDODAX_SECRET_KEY: '' }) as any);
      expect(c.hasCredentials()).toBe(false);
    });
  });

  // ─── Tanda tangan ───────────────────────────────────────────────────────

  describe('tanda tangan', () => {
    /** Akses private untuk menguji algoritmanya langsung. */
    const sign = (payload: string) => (client as any).sign(payload);

    it('memakai HMAC-SHA256, bukan SHA512 seperti TAPI lama', () => {
      const payload = 'timestamp=1700000000000&recvWindow=10000';
      const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

      expect(sign(payload)).toBe(expected);
      // SHA512 menghasilkan 128 karakter heksadesimal; SHA256 menghasilkan 64.
      expect(sign(payload)).toHaveLength(64);
    });

    it('menghasilkan tanda tangan berbeda untuk payload berbeda', () => {
      expect(sign('a=1')).not.toBe(sign('a=2'));
    });

    it('stabil untuk payload yang sama', () => {
      expect(sign('symbol=BTCIDR&side=BUY')).toBe(sign('symbol=BTCIDR&side=BUY'));
    });
  });

  // ─── Pemetaan galat ─────────────────────────────────────────────────────

  describe('IndodaxV2Error', () => {
    it('mengenali -2015 sebagai akses ditolak', () => {
      const e = new IndodaxV2Error('Access denied', -2015, 403);
      expect(e.isAccessDenied).toBe(true);
      expect(e.isTimestampError).toBe(false);
    });

    it('mengenali -1021 sebagai masalah jam', () => {
      const e = new IndodaxV2Error('Invalid timestamp', -1021, 400);
      expect(e.isTimestampError).toBe(true);
      expect(e.isAccessDenied).toBe(false);
    });

    it('mengenali -2013 sebagai order tidak ditemukan', () => {
      expect(new IndodaxV2Error('not found', -2013, 404).isOrderNotFound).toBe(true);
    });
  });

  // ─── Koreksi jam ────────────────────────────────────────────────────────

  describe('offset jam', () => {
    it('dimulai dari nol sebelum sinkronisasi', () => {
      expect(client.getClockOffsetMs()).toBe(0);
    });

    it('menghitung offset dari waktu server dan menerapkannya pada timestamp', async () => {
      // Server 177 detik di depan jam lokal — persis kasus yang ditemukan
      // pada mesin pengguna, yang membuat seluruh permintaan ditolak -1021.
      const skewMs = 177_000;
      const axios = require('axios');
      const spy = jest
        .spyOn(axios, 'get')
        .mockResolvedValue({ data: { server_time: Date.now() + skewMs } });

      const offset = await client.syncClock(true);
      expect(offset).toBeGreaterThan(skewMs - 2000);
      expect(offset).toBeLessThan(skewMs + 2000);

      const ts = await (client as any).timestamp();
      expect(ts - Date.now()).toBeGreaterThan(skewMs - 2000);

      spy.mockRestore();
    });

    it('menerima waktu server dalam detik maupun milidetik', async () => {
      const axios = require('axios');
      const nowSec = Math.floor(Date.now() / 1000);

      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: { server_time: nowSec } });
      const offset = await client.syncClock(true);
      // Nilai dalam detik harus dikenali dan dikalikan, bukan ditafsirkan
      // sebagai milidetik (yang akan menghasilkan tahun 1970).
      expect(Math.abs(offset)).toBeLessThan(2000);

      spy.mockRestore();
    });

    it('tidak mengubah offset bila waktu server tidak terbaca', async () => {
      const axios = require('axios');
      const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: { aneh: 'bukan waktu' } });

      const offset = await client.syncClock(true);
      expect(offset).toBe(0);

      spy.mockRestore();
    });
  });
});
