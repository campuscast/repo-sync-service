import { BadRequestException, Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { IngestorService } from './ingestor.service';

@Controller('schedules')
export class IngestorController {
  constructor(private readonly ingestor: IngestorService) {}

  @Post(':scheduleId/ops')
  @HttpCode(200)
  async ingestOps(
    @Param('scheduleId') scheduleId: string,
    @Body() body: { ops: any[] },
    @Req() req: Request,
  ) {
    const ops = body?.ops;
    const rawSize = Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8');
    const limitCheck = this.ingestor.validateBatchLimits(ops, rawSize);

    if (!limitCheck.ok) {
      throw new BadRequestException({
        code: 'OPS_BATCH_REJECTED',
        reason: limitCheck.reason,
      });
    }

    const correlationHeader = req.headers['x-correlation-id'];
    const correlationId = Array.isArray(correlationHeader)
      ? (correlationHeader[0] || `http-${Date.now()}`)
      : (correlationHeader || `http-${Date.now()}`);

    return this.ingestor.processOps(scheduleId, ops, correlationId);
  }
}
