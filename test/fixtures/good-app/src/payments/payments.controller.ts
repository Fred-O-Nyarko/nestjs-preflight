import { Controller, Post, Body } from '@nestjs/common';
import { Idempotent } from '@nestjs/idempotency';
import { ChargeDto } from "./charge.dto";

@Controller('payments')
export class PaymentsController {
  @Post('charge')
  @Idempotent({ required: true })
  async charge(@Body() body: ChargeDto) {
    return { ok: true };
  }
}
