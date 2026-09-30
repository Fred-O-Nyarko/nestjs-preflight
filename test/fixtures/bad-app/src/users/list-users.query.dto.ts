import { IsInt, Min } from 'class-validator';
export class ListUsersQuery {
  @IsInt()
  @Min(1)
  limit: number;
}
