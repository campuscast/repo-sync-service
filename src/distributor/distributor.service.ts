import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class DistributorService {
  private readonly logger = new Logger(DistributorService.name);

  async distributeToEditors(scheduleId: string, ops: any[]): Promise<number> {
    this.logger.log(`Distributing ${ops.length} ops for schedule=${scheduleId} to WS clients`);
    return 0;
  }
}
