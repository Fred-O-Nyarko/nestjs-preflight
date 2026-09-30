import { Controller, Post, Body } from '@nestjs/common';

@Controller('payments')
export class PaymentsController {
  @Post('charge')
  async charge(@Body() body: any) {
    return { ok: true };
  }
}
