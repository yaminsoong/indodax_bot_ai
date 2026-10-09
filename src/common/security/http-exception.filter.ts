import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Filter galat global.
 *
 * Galat yang TIDAK berbentuk HttpException hampir selalu berasal dari dalam:
 * kegagalan query database, respons exchange yang tak terduga, bug. Pesannya
 * kerap memuat potongan SQL, jalur berkas, atau nama kolom — semuanya informasi
 * yang berguna bagi penyerang dan tidak berguna bagi pengguna.
 *
 * Karena itu klien hanya menerima pesan umum beserta `errorId`, sementara
 * detail lengkapnya masuk ke log server dengan id yang sama. Operator tetap
 * bisa menelusuri kejadian persisnya; pihak luar tidak mendapat apa pun.
 *
 * HttpException yang dilempar dengan sengaja (400, 401, 404, ...) diteruskan
 * apa adanya: pesannya memang ditulis untuk dibaca pengguna.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // Galat 5xx yang dilempar sebagai HttpException tetap disamarkan:
      // statusnya disengaja, isi pesannya belum tentu.
      if (status >= 500) {
        const errorId = this.logInternal(exception, request);
        response.status(status).json({
          statusCode: status,
          message: 'Terjadi kesalahan internal. Sertakan errorId saat melaporkan.',
          errorId,
        });
        return;
      }

      response.status(status).json(
        typeof body === 'string' ? { statusCode: status, message: body } : body,
      );
      return;
    }

    const errorId = this.logInternal(exception, request);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Terjadi kesalahan internal. Sertakan errorId saat melaporkan.',
      errorId,
    });
  }

  /** Catat detail lengkap di sisi server dan kembalikan id penelusurannya. */
  private logInternal(exception: unknown, request: any): string {
    const errorId = crypto.randomBytes(6).toString('hex');
    const message = exception instanceof Error ? exception.message : String(exception);
    const stack = exception instanceof Error ? exception.stack : undefined;

    this.logger.error(
      `[${errorId}] ${request?.method ?? '?'} ${request?.url ?? '?'} — ${message}`,
      stack,
    );
    return errorId;
  }
}
