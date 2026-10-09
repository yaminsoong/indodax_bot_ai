import { Mutex, KeyedMutex } from './mutex';
import { sleep } from './rate-limiter';

/**
 * Mutex inilah yang menghapus race condition penyebab double-sell: dua cron
 * dulu bisa membaca posisi yang sama berstatus OPEN lalu sama-sama mengirim
 * order jual.
 */
describe('Mutex', () => {
  it('menjalankan operasi satu per satu, tidak tumpang tindih', async () => {
    const mutex = new Mutex();
    const events: string[] = [];

    const task = async (name: string, delay: number) =>
      mutex.runExclusive(async () => {
        events.push(`${name}:mulai`);
        await sleep(delay);
        events.push(`${name}:selesai`);
      });

    await Promise.all([task('A', 30), task('B', 5), task('C', 5)]);

    // Tanpa mutex urutannya akan berselang-seling.
    expect(events).toEqual([
      'A:mulai', 'A:selesai',
      'B:mulai', 'B:selesai',
      'C:mulai', 'C:selesai',
    ]);
  });

  it('mencegah dua penutupan posisi yang sama berjalan bersamaan', async () => {
    const mutex = new Mutex();
    let status = 'OPEN';
    let sellOrders = 0;

    // Meniru dua cron yang memeriksa lalu menjual posisi yang sama.
    const closeIfOpen = () =>
      mutex.runExclusive(async () => {
        if (status !== 'OPEN') return;
        await sleep(10); // jeda panggilan API
        sellOrders++;
        status = 'CLOSED';
      });

    await Promise.all([closeIfOpen(), closeIfOpen(), closeIfOpen()]);

    expect(sellOrders).toBe(1);
    expect(status).toBe('CLOSED');
  });

  it('melepas kunci walaupun operasi melempar error', async () => {
    const mutex = new Mutex();

    await expect(
      mutex.runExclusive(async () => {
        throw new Error('gagal');
      }),
    ).rejects.toThrow('gagal');

    // Kunci harus tetap bisa dipakai setelahnya.
    await expect(mutex.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('meneruskan nilai kembalian', async () => {
    const mutex = new Mutex();
    await expect(mutex.runExclusive(async () => 42)).resolves.toBe(42);
  });
});

describe('KeyedMutex', () => {
  it('menserialkan key yang sama tetapi memparalelkan key berbeda', async () => {
    const km = new KeyedMutex();
    const events: string[] = [];

    const task = (key: string, name: string, delay: number) =>
      km.runExclusive(key, async () => {
        events.push(`${name}:mulai`);
        await sleep(delay);
        events.push(`${name}:selesai`);
      });

    await Promise.all([
      task('trade-1', 'A', 30),
      task('trade-1', 'B', 5),
      task('trade-2', 'C', 5),
    ]);

    // A dan B (key sama) tidak boleh tumpang tindih.
    expect(events.indexOf('A:selesai')).toBeLessThan(events.indexOf('B:mulai'));
    // C (key berbeda) berjalan paralel — selesai sebelum A yang lebih lambat.
    expect(events.indexOf('C:selesai')).toBeLessThan(events.indexOf('A:selesai'));
  });
});
