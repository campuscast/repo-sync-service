import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SchemaValidatorService {
  private readonly logger = new Logger(SchemaValidatorService.name);

  validateOp(op: any): boolean {
    if (!op.op_type || !op.causal?.operation_id || !op.slot) {
      this.logger.warn(`Invalid op schema: missing required fields`);
      return false;
    }
    const validTypes = ['add_slot', 'remove_slot', 'update_slot', 'move_slot'];
    if (!validTypes.includes(op.op_type)) {
      this.logger.warn(`Invalid op_type: ${op.op_type}`);
      return false;
    }
    return true;
  }
}
