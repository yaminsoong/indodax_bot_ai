/**
 * Guard dipindahkan ke `src/common/security/api-key.guard.ts` agar bisa dipakai
 * seluruh controller, bukan hanya dashboard.
 *
 * Berkas ini dipertahankan sebagai re-export supaya impor lama tidak patah.
 */
export { ApiKeyGuard } from '../common/security/api-key.guard';
