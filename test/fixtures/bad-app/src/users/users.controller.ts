import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ListUsersQuery } from './list-users.query.dto';

@Controller('users')
export class UsersController {
  @UseGuards(JwtAuthGuard)
  @Get()
  list(@Query() q: ListUsersQuery) {
    return [];
  }
}
