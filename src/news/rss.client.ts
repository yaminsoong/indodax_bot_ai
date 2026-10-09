import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  /** Penerbit sebenarnya bila feed menyebutkannya (Google News selalu begitu). */
  publisher: string | null;
}

/**
 * Pembaca RSS tanpa dependensi tambahan.
 *
 * Tidak memakai parser XML penuh dengan sengaja: feed RSS yang dipakai di sini
 * sederhana dan seragam, sementara menambah dependensi berarti menambah
 * permukaan yang bisa rusak pada `npm install` di mesin Windows pengguna —
 * hal yang sudah pernah menghambat proyek ini.
 *
 * Yang TIDAK dilakukan parser ini: ia tidak mencoba memahami XML sembarang,
 * tidak menangani namespace rumit, dan tidak membangun pohon dokumen. Bila
 * sebuah feed tidak terbaca, itu dilaporkan sebagai feed gagal — bukan
 * ditebak-tebak.
 */
@Injectable()
export class RssClient {
  private readonly logger = new Logger(RssClient.name);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: 20000,
      maxRedirects: 5,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
  }

  async fetch(url: string): Promise<RssItem[]> {
    const res = await this.http.get<string>(url, { responseType: 'text' });
    return this.parse(typeof res.data === 'string' ? res.data : String(res.data));
  }

  /** Dipisah dari pengambilan agar bisa diuji dengan XML tetap. */
  parse(xml: string): RssItem[] {
    const items: RssItem[] = [];

    // Cocokkan <item>...</item> maupun <entry>...</entry> (Atom).
    const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];

    for (const block of blocks) {
      const title = decodeEntities(stripTags(tagText(block, 'title')));
      if (!title) continue;

      // Atom menaruh URL di atribut href, RSS di dalam elemen.
      const link =
        tagText(block, 'link') ||
        block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ||
        '';

      const pubDate =
        tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || '';

      // Google News menyertakan <source url="...">Nama Penerbit</source>.
      const sourceTag = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1];

      items.push({
        title,
        link: decodeEntities(link.trim()),
        pubDate: pubDate.trim(),
        publisher: sourceTag ? decodeEntities(stripTags(sourceTag)).trim() || null : null,
      });
    }

    return items;
  }
}

/** Isi elemen pertama bernama `name`, termasuk bila dibungkus CDATA. */
function tagText(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  const raw = m[1];
  const cdata = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (cdata ? cdata[1] : raw).trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/**
 * Entity HTML harus dibuka SEBELUM penilaian sentimen.
 *
 * Judul Google News rutin memuat `&amp;` dan `&#39;`; membiarkannya membuat
 * pencocokan kata gagal pada judul seperti "Fed&#39;s rate decision".
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*34;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    // &amp; dibuka TERAKHIR agar "&amp;#39;" tidak berubah menjadi kutip.
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}
